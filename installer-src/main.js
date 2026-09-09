"use strict";

const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { execFileSync, execSync } = require("child_process");
// original-fs bypasses Electron's automatic asar interception, which otherwise
// opens and caches a handle on any "app.asar" path we merely stat/check for
// existence — that cached handle then blocks Equilotl from patching it.
const { createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } = require("original-fs");
const { join } = require("path");
const { Readable } = require("stream");
const { finished } = require("stream/promises");

const EQUILOTL_BASE_URL = "https://github.com/Equicord/Equilotl/releases/latest/download/";
const USER_DATA_DIR = join(app.getPath("userData"), "EquicordData");
const CACHE_DIR = join(app.getPath("userData"), "installer-cache");
const ETAG_FILE = join(CACHE_DIR, "etag.txt");

// Bundled build of Equicord: packaged next to the app in production,
// falls back to the repo's own dist/ folder when run unpacked for testing.
const BUNDLED_DIST_DIR = app.isPackaged
    ? join(process.resourcesPath, "equicord-dist")
    : join(__dirname, "..", "dist", "desktop");

// ── Discord install detection (Windows) ─────────────────────────────────────
const CHANNELS = {
    stable: { label: "Discord", folder: "Discord" },
    ptb: { label: "Discord PTB", folder: "DiscordPTB" },
    canary: { label: "Discord Canary", folder: "DiscordCanary" }
};

function findChannelPath(folder) {
    try {
        const base = join(process.env.LOCALAPPDATA || "", folder);
        if (!existsSync(base)) return null;

        const versions = readdirSync(base)
            .filter(f => f.startsWith("app-") && lstatSync(join(base, f)).isDirectory())
            .sort()
            .reverse();
        if (!versions.length) return null;

        const resources = join(base, versions[0], "resources");
        // Equilotl's -location flag expects the base install folder (e.g. ".../DiscordPTB"),
        // not the versioned resources subfolder — the resources path is only used for display.
        return existsSync(join(resources, "app.asar")) ? { display: resources, base } : null;
    } catch {
        return null;
    }
}

function detectDiscordInstalls() {
    const result = {};
    for (const [id, { label, folder }] of Object.entries(CHANNELS)) {
        const found = findChannelPath(folder);
        result[id] = { label, path: found?.display ?? "", base: found?.base ?? "" };
    }
    return result;
}

function validateBrowsedPath(proposedPath) {
    // Browsed straight to the resources folder.
    if (existsSync(join(proposedPath, "app.asar"))) {
        return { display: proposedPath, base: join(proposedPath, "..", "..") };
    }
    // Browsed to an app-X.X.X folder.
    const res = join(proposedPath, "resources");
    if (existsSync(join(res, "app.asar"))) {
        return { display: res, base: join(proposedPath, "..") };
    }
    // Browsed straight to the base Discord folder (e.g. "DiscordPTB").
    try {
        const versions = readdirSync(proposedPath)
            .filter(f => f.startsWith("app-") && lstatSync(join(proposedPath, f)).isDirectory())
            .sort()
            .reverse();
        for (const v of versions) {
            const r = join(proposedPath, v, "resources");
            if (existsSync(join(r, "app.asar"))) return { display: r, base: proposedPath };
        }
    } catch { /* not a Discord folder */ }
    return null;
}

// ── Kill/restart the target Discord process ─────────────────────────────────
function getProcessName(basePath) {
    if (basePath.includes("DiscordPTB")) return "DiscordPTB";
    if (basePath.includes("DiscordCanary")) return "DiscordCanary";
    if (basePath.includes("DiscordDevelopment")) return "DiscordDevelopment";
    return "Discord";
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isRunning(exeName) {
    try {
        const out = execSync(`tasklist /FI "IMAGENAME eq ${exeName}" /NH`, { encoding: "utf-8" });
        return out.includes(exeName);
    } catch {
        return false;
    }
}

// Discord spawns several processes sharing the main exe name (renderer/GPU/etc,
// all killed via /T) plus a separate native helper that also locks module files.
const HELPER_PROCESS_NAMES = ["DiscordSystemHelper.exe", "Update.exe"];

async function closeDiscordIfRunning(basePath, log) {
    if (process.platform !== "win32") return;
    const exeNames = [`${getProcessName(basePath)}.exe`, ...HELPER_PROCESS_NAMES];

    const runningNames = exeNames.filter(isRunning);
    if (!runningNames.length) return;

    log(`Closing ${runningNames.join(", ")}...`);
    for (const exeName of runningNames) {
        try {
            execSync(`taskkill /IM "${exeName}" /F /T`, { stdio: "ignore" });
        } catch { /* already gone */ }
    }

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && exeNames.some(isRunning)) {
        await sleep(200);
    }
    // Give the OS a moment to release file handles after process exit.
    await sleep(500);
    log("Discord closed.");
}

function restartDiscord(basePath) {
    const exeName = `${getProcessName(basePath)}.exe`;
    const updateExe = join(basePath, "Update.exe");
    if (!existsSync(updateExe)) return;
    try {
        execFileSync(updateExe, ["--processStart", exeName], { stdio: "ignore" });
    } catch { /* best effort */ }
}

function getInstallerFilename() {
    switch (process.platform) {
        case "win32": return "EquilotlCli.exe";
        case "darwin": return process.arch === "arm64" ? "Equilotl-darwin-arm64.zip" : "Equilotl-darwin-x64.zip";
        case "linux": return "EquilotlCli-linux";
        default: throw new Error("Unsupported platform: " + process.platform);
    }
}

async function ensureEquilotl(log) {
    const filename = getInstallerFilename();
    mkdirSync(CACHE_DIR, { recursive: true });
    const outputFile = join(CACHE_DIR, filename);

    const etag = existsSync(outputFile) && existsSync(ETAG_FILE) ? readFileSync(ETAG_FILE, "utf-8") : null;

    log("Checking for installer engine...");
    const res = await fetch(EQUILOTL_BASE_URL + filename, {
        headers: {
            "User-Agent": "Equicord-Installer",
            ...(etag ? { "If-None-Match": etag } : {})
        }
    });

    if (res.status === 304) {
        log("Installer engine up to date.");
        return outputFile;
    }
    if (!res.ok) throw new Error(`Failed to download installer engine: ${res.status} ${res.statusText}`);

    writeFileSync(ETAG_FILE, res.headers.get("etag") ?? "");
    const body = Readable.fromWeb(res.body);
    await finished(body.pipe(createWriteStream(outputFile, { mode: 0o755, autoClose: true })));
    log("Installer engine downloaded.");

    return outputFile;
}

async function runAction(action, log, locationPath) {
    if (!existsSync(BUNDLED_DIST_DIR)) {
        throw new Error(`Bundled build not found at ${BUNDLED_DIST_DIR}. This installer was not packaged correctly.`);
    }

    const bin = await ensureEquilotl(log);
    mkdirSync(USER_DATA_DIR, { recursive: true });

    if (locationPath) await closeDiscordIfRunning(locationPath, log);

    const args = [`--${action}`];
    if (locationPath) args.push("-location", locationPath);

    log(`Running ${action}...`);
    execFileSync(bin, args, {
        stdio: "pipe",
        env: {
            ...process.env,
            EQUICORD_USER_DATA_DIR: USER_DATA_DIR,
            EQUICORD_DIRECTORY: BUNDLED_DIST_DIR,
            EQUICORD_DEV_INSTALL: "1"
        }
    });
    log(`${action} finished successfully.`);

    if (locationPath && action !== "uninstall") {
        log("Restarting Discord...");
        restartDiscord(locationPath);
    }
}

function createWindow() {
    const win = new BrowserWindow({
        width: 560,
        height: 400,
        resizable: false,
        frame: false,
        backgroundColor: "#0c0d10",
        webPreferences: {
            preload: join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    win.loadFile(join(__dirname, "index.html"));

    ipcMain.handle("window-minimize", () => win.minimize());
    ipcMain.handle("window-close", () => win.close());
}

ipcMain.handle("detect-discord", () => detectDiscordInstalls());

ipcMain.handle("browse-discord", async () => {
    const result = await dialog.showOpenDialog({
        title: "Select your Discord installation folder",
        properties: ["openDirectory", "treatPackageAsDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const resolved = validateBrowsedPath(result.filePaths[0]);
    return resolved || null;
});

ipcMain.handle("run-action", async (_event, action, locationPath) => {
    const logs = [];
    const log = line => logs.push(line);
    try {
        await runAction(action, log, locationPath);
        return { ok: true, logs };
    } catch (e) {
        logs.push(`Error: ${e.message}`);
        return { ok: false, logs };
    }
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
