// Preload for the Wago ad <webview>. The ad page at addons.wago.io/wowup_ad
// calls window.wago.provideApiKey(<public token>) once the ad has loaded —
// showing that ad is what grants free Wago Addons API access (same deal
// WowUp has). We forward the token to the main process.
const { contextBridge, ipcRenderer } = require("electron");

let keyTimeout = setTimeout(() => {
  // Bad ad response — reload and try again (mirrors WowUp's backoff).
  try { window.location.reload(); } catch {}
}, 30000);

contextBridge.exposeInMainWorld("wago", {
  provideApiKey: (key) => {
    clearTimeout(keyTimeout);
    keyTimeout = undefined;
    ipcRenderer.send("wago-token-received", key);
  },
});
