/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { UserAreaButton } from "@api/UserArea";
import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { FluxDispatcher, React, SelectedChannelStore, UserStore, useStateFromStores } from "@webpack/common";

const VoiceChannelActions = findByPropsLazy("selectVoiceChannel");

let enabled = false;
let targetChannelId: string | null = null;

function onVoiceStateUpdate({ voiceStates }: { voiceStates: any[]; }) {
    if (!enabled || !targetChannelId) return;

    const myId = UserStore.getCurrentUser()?.id;
    if (!myId) return;

    const myState = voiceStates.find(s => s.userId === myId);
    if (!myState) return;

    if (myState.channelId !== targetChannelId) {
        setTimeout(() => {
            if (enabled && targetChannelId) {
                try {
                    VoiceChannelActions?.selectVoiceChannel?.(targetChannelId);
                } catch (e) {
                    console.error("[AntiMoveDeco] Failed to reconnect:", e);
                }
            }
        }, 500);
    }
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
    const inVoice = useStateFromStores([SelectedChannelStore], () => !!SelectedChannelStore.getVoiceChannelId());

    if (!inVoice) {
        if (enabled) {
            enabled = false;
            targetChannelId = null;
        }
        return null;
    }

    const toggle = () => {
        if (!enabled) {
            const channelId = SelectedChannelStore.getVoiceChannelId();
            if (!channelId) return;
            targetChannelId = channelId;
            enabled = true;
        } else {
            enabled = false;
            targetChannelId = null;
        }
        forceUpdate();
    };

    return (
        <UserAreaButton
            onClick={toggle}
            tooltipText={enabled ? "Disable AntiMove & Deco" : "Enable AntiMove & Deco"}
            icon={<AntiMoveDecoIcon enabled={enabled} />}
        />
    );
}

export default definePlugin({
    name: "AntiMoveDeco",
    description: "Adds a button to prevent being moved or disconnected from a voice channel.",
    authors: [EquicordDevs.Fowlmas],
    dependencies: ["UserAreaAPI"],

    userAreaButton: {
        icon: () => <AntiMoveDecoIcon enabled={enabled} />,
        render: AntiMoveDecoButton
    },

    start() {
        FluxDispatcher.subscribe("VOICE_STATE_UPDATES", onVoiceStateUpdate);
    },
    stop() {
        FluxDispatcher.unsubscribe("VOICE_STATE_UPDATES", onVoiceStateUpdate);
        enabled = false;
        targetChannelId = null;
    }
});
