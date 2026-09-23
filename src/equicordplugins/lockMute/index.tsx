/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import type { User, VoiceState } from "@vencord/discord-types";
import { Constants, GuildStore, Menu, PermissionsBits, PermissionStore, RestAPI, SelectedGuildStore, VoiceStateStore } from "@webpack/common";

const DATA_KEY = "LockMute_users";
const logger = new Logger("LockMute");

let locked = new Map<string, string>();
const pending = new Set<string>();

function MuteIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0Z" />
            <path d="M5 11a7 7 0 0 0 6 6.93V21h2v-3.07A7 7 0 0 0 19 11h-2a5 5 0 0 1-10 0Z" />
            <path d="m3.3 2.3 18.4 18.4-1.4 1.4L1.9 3.7Z" />
        </svg>
    );
}

function setMute(guildId: string, userId: string, mute: boolean) {
    if (pending.has(userId)) return;

    pending.add(userId);
    RestAPI.patch({ url: Constants.Endpoints.GUILD_MEMBER(guildId, userId), body: { mute } })
        .catch(e => logger.error("Failed to update server mute", e))
        .finally(() => pending.delete(userId));
}

function toggleLock(guildId: string, userId: string) {
    const isLocked = !locked.delete(userId);
    if (isLocked) locked.set(userId, guildId);
    DataStore.set(DATA_KEY, locked);

    const state = VoiceStateStore.getVoiceState(guildId, userId);
    if (state && state.mute !== isLocked) setMute(guildId, userId, isLocked);
}

const userContextPatch: NavContextMenuPatchCallback = (children, props: { user?: User; guildId?: string; }) => {
    if (!props.user) return;

    const userId = props.user.id;
    const lockedGuildId = locked.get(userId);
    const guildId = lockedGuildId ?? props.guildId ?? SelectedGuildStore.getGuildId();
    if (!guildId || !lockedGuildId && !PermissionStore.can(PermissionsBits.MUTE_MEMBERS, GuildStore.getGuild(guildId))) return;

    children.push(
        <Menu.MenuItem
            id="vc-lock-mute"
            label={lockedGuildId ? "Unlock Server Mute" : "Lock Server Mute"}
            color={lockedGuildId ? "danger" : undefined}
            icon={MuteIcon}
            leadingAccessory={{ type: "icon", icon: MuteIcon }}
            action={() => toggleLock(guildId, userId)}
        />
    );
};

export default definePlugin({
    name: "LockMute",
    description: "Server mutes a user and mutes them again every time someone unmutes them.",
    authors: [EquicordDevs.Fowlmas],

    contextMenus: {
        "user-context": userContextPatch,
        "user-profile-actions": userContextPatch
    },

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[]; }) {
            for (const { guildId, userId, channelId, mute } of voiceStates) {
                if (channelId && !mute && guildId && locked.get(userId) === guildId) setMute(guildId, userId, true);
            }
        }
    },

    async start() {
        locked = await DataStore.get<Map<string, string>>(DATA_KEY) ?? new Map();
    }
});
