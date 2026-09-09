/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Notice } from "@components/Notice";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { Channel, User, VoiceState } from "@vencord/discord-types";
import { findByPropsLazy } from "@webpack";
import { Menu, React, RelationshipStore, Toasts, UserStore, VoiceStateStore } from "@webpack/common";

type TFollowedUserInfo = {
    lastChannelId: string;
    userId: string;
} | null;

interface UserContextProps {
    channel: Channel;
    user: User;
    guildId?: string;
}

let followedUserInfo: TFollowedUserInfo = null;

const voiceChannelAction = findByPropsLazy("selectVoiceChannel");

function FollowVoiceUserIcon({ filled = false }: { filled?: boolean; }) {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill={filled ? "var(--status-positive)" : "currentColor"}>
            <path d="M12 3a9 9 0 0 0-9 9v6.5A2.5 2.5 0 0 0 5.5 21H7a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2H5v-1a7 7 0 0 1 14 0v1h-2a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h1.5a2.5 2.5 0 0 0 2.5-2.5V12a9 9 0 0 0-9-9Z" />
        </svg>
    );
}

const settings = definePluginSettings({
    onlyWhenInVoice: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Only follow the user when you are in a voice channel"
    },
    leaveWhenUserLeaves: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Leave the voice channel when the user leaves. (That can cause you to sometimes enter infinite leave/join loop)"
    }
});

const UserContextMenuPatch: NavContextMenuPatchCallback = (children, { channel, user }: UserContextProps) => {
    if (UserStore.getCurrentUser().id === user.id || !RelationshipStore.getFriendIDs().includes(user.id)) return;

    const [checked, setChecked] = React.useState(followedUserInfo?.userId === user.id);
    const followIcon = () => <FollowVoiceUserIcon filled={checked} />;

    children.push(
        <Menu.MenuSeparator />,
        <Menu.MenuItem
            id="fvu-follow-user"
            label={checked ? "Stop Following User" : "Follow User"}
            color={checked ? "danger" : undefined}
            icon={followIcon}
            leadingAccessory={{ type: "icon", icon: followIcon }}
            action={() => {
                if (followedUserInfo?.userId === user.id) {
                    followedUserInfo = null;
                    setChecked(false);
                    Toasts.show({ message: `Stopped following ${user.globalName ?? user.username}`, type: Toasts.Type.MESSAGE, id: Toasts.genId() });
                    return;
                }

                followedUserInfo = {
                    lastChannelId: UserStore.getCurrentUser().id,
                    userId: user.id
                };
                setChecked(true);
                Toasts.show({ message: `Following ${user.globalName ?? user.username} 🏃‍♂️`, type: Toasts.Type.SUCCESS, id: Toasts.genId() });
            }}
        ></Menu.MenuItem>
    );
};

export default definePlugin({
    name: "FollowVoiceUser",
    description: "Follow a friend in voice chat.",
    tags: ["Voice"],
    authors: [EquicordDevs.TheArmagan],
    settings,
    settingsAboutComponent: () => (
        <Notice.Info>
            This Plugin is used to follow a Friend/Friends into voice chat(s).
        </Notice.Info>
    ),
    flux: {
        async VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[]; }) {
            if (!followedUserInfo) return;
            if (!RelationshipStore.getFriendIDs().includes(followedUserInfo.userId)) return;

            if (
                settings.store.onlyWhenInVoice
                && !VoiceStateStore.getVoiceStateForUser(UserStore.getCurrentUser().id)
            ) return;

            voiceStates.forEach(voiceState => {
                if (
                    voiceState.userId === followedUserInfo!.userId
                    && voiceState.channelId
                    && voiceState.channelId !== followedUserInfo!.lastChannelId
                ) {
                    followedUserInfo!.lastChannelId = voiceState.channelId;
                    voiceChannelAction.selectVoiceChannel(followedUserInfo!.lastChannelId);
                } else if (
                    voiceState.userId === followedUserInfo!.userId
                    && !voiceState.channelId
                    && settings.store.leaveWhenUserLeaves
                ) {
                    voiceChannelAction.selectVoiceChannel(null);
                }
            });
        }
    },
    contextMenus: {
        "user-context": UserContextMenuPatch
    }
});
