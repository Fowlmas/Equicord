/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { UserAreaButton } from "@api/UserArea";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import type { VoiceState } from "@vencord/discord-types";
import { findByPropsLazy } from "@webpack";
import { AuthenticationStore, ChannelStore, Constants, PermissionsBits, PermissionStore, React, RestAPI, SelectedChannelStore, UserStore, useStateFromStores, VoiceStateStore } from "@webpack/common";

const VoiceChannelActions = findByPropsLazy("selectVoiceChannel");
const logger = new Logger("AntiMoveDeco");

let targetChannelId: string | null = null;
let reconnectTimeout: ReturnType<typeof setTimeout> | undefined;
const pendingRestores = new Set<string>();

function setTarget(channelId: string | null) {
    targetChannelId = channelId;
    clearTimeout(reconnectTimeout);
}

function reconnect() {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(() => {
        if (!targetChannelId || SelectedChannelStore.getVoiceChannelId() === targetChannelId) return;

        try {
            VoiceChannelActions.selectVoiceChannel(targetChannelId);
        } catch (e) {
            logger.error("Failed to reconnect", e);
        }
    }, 500);
}

function restoreVoice(guildId: string, fields: ("mute" | "deaf")[]) {
    const toSend = fields.filter(field => !pendingRestores.has(guildId + field));
    if (!toSend.length) return;

    toSend.forEach(field => pendingRestores.add(guildId + field));
    RestAPI.patch({
        url: Constants.Endpoints.GUILD_MEMBER(guildId, UserStore.getCurrentUser().id),
        body: Object.fromEntries(toSend.map(field => [field, false]))
    })
        .catch(e => logger.error("Failed to remove server mute or deafen", e))
        .finally(() => toSend.forEach(field => pendingRestores.delete(guildId + field)));
}

function checkServerMute({ channelId, mute, deaf }: Pick<VoiceState, "channelId" | "mute" | "deaf">) {
    if (!channelId || !mute && !deaf) return;

    const channel = ChannelStore.getChannel(channelId);
    if (!channel?.guild_id) return;

    const fields: ("mute" | "deaf")[] = [];
    if (mute && PermissionStore.can(PermissionsBits.MUTE_MEMBERS, channel)) fields.push("mute");
    if (deaf && PermissionStore.can(PermissionsBits.DEAFEN_MEMBERS, channel)) fields.push("deaf");
    restoreVoice(channel.guild_id, fields);
}

function getMyVoiceState() {
    return VoiceStateStore.getVoiceStateForSession(UserStore.getCurrentUser().id, AuthenticationStore.getSessionId());
}

function AntiMoveDecoIcon({ enabled }: { enabled: boolean; }) {
    const color = enabled ? "#39FF14" : "currentColor";
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="12" r="10" stroke={color} strokeWidth="2.5" />
            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" stroke={color} strokeWidth="2.5" />
        </svg>
    );
}

function AntiMoveDecoButton() {
    const [, forceUpdate] = React.useReducer(x => x + 1, 0);
    const voiceChannelId = useStateFromStores([SelectedChannelStore], () => SelectedChannelStore.getVoiceChannelId());

    if (!voiceChannelId && !targetChannelId) return null;

    const enabled = !!targetChannelId;

    return (
        <UserAreaButton
            onClick={() => {
                setTarget(enabled ? null : voiceChannelId ?? null);
                forceUpdate();

                const state = !enabled && getMyVoiceState();
                if (state) checkServerMute(state);
            }}
            tooltipText={enabled ? "Disable AntiMove, Deco & Mute" : "Enable AntiMove, Deco & Mute"}
            icon={<AntiMoveDecoIcon enabled={enabled} />}
        />
    );
}

export default definePlugin({
    name: "AntiMoveDeco",
    description: "Adds a button to prevent being moved, disconnected, server muted or server deafened in a voice channel.",
    authors: [EquicordDevs.Fowlmas],
    dependencies: ["UserAreaAPI"],

    userAreaButton: {
        icon: () => <AntiMoveDecoIcon enabled={!!targetChannelId} />,
        render: AntiMoveDecoButton
    },

    flux: {
        VOICE_CHANNEL_SELECT({ channelId }: { channelId: string | null; }) {
            if (!targetChannelId || channelId === targetChannelId) return;

            if (channelId) return setTarget(channelId);

            if (getMyVoiceState()?.channelId) setTarget(null);
        },

        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[]; }) {
            if (!targetChannelId) return;

            const myId = UserStore.getCurrentUser()?.id;
            const sessionId = AuthenticationStore.getSessionId();
            const myState = voiceStates.find(s => s.userId === myId && s.sessionId === sessionId);

            if (!myState) return;
            if (myState.channelId !== targetChannelId) reconnect();
            else checkServerMute(myState);
        }
    },

    stop() {
        setTarget(null);
    }
});
