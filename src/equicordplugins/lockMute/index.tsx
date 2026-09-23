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
import { Constants, GuildStore, Menu, PermissionsBits, PermissionStore, RestAPI, VoiceStateStore } from "@webpack/common";

const DATA_KEY = "LockMute_locked";
const logger = new Logger("LockMute");

let locked = new Set<string>();
const pending = new Set<string>();

function setMute(guildId: string, userId: string, mute: boolean) {
    const key = `${guildId}:${userId}`;
    if (pending.has(key)) return;

    pending.add(key);
    RestAPI.patch({ url: Constants.Endpoints.GUILD_MEMBER(guildId, userId), body: { mute } })
        .catch(e => logger.error("Failed to update server mute", e))
        .finally(() => pending.delete(key));
}

function toggleLock(guildId: string, userId: string) {
    const key = `${guildId}:${userId}`;
    const isLocked = !locked.delete(key);
    if (isLocked) locked.add(key);
    DataStore.set(DATA_KEY, locked);

    const state = VoiceStateStore.getVoiceState(guildId, userId);
    if (state && state.mute !== isLocked) setMute(guildId, userId, isLocked);
}

const userContextPatch: NavContextMenuPatchCallback = (children, { user, guildId }: { user?: User; guildId?: string; }) => {
    if (!user || !guildId || !PermissionStore.can(PermissionsBits.MUTE_MEMBERS, GuildStore.getGuild(guildId))) return;

    const isLocked = locked.has(`${guildId}:${user.id}`);
    children.push(
        <Menu.MenuItem
            id="vc-lock-mute"
            label={isLocked ? "Unlock Server Mute" : "Lock Server Mute"}
            color={isLocked ? "danger" : undefined}
            action={() => toggleLock(guildId, user.id)}
        />
    );
};

export default definePlugin({
    name: "LockMute",
    description: "Server mutes a user and mutes them again every time someone unmutes them.",
    authors: [EquicordDevs.Fowlmas],

    contextMenus: {
        "user-context": userContextPatch
    },

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[]; }) {
            for (const { guildId, userId, channelId, mute } of voiceStates) {
                if (guildId && channelId && !mute && locked.has(`${guildId}:${userId}`)) setMute(guildId, userId, true);
            }
        }
    },

    async start() {
        locked = await DataStore.get<Set<string>>(DATA_KEY) ?? new Set();
    }
});
