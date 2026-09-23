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

const DATA_KEY = "LockDisconnect_locked";
const logger = new Logger("LockDisconnect");

let locked = new Set<string>();
const pending = new Set<string>();

function disconnect(guildId: string, userId: string) {
    const key = `${guildId}:${userId}`;
    if (pending.has(key)) return;

    pending.add(key);
    RestAPI.patch({ url: Constants.Endpoints.GUILD_MEMBER(guildId, userId), body: { channel_id: null } })
        .catch(e => logger.error("Failed to disconnect user", e))
        .finally(() => pending.delete(key));
}

function toggleLock(guildId: string, userId: string) {
    const key = `${guildId}:${userId}`;
    if (locked.delete(key)) {
        DataStore.set(DATA_KEY, locked);
        return;
    }

    locked.add(key);
    DataStore.set(DATA_KEY, locked);
    if (VoiceStateStore.getVoiceState(guildId, userId)) disconnect(guildId, userId);
}

const userContextPatch: NavContextMenuPatchCallback = (children, { user, guildId }: { user?: User; guildId?: string; }) => {
    if (!user || !guildId || !PermissionStore.can(PermissionsBits.MOVE_MEMBERS, GuildStore.getGuild(guildId))) return;

    const isLocked = locked.has(`${guildId}:${user.id}`);
    children.push(
        <Menu.MenuItem
            id="vc-lock-disconnect"
            label={isLocked ? "Stop Auto Disconnect" : "Auto Disconnect"}
            color={isLocked ? "danger" : undefined}
            action={() => toggleLock(guildId, user.id)}
        />
    );
};

export default definePlugin({
    name: "LockDisconnect",
    description: "Disconnects a user from voice every time they join a voice channel.",
    authors: [EquicordDevs.Fowlmas],

    contextMenus: {
        "user-context": userContextPatch
    },

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[]; }) {
            for (const { guildId, userId, channelId } of voiceStates) {
                if (guildId && channelId && locked.has(`${guildId}:${userId}`)) disconnect(guildId, userId);
            }
        }
    },

    async start() {
        locked = await DataStore.get<Set<string>>(DATA_KEY) ?? new Set();
    }
});
