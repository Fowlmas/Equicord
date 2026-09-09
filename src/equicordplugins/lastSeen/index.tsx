/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { definePluginSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import ErrorBoundary from "@components/ErrorBoundary";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy, findComponentByCodeLazy } from "@webpack";
import { FluxDispatcher, Parser, React, useStateFromStores } from "@webpack/common";

const Section = findComponentByCodeLazy("headingVariant:", '"section"', "headingIcon:");
const PresenceStore = findByPropsLazy("getStatus", "getActivities");

const settings = definePluginSettings({
    language: {
        type: OptionType.SELECT,
        description: "Display language for the last seen text",
        options: [
            { label: "English", value: "en", default: true },
            { label: "Français", value: "fr" }
        ]
    },
    debug: {
        type: OptionType.BOOLEAN,
        description: "Log the event that last updated the timestamp",
        default: false
    }
});

const STORAGE_PREFIX = "equicord_lastseen_";

type Source = { label: string; channelId?: string; };

const lastSeenCache = new Map<string, number>();
const lastSourceCache = new Map<string, Source>();
const subscribers = new Map<string, Set<() => void>>();

function subscribe(userId: string, cb: () => void) {
    let set = subscribers.get(userId);
    if (!set) subscribers.set(userId, set = new Set());
    set.add(cb);
    return () => { set!.delete(cb); };
}

function setLastSeen(userId: string, ts: number, label: string, channelId?: string) {
    lastSeenCache.set(userId, ts);
    lastSourceCache.set(userId, { label, channelId });
    DataStore.set(STORAGE_PREFIX + userId, { ts, label, channelId }).catch(() => { });
    if (settings.store.debug) console.log(`[LastSeen] ${userId} ← ${label}${channelId ? ` (#${channelId})` : ""}`);
    subscribers.get(userId)?.forEach(cb => cb());
}

const statusCache = new Map<string, string>();

function handlePresenceEntry(entry: any, source: string) {
    if (!entry) return;

    const userId: string | undefined =
        entry?.user?.id ??
        entry?.userId ??
        entry?.user_id;

    if (!userId) return;

    const status = entry?.status;
    if (!status) return;

    const prev = statusCache.get(userId);
    statusCache.set(userId, status);

    if (status === "offline" || status === "invisible") return;
    if (prev === undefined || prev === status) return;

    setLastSeen(userId, Date.now(), `${source}:${prev}→${status}`);
}

function onPresenceUpdate(data: any) {
    if (Array.isArray(data?.updates)) {
        for (const entry of data.updates) handlePresenceEntry(entry, "PRESENCE_UPDATE");
    } else {
        handlePresenceEntry(data, "PRESENCE_UPDATE");
    }
}

function onPresenceUpdates(data: any) {
    if (Array.isArray(data?.updates)) {
        for (const entry of data.updates) handlePresenceEntry(entry, "PRESENCE_UPDATES");
    } else if (Array.isArray(data)) {
        for (const entry of data) handlePresenceEntry(entry, "PRESENCE_UPDATES");
    } else {
        handlePresenceEntry(data, "PRESENCE_UPDATES");
    }
}

function onMessageCreate(data: any) {
    const userId: string | undefined =
        data?.message?.author?.id ??
        data?.message?.author_id ??
        data?.author?.id;
    if (!userId) return;

    const channelId = data?.channelId ?? data?.message?.channel_id;
    setLastSeen(userId, Date.now(), "MESSAGE_CREATE", channelId);
}

function onVoiceStateUpdates(data: any) {
    for (const state of data?.voiceStates ?? []) {
        const userId: string | undefined = state?.userId ?? state?.user_id;
        if (userId) setLastSeen(userId, Date.now(), "VOICE_STATE_UPDATES");
    }
}

function onTypingStart(data: any) {
    const userId: string | undefined = data?.userId ?? data?.user_id;
    if (userId) setLastSeen(userId, Date.now(), "TYPING_START");
}

function onReactionAdd(data: any) {
    const userId: string | undefined = data?.userId ?? data?.user_id;
    if (userId) setLastSeen(userId, Date.now(), "MESSAGE_REACTION_ADD");
}

function LastSeenText({ userId }: { userId: string; }) {
    const status = useStateFromStores([PresenceStore], () => PresenceStore.getStatus(userId));
    const [lastSeen, setLastSeenState] = React.useState<number | null>(() => lastSeenCache.get(userId) ?? null);

    React.useEffect(() => {
        if (!lastSeenCache.has(userId)) {
            DataStore.get(STORAGE_PREFIX + userId).then((val: any) => {
                if (val == null) return;
                const ts = typeof val === "number" ? val : val.ts;
                lastSeenCache.set(userId, ts);
                if (typeof val === "object") lastSourceCache.set(userId, { label: val.label, channelId: val.channelId });
                setLastSeenState(ts);
            }).catch(() => { });
        } else {
            setLastSeenState(lastSeenCache.get(userId)!);
        }
        return subscribe(userId, () => setLastSeenState(lastSeenCache.get(userId) ?? null));
    }, [userId]);

    const fr = settings.store.language === "fr";
    const isOnline = status && status !== "offline" && status !== "invisible";

    let statusLabel: string | null = null;
    if (isOnline) {
        if (status === "idle") statusLabel = fr ? "Inactif" : "Idle";
        else if (status === "dnd") statusLabel = fr ? "Ne pas déranger" : "Do Not Disturb";
        else if (status === "streaming") statusLabel = fr ? "En direct" : "Streaming";
        else statusLabel = fr ? "En ligne" : "Online";
    }

    const timestamp = lastSeen ? Parser.parse(`<t:${Math.floor(lastSeen / 1000)}:R>`) : null;
    const source = lastSourceCache.get(userId);
    const channelId = source?.channelId;

    return (
        <BaseText size="sm" color="text-default" style={{ userSelect: "text" }}>
            {statusLabel}
            {statusLabel && timestamp && " · "}
            {timestamp ?? (!statusLabel && (fr ? "Pas encore tracé" : "Not tracked yet"))}
            {channelId && <> {fr ? "dans" : "in"} {Parser.parse(`<#${channelId}>`)}</>}
            {settings.store.debug && source && ` [${source.label}]`}
        </BaseText>
    );
}

const LastSeenSection = ErrorBoundary.wrap(
    ({ userId }: { userId: string; }) => <LastSeenText userId={userId} />,
    { noop: true }
);

export default definePlugin({
    name: "LastSeen",
    description: "Shows the last time a user was seen online, in their profile.",
    authors: [EquicordDevs.Fowlmas],
    settings,

    patches: [
        {
            find: "#{intl::PROVISIONAL_ACCOUNT}),headingIcon:",
            replacement: {
                match: /(#{intl::USER_PROFILE_MEMBER_SINCE}\),.{0,100}userId:(\i\.id)}\)}\))/,
                replace: "$1,$self.renderLastSeen({userId:$2,isSideBar:true})",
            }
        },
        {
            find: ",applicationRoleConnection:",
            replacement: {
                match: /(#{intl::USER_PROFILE_MEMBER_SINCE}\),.{0,100}userId:(\i\.id),.{0,100}}\)}\)),/,
                replace: "$1,$self.renderLastSeen({userId:$2,isSideBar:false}),",
            }
        },
        {
            find: ".MODAL_V2,onClose:",
            replacement: {
                match: /(#{intl::USER_PROFILE_MEMBER_SINCE}\),.{0,100}userId:(\i\.id),.{0,100}}\)}\)),/,
                replace: "$1,$self.renderLastSeen({userId:$2,isSideBar:false}),",
            }
        }
    ],

    start() {
        FluxDispatcher.subscribe("PRESENCE_UPDATE", onPresenceUpdate);
        FluxDispatcher.subscribe("PRESENCE_UPDATES", onPresenceUpdates);
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
        FluxDispatcher.subscribe("VOICE_STATE_UPDATES", onVoiceStateUpdates);
        FluxDispatcher.subscribe("TYPING_START", onTypingStart);
        FluxDispatcher.subscribe("MESSAGE_REACTION_ADD", onReactionAdd);
    },

    stop() {
        FluxDispatcher.unsubscribe("PRESENCE_UPDATE", onPresenceUpdate);
        FluxDispatcher.unsubscribe("PRESENCE_UPDATES", onPresenceUpdates);
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
        FluxDispatcher.unsubscribe("VOICE_STATE_UPDATES", onVoiceStateUpdates);
        FluxDispatcher.unsubscribe("TYPING_START", onTypingStart);
        FluxDispatcher.unsubscribe("MESSAGE_REACTION_ADD", onReactionAdd);
    },

    renderLastSeen({ userId, isSideBar }: { userId: string; isSideBar: boolean; }) {
        if (!userId) return null;
        return (
            <Section
                heading={settings.store.language === "fr" ? "Vu pour la dernière fois" : "Last Seen"}
                headingVariant={isSideBar ? "text-xs/semibold" : "text-xs/medium"}
                headingColor={isSideBar ? "text-strong" : "text-default"}
            >
                <LastSeenSection userId={userId} />
            </Section>
        );
    },
});
