"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("installer", {
    runAction: (action, locationPath) => ipcRenderer.invoke("run-action", action, locationPath),
    detectDiscord: () => ipcRenderer.invoke("detect-discord"),
    browseDiscord: () => ipcRenderer.invoke("browse-discord"),
    minimize: () => ipcRenderer.invoke("window-minimize"),
    close: () => ipcRenderer.invoke("window-close")
});
