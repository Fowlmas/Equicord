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

const DATA_KEY = "LockDisconnect_users";
const logger = new Logger("LockDisconnect");

let locked = new Map<string, string>();
const pending = new Set<string>();

function DisconnectIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.96.96 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71s-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.3 11.3 0 0 0-2.67-1.85 1 1 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9Z" />
        </svg>
    );
}

function disconnect(guildId: string, userId: string) {
    if (pending.has(userId)) return;

    pending.add(userId);
    RestAPI.patch({ url: Constants.Endpoints.GUILD_MEMBER(guildId, userId), body: { channel_id: null } })
        .catch(e => logger.error("Failed to disconnect user", e))
        .finally(() => pending.delete(userId));
}

function toggleLock(guildId: string, userId: string) {
    const isLocked = !locked.delete(userId);
    if (isLocked) locked.set(userId, guildId);
    DataStore.set(DATA_KEY, locked);

    if (isLocked && VoiceStateStore.getVoiceState(guildId, userId)) disconnect(guildId, userId);
}

const userContextPatch: NavContextMenuPatchCallback = (children, props: { user?: User; guildId?: string; }) => {
    if (!props.user) return;

    const userId = props.user.id;
    const lockedGuildId = locked.get(userId);
    const guildId = lockedGuildId ?? props.guildId ?? SelectedGuildStore.getGuildId();
    if (!guildId || !lockedGuildId && !PermissionStore.can(PermissionsBits.MOVE_MEMBERS, GuildStore.getGuild(guildId))) return;

    children.push(
        <Menu.MenuItem
            id="vc-lock-disconnect"
            label={lockedGuildId ? "Stop Auto Disconnect" : "Auto Disconnect"}
            color={lockedGuildId ? "danger" : undefined}
            icon={DisconnectIcon}
            leadingAccessory={{ type: "icon", icon: DisconnectIcon }}
            action={() => toggleLock(guildId, userId)}
        />
    );
};

export default definePlugin({
    name: "LockDisconnect",
    description: "Disconnects a user from voice every time they join a voice channel.",
    authors: [EquicordDevs.Fowlmas],

    contextMenus: {
        "user-context": userContextPatch,
        "user-profile-actions": userContextPatch
    },

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[]; }) {
            for (const { guildId, userId, channelId } of voiceStates) {
                if (channelId && guildId && locked.get(userId) === guildId) disconnect(guildId, userId);
            }
        }
    },

    async start() {
        locked = await DataStore.get<Map<string, string>>(DATA_KEY) ?? new Map();
    }
});
