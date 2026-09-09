/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { Channel, Message } from "@vencord/discord-types";
import { ChannelStore, Menu, PermissionsBits, PermissionStore, RestAPI, UserStore } from "@webpack/common";

const settings = definePluginSettings({
    enabled: {
        type: OptionType.BOOLEAN,
        description: "Enable the MessageCleaner plugin",
        default: true
    },
    delayBetweenDeletes: {
        type: OptionType.SLIDER,
        description: "Delay between each deletion (ms) — to avoid rate limiting",
        default: 1000,
        markers: [100, 500, 1000, 2000, 5000],
        minValue: 100,
        maxValue: 10000,
        stickToMarkers: false
    },
    batchSize: {
        type: OptionType.SLIDER,
        description: "Number of messages to process per batch",
        default: 50,
        markers: [10, 25, 50, 100],
        minValue: 1,
        maxValue: 100,
        stickToMarkers: false
    },
    debugMode: {
        type: OptionType.BOOLEAN,
        description: "Debug mode (detailed logs)",
        default: false
    },
    skipSystemMessages: {
        type: OptionType.BOOLEAN,
        description: "Ignore system messages (join/leave, etc.)",
        default: true
    },
    skipReplies: {
        type: OptionType.BOOLEAN,
        description: "Ignore message replies",
        default: false
    },
    maxAge: {
        type: OptionType.SLIDER,
        description: "Maximum message age to delete (days, 0 = no limit)",
        default: 0,
        markers: [0, 1, 7, 30, 90],
        minValue: 0,
        maxValue: 365,
        stickToMarkers: false
    }
});

let isCleaningInProgress = false;
let shouldStopCleaning = false;
let cleaningMode: "own" | "mentions" = "own";
let cleaningStats = { total: 0, deleted: 0, failed: 0, skipped: 0, startTime: 0, totalKnown: false };
let lastErrorStatus: string | number = "";

function log(message: string, level: "info" | "warn" | "error" = "info") {
    const prefix = `[MessageCleaner ${new Date().toLocaleTimeString()}]`;
    switch (level) {
        case "warn": console.warn(prefix, message); break;
        case "error": console.error(prefix, message); break;
        default: console.log(prefix, message);
    }
}

function debugLog(message: string) {
    if (settings.store.debugMode) log(`🔍 ${message}`, "info");
}

function canDeleteMessage(message: Message, currentUserId: string): boolean {
    try {
        if (message.author?.id !== currentUserId) return false;
        if (settings.store.skipSystemMessages && message.type !== 0 && message.type !== 19) return false;

        const isReply = message.type === 19 || !!message.messageReference || !!(message as any).message_reference;
        if (isReply && settings.store.skipReplies) return false;

        if (settings.store.maxAge > 0) {
            let messageTime: number;
            if (typeof message.timestamp === "string") messageTime = new Date(message.timestamp).getTime();
            else if (typeof message.timestamp === "number") messageTime = message.timestamp;
            else return false;

            if (isNaN(messageTime) || messageTime <= 0) return false;
            const messageAge = Date.now() - messageTime;
            const maxAgeMs = settings.store.maxAge * 24 * 60 * 60 * 1000;
            if (messageAge > maxAgeMs) return false;
        }

        return true;
    } catch {
        return false;
    }
}

function canDeleteMentionMessage(message: Message, currentUserId: string): boolean {
    try {
        if (message.author?.id === currentUserId) return false;
        if (settings.store.skipSystemMessages && message.type !== 0 && message.type !== 19) return false;
        if (!(message.mentions as any)?.some?.((u: any) => u.id === currentUserId)) return false;

        if (settings.store.maxAge > 0) {
            let messageTime: number;
            if (typeof message.timestamp === "string") messageTime = new Date(message.timestamp).getTime();
            else if (typeof message.timestamp === "number") messageTime = message.timestamp;
            else return false;

            if (isNaN(messageTime) || messageTime <= 0) return false;
            const messageAge = Date.now() - messageTime;
            const maxAgeMs = settings.store.maxAge * 24 * 60 * 60 * 1000;
            if (messageAge > maxAgeMs) return false;
        }

        return true;
    } catch {
        return false;
    }
}

const REQUEST_TIMEOUT_MS = 15000;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error("Timeout"), { status: "timeout" })), ms);
        promise.then(
            value => { clearTimeout(timer); resolve(value); },
            error => { clearTimeout(timer); reject(error); }
        );
    });
}

async function deleteMessage(channelId: string, messageId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 10; attempt++) {
        try {
            await withTimeout(RestAPI.del({ url: `/channels/${channelId}/messages/${messageId}` }), REQUEST_TIMEOUT_MS);
            return true;
        } catch (error: any) {
            const statusCode = error?.status || error?.statusCode || "N/A";

            if (statusCode === 429) {
                const retryAfter = error?.body?.retry_after ?? error?.retryAfter ?? 1;
                const waitMs = Math.max(1000, Math.ceil(retryAfter * 1000) + 250);
                debugLog(`⏳ Rate limited, retrying in ${waitMs}ms`);
                await sleep(waitMs);
                continue;
            }

            if (statusCode === "timeout") {
                debugLog("⏳ Timeout (channel switch?), retrying");
                await sleep(1000);
                continue;
            }

            if (statusCode === 404) return true;

            lastErrorStatus = statusCode;
            log(`❌ Error deleting ${messageId}: status ${statusCode}`, "error");
            return false;
        }
    }

    lastErrorStatus = "timeout";
    return false;
}

async function searchOwnMessages(channel: Channel, userId: string, offset: number): Promise<{ ok: boolean; messages: Message[]; total: number; }> {
    const guildId = (channel as any).guild_id;
    const base = guildId
        ? `/guilds/${guildId}/messages/search?author_id=${userId}&channel_id=${channel.id}`
        : `/channels/${channel.id}/messages/search?author_id=${userId}`;
    const url = offset > 0 ? `${base}&offset=${offset}` : base;

    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            const response = await withTimeout(RestAPI.get({ url }), REQUEST_TIMEOUT_MS);
            const body = response?.body;

            if (response?.status === 202 || (body?.retry_after && !body?.messages)) {
                const retryAfter = body?.retry_after ?? 1;
                await sleep(Math.max(1000, Math.ceil(retryAfter * 1000) + 250));
                continue;
            }

            if (!body || !Array.isArray(body.messages)) return { ok: false, messages: [], total: 0 };

            const messages = body.messages
                .map((group: Message[]) => Array.isArray(group) ? (group.find((m: any) => m.hit) ?? group[0]) : group)
                .filter(Boolean) as Message[];
            return { ok: true, messages, total: body.total_results ?? 0 };
        } catch (error: any) {
            const statusCode = error?.status || error?.statusCode || "N/A";
            if (statusCode === 429) {
                const retryAfter = error?.body?.retry_after ?? 1;
                await sleep(Math.max(1000, Math.ceil(retryAfter * 1000) + 250));
                continue;
            }

            if (statusCode === "timeout") {
                debugLog("⏳ Search interrupted (channel switch?), retrying");
                await sleep(1000);
                continue;
            }

            debugLog(`⚠️ Search failed: status ${statusCode}`);
            return { ok: false, messages: [], total: 0 };
        }
    }
    return { ok: false, messages: [], total: 0 };
}

async function getChannelMessages(channelId: string, before?: string): Promise<Message[]> {
    try {
        const url = before
            ? `/channels/${channelId}/messages?limit=${settings.store.batchSize}&before=${before}`
            : `/channels/${channelId}/messages?limit=${settings.store.batchSize}`;
        const response = await withTimeout(RestAPI.get({ url }), REQUEST_TIMEOUT_MS);
        if (!response || !response.body) return [];
        return Array.isArray(response.body) ? response.body : [];
    } catch (error: any) {
        const statusCode = error?.status || error?.statusCode || "N/A";
        log(`❌ Error fetching messages: status ${statusCode}`, "error");
        throw error;
    }
}

async function cleanChannel(channelId: string) {
    if (!settings.store.enabled || isCleaningInProgress) return;

    try {
        const channel = ChannelStore.getChannel(channelId);
        const currentUserId = UserStore.getCurrentUser()?.id;
        if (!channel || !currentUserId) return;

        const channelName = channel.name || "Private channel";
        log(`🧹 Starting cleanup of "${channelName}"`);

        isCleaningInProgress = true;
        shouldStopCleaning = false;
        cleaningMode = "own";
        cleaningStats = { total: 0, deleted: 0, failed: 0, skipped: 0, startTime: Date.now(), totalKnown: false };
        lastErrorStatus = "";

        let useSearch = true;
        let searchOffset = 0;
        let lastMessageId: string | undefined;
        let emptySearchRetries = 0;

        while (!shouldStopCleaning) {
            try {
                let messages: Message[];

                if (useSearch) {
                    const result = await searchOwnMessages(channel, currentUserId, searchOffset);
                    if (!result.ok) {
                        useSearch = false;
                        log("Search unavailable, falling back to pagination");
                        continue;
                    }
                    if (!cleaningStats.totalKnown && result.total > 0) {
                        cleaningStats.total = result.total;
                        cleaningStats.totalKnown = true;
                        log(`📊 ${result.total} message(s) to delete`);
                    }
                    messages = result.messages;

                    if (messages.length === 0) {
                        if (emptySearchRetries < 4) {
                            emptySearchRetries++;
                            debugLog(`⏳ 0 results (check ${emptySearchRetries}/4), retrying`);
                            await sleep(emptySearchRetries * 5000);
                            continue;
                        }
                        log("No more messages to process");
                        break;
                    }
                    emptySearchRetries = 0;
                } else {
                    messages = await getChannelMessages(channelId, lastMessageId);
                    if (messages.length === 0) { log("No more messages to process"); break; }
                }

                for (const message of messages) {
                    if (shouldStopCleaning) { log("Stop requested by user"); break; }

                    if (!canDeleteMessage(message, currentUserId)) {
                        cleaningStats.skipped++;
                        if (useSearch) searchOffset++;
                        continue;
                    }

                    const success = await deleteMessage(channelId, message.id);
                    if (success) {
                        cleaningStats.deleted++;
                    } else {
                        cleaningStats.failed++;
                        if (useSearch) searchOffset++;
                    }

                    if (settings.store.delayBetweenDeletes > 0) {
                        await sleep(settings.store.delayBetweenDeletes);
                    }
                }

                if (!useSearch) {
                    lastMessageId = messages[messages.length - 1].id;
                    if (messages.length < settings.store.batchSize) break;
                }

            } catch (error: any) {
                const statusCode = error?.status || error?.statusCode || "N/A";

                if (statusCode === 429) {
                    log("Rate limited, pausing 30s...", "warn");
                    await sleep(30000);
                    continue;
                }
                if (statusCode === "timeout") {
                    debugLog("⏳ Request interrupted (channel switch?), retrying");
                    await sleep(2000);
                    continue;
                }

                log(`❌ Error in loop: status ${statusCode}`, "error");
                cleaningStats.failed++;
                await sleep(5000);

                if (cleaningStats.failed > 15) { log("Too many errors, stopping", "error"); break; }
            }
        }

        isCleaningInProgress = false;
        const { deleted, failed, skipped } = cleaningStats;
        const totalTime = Date.now() - cleaningStats.startTime;
        const timeStr = totalTime < 60000 ? `${Math.round(totalTime / 1000)}s` : `${Math.round(totalTime / 60000)}min`;
        log(`✅ Cleanup finished: ${deleted} deleted, ${failed} failed, ${skipped} skipped — ${timeStr}`);

    } catch (error) {
        isCleaningInProgress = false;
        log(`❌ Global error: ${error}`, "error");
    }
}

async function cleanMentions(channelId: string) {
    if (!settings.store.enabled || isCleaningInProgress) return;

    try {
        const channel = ChannelStore.getChannel(channelId);
        const currentUserId = UserStore.getCurrentUser()?.id;
        if (!channel || !currentUserId) return;
        if (!channel.guild_id || !PermissionStore.can(PermissionsBits.MANAGE_MESSAGES, channel)) return;

        log(`🧹 Starting mention cleanup of "${channel.name || channelId}"`);

        isCleaningInProgress = true;
        shouldStopCleaning = false;
        cleaningMode = "mentions";
        cleaningStats = { total: 0, deleted: 0, failed: 0, skipped: 0, startTime: Date.now(), totalKnown: false };
        lastErrorStatus = "";

        let lastMessageId: string | undefined;

        while (!shouldStopCleaning) {
            try {
                const messages = await getChannelMessages(channelId, lastMessageId);
                if (messages.length === 0) { log("No more messages to process"); break; }

                for (const message of messages) {
                    if (shouldStopCleaning) { log("Stop requested by user"); break; }

                    if (!canDeleteMentionMessage(message, currentUserId)) {
                        cleaningStats.skipped++;
                        continue;
                    }

                    const success = await deleteMessage(channelId, message.id);
                    if (success) cleaningStats.deleted++;
                    else cleaningStats.failed++;

                    if (settings.store.delayBetweenDeletes > 0) {
                        await sleep(settings.store.delayBetweenDeletes);
                    }
                }

                lastMessageId = messages[messages.length - 1].id;
                if (messages.length < settings.store.batchSize) break;

            } catch (error: any) {
                const statusCode = error?.status || error?.statusCode || "N/A";

                if (statusCode === 429) {
                    log("Rate limited, pausing 30s...", "warn");
                    await sleep(30000);
                    continue;
                }
                if (statusCode === "timeout") {
                    debugLog("⏳ Request interrupted (channel switch?), retrying");
                    await sleep(2000);
                    continue;
                }

                log(`❌ Error in loop: status ${statusCode}`, "error");
                cleaningStats.failed++;
                await sleep(5000);

                if (cleaningStats.failed > 15) { log("Too many errors, stopping", "error"); break; }
            }
        }

        isCleaningInProgress = false;
        const { deleted, failed, skipped } = cleaningStats;
        const totalTime = Date.now() - cleaningStats.startTime;
        const timeStr = totalTime < 60000 ? `${Math.round(totalTime / 1000)}s` : `${Math.round(totalTime / 60000)}min`;
        log(`✅ Mention cleanup finished: ${deleted} deleted, ${failed} failed, ${skipped} skipped — ${timeStr}`);

    } catch (error) {
        isCleaningInProgress = false;
        log(`❌ Global error: ${error}`, "error");
    }
}

function stopCleaning() {
    if (isCleaningInProgress) {
        shouldStopCleaning = true;
        log("⏹️ Cleanup stop requested");
    }
}

const ChannelContextMenuPatch: NavContextMenuPatchCallback = (children, ctx: { channel?: Channel; } = {}) => {
    const { channel } = ctx;
    if (!channel) return;

    const group = findGroupChildrenByChildId("mark-channel-read", children) ?? children;
    if (!group) return;

    const menuItems: any[] = [<Menu.MenuSeparator key="separator" />];

    if (isCleaningInProgress) {
        const { total, deleted, failed, totalKnown } = cleaningStats;
        const processed = deleted + failed;
        const pct = totalKnown ? `${Math.min(100, Math.round((processed / total) * 100))}% ` : "";
        const errStr = failed > 0 ? ` — ${failed} failed (${lastErrorStatus})` : "";
        const modeLabel = cleaningMode === "mentions" ? "Cleaning mentions" : "Cleaning";
        const label = `${modeLabel}: ${pct}${deleted} deleted${errStr}`;

        menuItems.push(
            <Menu.MenuItem key="cleaning-status" id="vc-cleaning-status"
                label={label}
                color="brand" disabled={true} />,
            <Menu.MenuItem key="stop-cleaning" id="vc-stop-cleaning"
                label="Stop Cleaning" color="danger" action={stopCleaning} />
        );
    } else {
        menuItems.push(
            <Menu.MenuItem key="clean-messages" id="vc-clean-messages"
                label="Clean Messages" color="danger"
                action={() => cleanChannel(channel.id)} />
        );

        if (channel.guild_id && PermissionStore.can(PermissionsBits.MANAGE_MESSAGES, channel)) {
            menuItems.push(
                <Menu.MenuItem key="clean-mentions" id="vc-clean-mentions"
                    label="Clean Mentions" color="danger"
                    action={() => cleanMentions(channel.id)} />
            );
        }
    }

    group.push(...menuItems);
};

export default definePlugin({
    name: "MessageCleaner",
    description: "Cleans all your messages (or messages mentioning you) in a channel, with smart rate limiting and progress stats.",
    authors: [EquicordDevs.Fowlmas],
    dependencies: ["ContextMenuAPI"],
    settings,

    contextMenus: {
        "channel-context": ChannelContextMenuPatch,
        "gdm-context": ChannelContextMenuPatch,
        "user-context": ChannelContextMenuPatch
    },

    start() {
        log("🚀 MessageCleaner plugin started");
    },

    stop() {
        log("🛑 MessageCleaner plugin stopped");
        if (isCleaningInProgress) shouldStopCleaning = true;
    }
});
