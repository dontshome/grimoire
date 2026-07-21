const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("grimoire", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (s) => ipcRenderer.invoke("settings:save", s),
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
  openExternal: (url) => ipcRenderer.invoke("shell:open", url),
  scanAddons: () => ipcRenderer.invoke("addons:scan"),
  checkUpdates: (packages) => ipcRenderer.invoke("updates:check", packages),
  installUpdate: (job) => ipcRenderer.invoke("updates:install", job),
  uninstall: (job) => ipcRenderer.invoke("addons:uninstall", job),
  searchProviders: (opts) => ipcRenderer.invoke("providers:search", opts),
  getCategories: () => ipcRenderer.invoke("providers:categories"),
  resolveAddon: (opts) => ipcRenderer.invoke("providers:resolve", opts),
  matchProviders: (packages) => ipcRenderer.invoke("providers:match", packages),
  wagoAdPreloadPath: () => ipcRenderer.invoke("wago:adPreloadPath"),
  wagoStatus: () => ipcRenderer.invoke("wago:status"),
  onWagoConnected: (cb) => ipcRenderer.on("wago:connected", () => cb()),
  onWagoRefresh: (cb) => ipcRenderer.on("wago:refresh", () => cb()),
  onUpdateReady: (cb) => ipcRenderer.on("app:update-ready", (_e, v) => cb(v)),
  installUpdateNow: () => ipcRenderer.invoke("app:install-update"),
});
