const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const scanner = require("./src/scanner");
const providers = require("./src/providers");
const installer = require("./src/installer");
const { readBundledKeys } = require("./src/bundledKeys");
const flavors = require("./src/flavors");
const {
  SECRET_FIELDS,
  createSecretCodec,
  hasLegacySecrets,
  redactSecretsInText,
  hardenFile,
  secureWriteText,
  secureCopyFile,
  applySecretsForSave,
} = require("./src/credentials");
let autoUpdater;
try { ({ autoUpdater } = require("electron-updater")); } catch { /* dev without the dep */ }

// Keys baked into this build (empty for a clean/public build). Loaded once.
const bundledKeys = readBundledKeys(__dirname);

// ---------------------------------------------------------------- settings

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

// ------------------------------------------------------- credentials at rest

// Fields holding credentials. On disk they live encrypted under "<field>Enc";
// the bare name is used in memory and by the legacy plaintext format we
// migrate away from on first launch.
// safeStorage wraps DPAPI on Windows and the Keychain on macOS, so ciphertext
// is bound to this OS user account.
const { encryptionAvailable, encryptSecret, readSecrets } = createSecretCodec(safeStorage);

// A corrupt file is kept for recovery, but it must not become another copy of
// the user's credentials. The name is fixed rather than timestamped so these
// cannot accumulate the way the old settings.json.corrupt-<ts> files did.
function preserveCorrupt(file) {
  try {
    secureWriteText(`${file}.corrupt`, redactSecretsInText(fs.readFileSync(file, "utf8")));
  } catch { /* best effort — never block startup over this */ }
}

// One-time upgrade at launch: rewrite plaintext credentials in encrypted form
// and neutralise the plaintext copies older builds left lying around.
function migrateSecretsAtRest() {
  const file = settingsFile();
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* absent or corrupt */ }

  if (raw && hasLegacySecrets(raw) && encryptionAvailable()) {
    saveSettings(loadSettings());
    // saveSettings snapshots the *previous* file into .bak — which is the
    // plaintext one we are migrating away from. Overwrite it with the
    // encrypted result so no plaintext generation survives the upgrade.
    try { secureCopyFile(file, `${file}.bak`); } catch { /* best effort */ }
  }

  // Older builds wrote a timestamped copy on every corrupt read, each holding a
  // full set of plaintext keys, and nothing ever pruned them. Redact in place
  // rather than delete — they may still have recovery value, but they should
  // not be credential stores.
  try {
    const dir = path.dirname(file);
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith("settings.json.corrupt")) continue;
      const p = path.join(dir, name);
      const text = fs.readFileSync(p, "utf8");
      const redacted = redactSecretsInText(text);
      if (redacted !== text) secureWriteText(p, redacted);
      else hardenFile(p);
    }
  } catch { /* best effort */ }
  // Older versions used the process umask, commonly leaving settings readable
  // by other local accounts. Ciphertext is still sensitive metadata, and a
  // legacy file may be plaintext, so every settings generation is owner-only.
  hardenFile(file);
  hardenFile(`${file}.bak`);
  hardenFile(`${file}.corrupt`);
}

// Probed in order; paths for the other platform simply never exist, so the
// list can stay flat rather than branching on process.platform.
// The Linux entries are Wine prefixes — Battle.net has no native Linux
// client, so WoW always lands under drive_c inside one. Paths cover Lutris's
// official Battle.net installer (~/Games/battlenet, the common case) and a
// plain default Wine prefix; a Proton prefix under Steam's compatdata isn't
// probed here since its folder name is a per-install numeric app id, not
// something guessable.
const DEFAULT_WOW_ROOTS = [
  "C:\\Program Files (x86)\\World of Warcraft",
  "C:\\Program Files\\World of Warcraft",
  "D:\\World of Warcraft",
  "D:\\Games\\World of Warcraft",
  "/Applications/World of Warcraft",
  path.join(os.homedir(), "Applications", "World of Warcraft"),
  path.join(os.homedir(), "Games", "battlenet", "drive_c", "Program Files (x86)", "World of Warcraft"),
  path.join(os.homedir(), "Games", "battle-net", "drive_c", "Program Files (x86)", "World of Warcraft"),
  path.join(os.homedir(), ".wine", "drive_c", "Program Files (x86)", "World of Warcraft"),
];

// wowPath is the WoW *root*, which holds every client folder (_retail_,
// _classic_era_, _classic_, PTRs …). Each flavor is a subfolder of it.
function detectWowPath() {
  for (const root of DEFAULT_WOW_ROOTS) {
    if (flavors.detectFlavors(root).length) return root;
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

function isSettingsObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function loadSettings() {
  let s;
  const file = settingsFile();
  try {
    s = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isSettingsObject(s)) throw new Error("Settings must be a JSON object");
  } catch {
    // A missing file is normal (first run). A file that EXISTS but won't parse
    // is corruption — preserve a copy so the user's keys are never just lost,
    // and fall back to the most recent good backup if we have one.
    if (fs.existsSync(file)) {
      preserveCorrupt(file);
      try {
        s = JSON.parse(fs.readFileSync(`${file}.bak`, "utf8"));
        if (!isSettingsObject(s)) s = null;
      } catch { /* no usable backup */ }
    }
    if (!s) s = defaultSettings();
  }
  // Migration: older settings stored the retail client folder itself
  // (…/World of Warcraft/_retail_). Normalize to the root and keep retail
  // selected so existing installs carry over untouched.
  const normalized = flavors.normalizeRoot(s.wowPath);
  if (normalized !== s.wowPath) {
    if (!s.flavor) s.flavor = "retail";
    s.wowPath = normalized;
  }
  if (!s.wowPath) s.wowPath = detectWowPath();
  // Fall back to whatever flavor is actually installed if the saved one isn't.
  const installed = flavors.detectFlavors(s.wowPath);
  if (!s.flavor || !installed.some((f) => f.id === s.flavor)) {
    s.flavor = (installed[0] && installed[0].id) || "retail";
  }
  if (!s.providerChoice) s.providerChoice = {};
  if (!s.matchedIds) s.matchedIds = {};
  if (!s.channelChoice) s.channelChoice = {};
  if (!s.releaseChannel) s.releaseChannel = "stable";
  s.wagoPublicToken = wagoPublicToken; // runtime-only, never persisted
  // Decrypt the user's own keys (or read them from the legacy plaintext form),
  // then fall back to the bundled build keys. Bundled keys are a silent
  // fallback: never written back to settings.json or shown in the UI.
  const secrets = readSecrets(s);
  // The ciphertext has no business travelling to the renderer alongside the
  // decrypted value it duplicates.
  for (const f of SECRET_FIELDS) delete s[`${f}Enc`];
  s.curseApiKey = secrets.curseApiKey || bundledKeys.curseApiKey || "";
  s.wagoApiKey = secrets.wagoApiKey || bundledKeys.wagoApiKey || "";
  return s;
}

// The Settings UI must show the user's OWN keys, not the bundled fallback —
// otherwise a bundled key would appear as if they'd entered it.
function userVisibleSettings() {
  const s = loadSettings();
  const userKeys = readUserKeys();
  // Credentials stay in the trusted main process. The renderer only needs to
  // know whether a value exists; edits arrive as an explicit settings patch.
  delete s.curseApiKey;
  delete s.wagoApiKey;
  s.curseKeyConfigured = !!(userKeys.curseApiKey || bundledKeys.curseApiKey);
  s.curseUserKeyConfigured = !!userKeys.curseApiKey;
  s.wagoUserKeyConfigured = !!userKeys.wagoApiKey;
  s.bundledActive = !!(bundledKeys.curseApiKey || bundledKeys.wagoApiKey);
  // Whether a working Wago token already exists (user's own or bundled). When
  // true, the renderer skips the Wago ad webview entirely — it's only needed
  // to fetch a free token for users who have none.
  s.wagoKeyConfigured = !!loadSettings().wagoApiKey;
  return s;
}

function readUserKeys() {
  for (const file of [settingsFile(), `${settingsFile()}.bak`]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (isSettingsObject(parsed)) return readSecrets(parsed);
    } catch { /* try the backup */ }
  }
  return { curseApiKey: "", wagoApiKey: "" };
}

function saveSettings(s) {
  if (!isSettingsObject(s)) throw new Error("Invalid settings");
  const copy = { ...s };
  const suppliedSecrets = {};
  for (const f of SECRET_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(copy, f)) {
      suppliedSecrets[f] = String(copy[f] || "").trim();
    }
  }
  delete copy.wagoPublicToken;
  delete copy.bundledActive;
  delete copy.curseKeyConfigured;
  delete copy.curseUserKeyConfigured;
  delete copy.wagoKeyConfigured;
  delete copy.wagoUserKeyConfigured;
  // Never persist bundled keys into settings.json — they belong to the build,
  // not the user, and are re-read from bundled.dat every launch. (Internal
  // callers pass a merged settings object that may carry them.)
  if (copy.curseApiKey && copy.curseApiKey === bundledKeys.curseApiKey) copy.curseApiKey = "";
  if (copy.wagoApiKey && copy.wagoApiKey === bundledKeys.wagoApiKey) copy.wagoApiKey = "";
  if (suppliedSecrets.curseApiKey && suppliedSecrets.curseApiKey === bundledKeys.curseApiKey) {
    delete suppliedSecrets.curseApiKey;
  }
  if (suppliedSecrets.wagoApiKey && suppliedSecrets.wagoApiKey === bundledKeys.wagoApiKey) {
    delete suppliedSecrets.wagoApiKey;
  }

  // New credentials must be encrypted at rest. Existing legacy plaintext is
  // preserved only when an unrelated internal save passes the same value back;
  // entering a new key fails clearly if the OS credential service is down.
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(settingsFile(), "utf8")); } catch {}
  applySecretsForSave(copy, existing, suppliedSecrets, encryptSecret);

  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Keep a one-generation backup of the last good file so a corrupt read can
  // recover the user's keys.
  try { if (fs.existsSync(file)) secureCopyFile(file, `${file}.bak`); } catch {}
  // Atomic write: write to a temp file, then rename over the target. A crash
  // mid-write can never leave a truncated/corrupt settings.json.
  const tmp = `${file}.tmp`;
  secureWriteText(tmp, JSON.stringify(copy, null, 2));
  fs.renameSync(tmp, file);
  hardenFile(file);
  // A replacement/removal must not leave the previous key recoverable in the
  // one-generation backup. Atomic writing already guarantees a valid current
  // file, so make the backup match the new credential state in this case.
  if (Object.keys(suppliedSecrets).length) {
    try { secureCopyFile(file, `${file}.bak`); } catch { /* best effort */ }
  }
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
  // Must run after ready — safeStorage has no keyring to talk to before that.
  migrateSecretsAtRest();
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
  if (app.isPackaged && !isBundledBuild) {
    // macOS cannot self-update here: Squirrel.Mac verifies the running app's
    // code signature before applying an update, and this build is unsigned (no
    // Apple Developer account). autoUpdater used to be called on macOS too,
    // where it failed into a .catch() and the user was told nothing at all.
    if (process.platform === "darwin") {
      checkForNewerRelease();
    } else if (autoUpdater) {
      autoUpdater.autoDownload = true;
      autoUpdater.on("update-downloaded", (info) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("app:update-ready", info.version);
        }
      });
      autoUpdater.checkForUpdates().catch(() => {});
    }
  }
});

ipcMain.handle("app:install-update", () => {
  if (autoUpdater) autoUpdater.quitAndInstall();
});

// ------------------------------------------------------- notify-only updates

// Used on macOS in place of a real auto-update (see the whenReady comment).
// Hard-coded rather than read from package.json's publish config, because
// electron-builder rewrites package.json when packaging and the build field
// is not guaranteed to survive.
const GITHUB_REPO = "dontshome/grimoire";
const UPDATE_CHECK_TIMEOUT_MS = 15 * 1000;

// True when `remote` is strictly newer. Compares dotted numeric components,
// treating a missing component as 0 so 0.2 beats 0.1.9.
function isNewerVersion(remote, current) {
  const parse = (v) => String(v).replace(/^v/i, "").split(/[.\-+]/).map((n) => parseInt(n, 10));
  const a = parse(remote);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = Number.isFinite(a[i]) ? a[i] : 0;
    const y = Number.isFinite(b[i]) ? b[i] : 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function checkForNewerRelease() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    if (!res.ok) return;
    const release = await res.json();
    const latest = String(release.tag_name || "").replace(/^v/i, "");
    if (!latest || !isNewerVersion(latest, app.getVersion())) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("app:update-available", {
        version: latest,
        url: release.html_url || `https://github.com/${GITHUB_REPO}/releases/latest`,
      });
    }
  } catch {
    // Offline, rate-limited, or GitHub is down. An update check failing is not
    // worth interrupting the user over.
  } finally {
    clearTimeout(timer);
  }
}

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
  return flavors.addonsDirFor(settings.wowPath, settings.flavor);
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

ipcMain.handle("settings:validateCurseKey", async (_e, apiKey) => {
  const key = typeof apiKey === "string" ? apiKey : loadSettings().curseApiKey;
  try {
    await providers.validateCurseApiKey(key);
    return { valid: true };
  } catch (err) {
    // Invalid credentials are an expected validation result, not an IPC
    // handler failure. Returning structured data avoids Electron dumping a
    // scary main-process stack trace for a normal 401/403 response.
    return {
      valid: false,
      status: err && err.status,
      code: err && err.code,
      message: (err && err.message) || String(err),
    };
  }
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
  const installedFlavors = flavors.detectFlavors(s.wowPath);
  if (!fs.existsSync(addonsDir)) {
    // A client that exists but has no AddOns folder yet (never launched):
    // report an empty library rather than an error.
    if (installedFlavors.some((f) => f.id === s.flavor)) {
      return { packages: [], scannedFolders: 0, tookMs: 0, flavors: installedFlavors, flavor: s.flavor };
    }
    return { error: "badWowPath", packages: [], flavors: installedFlavors };
  }
  const res = scanner.scan(addonsDir, flavors.byId(s.flavor).tocSuffix);
  res.flavors = flavors.detectFlavors(s.wowPath);
  res.flavor = s.flavor;
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
  flavors.ensureAddonsDir(s.wowPath, s.flavor);
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
