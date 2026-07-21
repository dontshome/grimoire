const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");

const scanner = require("./src/scanner");
const providers = require("./src/providers");
const installer = require("./src/installer");
const { readBundledKeys } = require("./src/bundledKeys");
let autoUpdater;
try { ({ autoUpdater } = require("electron-updater")); } catch { /* dev without the dep */ }

// Keys baked into this build (empty for a clean/public build). Loaded once.
const bundledKeys = readBundledKeys(__dirname);

// ---------------------------------------------------------------- settings

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

const DEFAULT_WOW_PATHS = [
  "C:\\Program Files (x86)\\World of Warcraft\\_retail_",
  "C:\\Program Files\\World of Warcraft\\_retail_",
  "D:\\World of Warcraft\\_retail_",
];

function detectWowPath() {
  for (const p of DEFAULT_WOW_PATHS) {
    if (fs.existsSync(path.join(p, "Interface", "AddOns"))) return p;
  }
  return "";
}

// The free public Wago token from the ad panel lives in memory only —
// it is short-lived and re-arrives every time the ad loads.
let wagoPublicToken = "";

function defaultSettings() {
  return {
    wowPath: "",
    curseApiKey: "",
    wagoApiKey: "",
    providerChoice: {},
    matchedIds: {},
    releaseChannel: "stable",
    channelChoice: {},
  };
}

function loadSettings() {
  let s;
  const file = settingsFile();
  try {
    s = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // A missing file is normal (first run). A file that EXISTS but won't parse
    // is corruption — preserve a copy so the user's keys are never just lost,
    // and fall back to the most recent good backup if we have one.
    if (fs.existsSync(file)) {
      try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); } catch {}
      try {
        s = JSON.parse(fs.readFileSync(`${file}.bak`, "utf8"));
      } catch { /* no usable backup */ }
    }
    if (!s) s = defaultSettings();
  }
  if (!s.wowPath) s.wowPath = detectWowPath();
  if (!s.providerChoice) s.providerChoice = {};
  if (!s.matchedIds) s.matchedIds = {};
  if (!s.channelChoice) s.channelChoice = {};
  if (!s.releaseChannel) s.releaseChannel = "stable";
  s.wagoPublicToken = wagoPublicToken; // runtime-only, never persisted
  // Bundled keys are a silent fallback: used only when the user hasn't set
  // their own, and never written back to settings.json or shown in the UI.
  s.curseApiKey = s.curseApiKey || bundledKeys.curseApiKey || "";
  s.wagoApiKey = s.wagoApiKey || bundledKeys.wagoApiKey || "";
  return s;
}

// The Settings UI must show the user's OWN keys, not the bundled fallback —
// otherwise a bundled key would appear as if they'd entered it.
function userVisibleSettings() {
  const s = loadSettings();
  if (!readUserKeys().curseApiKey) s.curseApiKey = "";
  if (!readUserKeys().wagoApiKey) s.wagoApiKey = "";
  s.bundledActive = !!(bundledKeys.curseApiKey || bundledKeys.wagoApiKey);
  // Whether a working Wago token already exists (user's own or bundled). When
  // true, the renderer skips the Wago ad webview entirely — it's only needed
  // to fetch a free token for users who have none.
  s.wagoKeyConfigured = !!loadSettings().wagoApiKey;
  return s;
}

function readUserKeys() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    return { curseApiKey: raw.curseApiKey || "", wagoApiKey: raw.wagoApiKey || "" };
  } catch {
    return { curseApiKey: "", wagoApiKey: "" };
  }
}

function saveSettings(s) {
  const copy = { ...s };
  delete copy.wagoPublicToken;
  delete copy.bundledActive;
  delete copy.wagoKeyConfigured;
  // Never persist bundled keys into settings.json — they belong to the build,
  // not the user, and are re-read from bundled.dat every launch. (Internal
  // callers pass a merged settings object that may carry them.)
  if (copy.curseApiKey && copy.curseApiKey === bundledKeys.curseApiKey) copy.curseApiKey = "";
  if (copy.wagoApiKey && copy.wagoApiKey === bundledKeys.wagoApiKey) copy.wagoApiKey = "";

  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Keep a one-generation backup of the last good file so a corrupt read can
  // recover the user's keys.
  try { if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`); } catch {}
  // Atomic write: write to a temp file, then rename over the target. A crash
  // mid-write can never leave a truncated/corrupt settings.json.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(copy, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- window

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: "#0d0f14",
    autoHideMenuBar: true,
    title: "Grimoire",
    icon: path.join(__dirname, "build", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // the Wago ad panel is a <webview>
    },
  });
  mainWindow.loadFile(path.join(__dirname, "ui", "index.html"));

  // The ad page must not navigate the app or open windows inside it.
  mainWindow.webContents.on("did-attach-webview", (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (evt, url) => {
      if (contents.getURL() !== url) evt.preventDefault();
    });
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  // Check GitHub Releases for a newer version and download it in the
  // background; the user is prompted to restart when it's ready. No-ops in dev
  // (no update feed) and does nothing harmful if offline.
  // Only the public build auto-updates. The dad build (identified by its
  // bundled keys) must NOT pull the public release — that would replace it
  // with the keyless build and wipe the embedded keys.
  const isBundledBuild = !!(bundledKeys.curseApiKey || bundledKeys.wagoApiKey);
  if (autoUpdater && app.isPackaged && !isBundledBuild) {
    autoUpdater.autoDownload = true;
    autoUpdater.on("update-downloaded", (info) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("app:update-ready", info.version);
      }
    });
    autoUpdater.checkForUpdates().catch(() => {});
  }
});

ipcMain.handle("app:install-update", () => {
  if (autoUpdater) autoUpdater.quitAndInstall();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// The Wago ad page hands over a public API token via the webview preload.
ipcMain.on("wago-token-received", (_e, token) => {
  if (typeof token !== "string" || token.length < 20) return;
  const isNew = token !== wagoPublicToken;
  wagoPublicToken = token;
  if (isNew && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("wago:connected");
  }
});

// The public ad token expires. When a Wago call gets rejected, providers.js
// calls this to have the renderer reload the ad panel and hand over a fresh
// one — otherwise Wago search and checks quietly die after a while.
providers.setWagoRefreshHook(() => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("wago:refresh");
  }
});

// Proactively re-arm the token every 25 minutes so it rarely goes stale
// mid-session in the first place.
setInterval(() => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("wago:refresh");
  }
}, 25 * 60e3);

// ---------------------------------------------------------------- helpers

// Fold in provider ids discovered by cross-provider matching. Name-matched
// ids only fill gaps; fingerprint-verified Wago ids replace stale .toc ids.
function overlayMatchedIds(packages, settings) {
  const FIELD = { curseforge: "curseId", wago: "wagoId", wowinterface: "wowiId", tukui: "tukuiId" };
  for (const p of packages) {
    const m = (settings.matchedIds || {})[p.key];
    if (!m) continue;
    for (const [prov, field] of Object.entries(FIELD)) {
      if (!m[prov]) continue;
      if (prov === "wago" ? p[field] !== String(m[prov]) : !p[field]) {
        p[field] = String(m[prov]);
      }
      if (!p.sources.includes(prov)) p.sources.push(prov);
    }
    p.provider = p.sources.length > 1 ? "multi" : p.sources[0] || "unknown";
  }
}

function addonsDirOf(settings) {
  return path.join(settings.wowPath, "Interface", "AddOns");
}

// Release channel for an install/resolve job: per-addon override, else global.
function channelOfJob(job, settings) {
  const per = (settings.channelChoice || {})[job && job.key];
  const chosen = per || settings.releaseChannel || "stable";
  return ["stable", "beta", "alpha"].includes(chosen) ? chosen : "stable";
}

// One-time import of per-addon stability overrides already set in the Wago
// App, so switching managers doesn't silently drop the user's choices. Keyed
// by Wago addon id there; matched to package keys here.
function importWagoAppChannels(packages, settings) {
  if (settings.wagoChannelsImported) return false;
  const cfgPath = path.join(app.getPath("appData"), "wago-app", "config.json");
  let prefs;
  try {
    prefs = JSON.parse(fs.readFileSync(cfgPath, "utf8"))["addonPreferences:v1"];
  } catch {
    settings.wagoChannelsImported = true; // no Wago App installed; don't retry
    return true;
  }
  let imported = 0;
  for (const pref of prefs || []) {
    if (!pref.addonId || !pref.stabilityOverride) continue;
    if (!["stable", "beta", "alpha"].includes(pref.stabilityOverride)) continue;
    const pkg = packages.find((p) => p.wagoId && String(p.wagoId) === String(pref.addonId));
    if (!pkg || settings.channelChoice[pkg.key]) continue;
    settings.channelChoice[pkg.key] = pref.stabilityOverride;
    imported++;
  }
  settings.wagoChannelsImported = true;
  if (imported) console.log(`[grimoire] imported ${imported} release-channel overrides from the Wago App`);
  return true;
}

// ---------------------------------------------------------------- ipc

ipcMain.handle("settings:get", () => userVisibleSettings());

ipcMain.handle("settings:save", (_e, s) => {
  saveSettings(s);
  return userVisibleSettings();
});

ipcMain.handle("dialog:pickFolder", async () => {
  const res = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle("shell:open", (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});

ipcMain.handle("wago:adPreloadPath", () => {
  // A <webview> preload must be a real file on disk — Electron won't load one
  // from inside app.asar. The build unpacks it (asarUnpack), so point at the
  // unpacked copy when running packaged.
  const dir = __dirname.replace(/app\.asar([\\/]|$)/, "app.asar.unpacked$1");
  return "file://" + path.join(dir, "wago-ad-preload.js").replace(/\\/g, "/");
});

ipcMain.handle("wago:status", () => ({ connected: !!wagoPublicToken }));

ipcMain.handle("addons:scan", () => {
  const s = loadSettings();
  if (!s.wowPath) return { error: "noWowPath", packages: [] };
  const addonsDir = addonsDirOf(s);
  if (!fs.existsSync(addonsDir)) return { error: "badWowPath", packages: [] };
  const res = scanner.scan(addonsDir);
  overlayMatchedIds(res.packages || [], s);
  if (importWagoAppChannels(res.packages || [], s)) saveSettings(s);
  // Tell the UI which channel each addon resolves to.
  for (const p of res.packages || []) p.channel = channelOfJob(p, s);
  return res;
});

ipcMain.handle("updates:check", async (_e, packages) => {
  const s = loadSettings();
  const res = await providers.checkUpdates(packages, s);
  // _match verified these by folder fingerprint — remember the canonical ids
  // (they beat whatever stale X-Wago-ID a .toc may carry).
  const discovered = res.discoveredWagoIds || {};
  if (Object.keys(discovered).length) {
    for (const [key, ids] of Object.entries(discovered)) {
      s.matchedIds[key] = { ...(s.matchedIds[key] || {}), ...ids, at: Date.now() };
    }
    saveSettings(s);
  }
  return res;
});

ipcMain.handle("updates:install", async (_e, job) => {
  const s = loadSettings();
  // Resolve a fresh download URL when the caller doesn't have one (WoWI
  // search results, provider switches, stale links).
  if (!job.downloadUrl && job.provider && job.id) {
    const r = await providers.resolveInstall(job.provider, job.id, s, channelOfJob(job, s));
    if (!r || !r.downloadUrl) throw new Error("No download available from " + job.provider);
    job.downloadUrl = r.downloadUrl;
    job.version = job.version || r.remoteVersion;
  }
  if (job.provider === "wago" && job.downloadUrl) {
    job.downloadUrl = providers.wagoDownloadUrl(job.downloadUrl, s);
  }
  try {
    return await installer.install(job, addonsDirOf(s), app.getPath("userData"));
  } catch (err) {
    // Wago download links are signed and expire; on auth failure fetch a
    // fresh link (which also refreshes the token) and retry once.
    if (job.provider === "wago" && job.id && /40[13]/.test(String(err.message))) {
      const r = await providers.resolveInstall("wago", job.id, s, channelOfJob(job, s));
      if (r && r.downloadUrl) {
        job.downloadUrl = providers.wagoDownloadUrl(r.downloadUrl, s);
        return installer.install(job, addonsDirOf(s), app.getPath("userData"));
      }
    }
    throw err;
  }
});

ipcMain.handle("addons:uninstall", async (_e, job) => {
  const s = loadSettings();
  return installer.uninstall(job, addonsDirOf(s), app.getPath("userData"));
});

// Raw (un-merged) results of the search currently being paged through, so
// "load more" re-merges against everything fetched so far instead of
// producing duplicate rows.
let searchPage = { sig: "", raw: [] };

ipcMain.handle("providers:search", async (_e, { query, categoryId, categoryName, cursor }) => {
  const s = loadSettings();
  const sig = `${query || ""}|${categoryId || ""}`;
  // Only continue accumulating when this is a follow-on page of the same search.
  const continuing = !!cursor && searchPage.sig === sig;
  const carryRaw = continuing ? searchPage.raw : [];
  const res = await providers.search(query, s, {
    categoryId,
    categoryName,
    cursor: continuing ? cursor : undefined,
    carryRaw,
  });
  searchPage = { sig, raw: res.raw || [] };
  delete res.raw; // renderer only needs the merged list
  return res;
});

ipcMain.handle("providers:categories", async () => {
  const s = loadSettings();
  try {
    return await providers.cfCategories(s.curseApiKey);
  } catch {
    return [];
  }
});

ipcMain.handle("providers:resolve", async (_e, { provider, id, key }) => {
  const s = loadSettings();
  return providers.resolveInstall(provider, id, s, channelOfJob({ key }, s));
});

// Cross-provider matching for installed addons that only list one source.
// Results (including "nothing found") are cached in settings for a week.
ipcMain.handle("providers:match", async (_e, packages) => {
  const s = loadSettings();
  const WEEK = 7 * 24 * 3600e3;
  const matched = {};
  const candidates = (packages || []).filter((p) => {
    const cached = (s.matchedIds || {})[p.key];
    if (cached && Date.now() - (cached.at || 0) < WEEK) return false;
    return (p.sources || []).length < 3;
  });
  for (const p of candidates.slice(0, 30)) {
    try {
      const found = await providers.matchProviders(p, s);
      s.matchedIds[p.key] = { ...(s.matchedIds[p.key] || {}), ...found, at: Date.now() };
      if (Object.keys(found).length) matched[p.key] = found;
    } catch {
      /* skip addon on error */
    }
  }
  saveSettings(s);
  return { matched };
});
