// Update checking + addon search across four providers.
//
//   CurseForge   — official API with the user's key (checks, search, logos);
//                  keyless fallback via the website's public file endpoint
//                  (checks only — the search endpoint is Cloudflare-gated).
//   Wago Addons  — external API. Auth is a token; Grimoire gets a free public
//                  token from the Wago ad panel (same deal WowUp has), or the
//                  user's own Patreon token from Settings if present.
//   WoWInterface — fully public API, no key ever (api.mmoui.com).
//   Tukui        — fully public API, no key ever (ElvUI lives here).

const { net } = require("electron");
const path = require("path");
const { fingerprintFolders } = require("./fingerprint");

const CF_API = "https://api.curseforge.com/v1";
const WAGO_API = "https://addons.wago.io/api/external";
const WOWI_API = "https://api.mmoui.com/v3/game/WOW";
const TUKUI_API = "https://api.tukui.org/v1";
const RETAIL_GAME_VERSION_TYPE = 517; // CurseForge's id for retail (default)
const flavors = require("./flavors");

// CurseForge gameVersionTypeId / Wago game_version for the flavor in play.
function cfTypeOf(settings) { return flavors.byId(settings && settings.flavor).cfTypeId; }
function wagoGameOf(settings) { return flavors.byId(settings && settings.flavor).wago; }
const CF_GAME_WOW = 1;
const CF_CLASS_ADDONS = 1;
const CF_SORT_POPULARITY = 2;

// Release channels, safest first. "beta" means "beta if newer than stable,
// else stable" — opting into a channel never hides a newer, safer build.
// Not every provider or addon offers all three; results report what exists.
const CHANNELS = ["stable", "beta", "alpha"];
const HTTP_TIMEOUT_MS = 45 * 1000;
const MAX_JSON_BYTES = 25 * 1024 * 1024;

// ---------------------------------------------------------------- http

// Electron's net module rides Chromium's stack, which Cloudflare accepts
// where plain Node fetch gets flagged.
function netJson(url, { method = "GET", headers = {}, body, redirect = "follow" } = {}) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method, url, useSessionCookies: true, redirect });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try { req.abort(); } catch {}
      finish(reject, new Error(`Request timed out: ${new URL(url).host}`));
    }, HTTP_TIMEOUT_MS);
    req.setHeader("accept", "application/json");
    if (body) req.setHeader("content-type", "application/json");
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
    let data = "";
    let bytes = 0;
    req.on("response", (res) => {
      res.on("data", (c) => {
        bytes += Buffer.byteLength(c);
        if (bytes > MAX_JSON_BYTES) {
          try { req.abort(); } catch {}
          finish(reject, new Error(`Response too large from ${new URL(url).host}`));
          return;
        }
        data += c;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`HTTP ${res.statusCode} from ${new URL(url).host}`);
          err.status = res.statusCode;
          return finish(reject, err);
        }
        try {
          finish(resolve, JSON.parse(data));
        } catch {
          finish(reject, new Error(`Non-JSON response from ${new URL(url).host}`));
        }
      });
    });
    req.on("error", (err) => finish(reject, err));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------- game flavors

// "12.0.7" → Retail, "5.5.4" → MoP Classic, "1.15.8" → Classic Era …
function flavorOfVersion(v) {
  const major = parseInt(String(v), 10);
  if (isNaN(major)) return null;
  if (major >= 6) return "Retail";
  if (major === 5) return "MoP";
  if (major === 4) return "Cata";
  if (major === 3) return "Wrath";
  if (major === 2) return "TBC";
  if (major === 1) return "Era";
  return null;
}

const FLAVOR_ORDER = ["Retail", "MoP", "Cata", "Wrath", "TBC", "Era"];

function flavorsFromVersions(versions) {
  const set = new Set();
  for (const v of versions || []) {
    const f = flavorOfVersion(v);
    if (f) set.add(f);
  }
  return FLAVOR_ORDER.filter((f) => set.has(f));
}

// A provider's declared "supported versions" arrive as either a raw Interface
// number ("110200") or a dotted client version ("11.2.0") — normalize both to
// the .toc Interface scheme so they're comparable to the client's own number.
function interfaceNumFromVersionString(v) {
  const s = String(v || "").trim();
  if (/^\d{5,6}$/.test(s)) return parseInt(s, 10);
  const m = s.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{1,2}))?/);
  if (!m) return null;
  return parseInt(m[1], 10) * 10000 + parseInt(m[2], 10) * 100 + parseInt(m[3] || "0", 10);
}

// The highest Interface number this build declares support for. Different
// flavors' version numbers land in disjoint ranges (Retail's major digit is
// always the largest in play), so no flavor filtering is needed — the max
// across every listed version is the right one to compare against a Retail
// client's Interface number.
function maxInterfaceNum(versions) {
  let max = 0;
  for (const v of versions || []) {
    const n = interfaceNumFromVersionString(v);
    if (n && n > max) max = n;
  }
  return max || null;
}

// Retail's addon API breaks at content-patch boundaries (X.Y.0 — a new
// season, a new raid tier), essentially never within one (X.Y.1, X.Y.2…
// are hotfixes). Comparing full Interface numbers would flag an addon still
// on X.Y.0 the moment Blizzard ships an X.Y.1 hotfix, which is just noise —
// so compatibility is judged by major.minor only, dropping the patch digit.
function interfaceEra(num) {
  return Math.floor(num / 100);
}

// True once the client has moved past the content-patch era this Interface
// number was built for — the case that actually needs "Load out of date
// AddOns" and can genuinely break the addon, not just a hotfix behind.
function interfaceBehindClient(num, clientNum) {
  return !!(num && clientNum && interfaceEra(num) < interfaceEra(clientNum));
}

// ---------------------------------------------------------------- curseforge

function cfDownloadUrl(fileId, fileName) {
  return `https://mediafilez.forgecdn.net/files/${Math.floor(fileId / 1000)}/${fileId % 1000}/${encodeURIComponent(fileName)}`;
}

// CurseForge releaseType: 1 = release, 2 = beta, 3 = alpha.
const CF_RELEASE_TYPE = { stable: 1, beta: 2, alpha: 3 };

function cfPickLatestFile(mod, channel = "stable", gvType = RETAIL_GAME_VERSION_TYPE) {
  const maxType = CF_RELEASE_TYPE[channel] || 1;
  const indexes = (mod.latestFilesIndexes || []).filter(
    (i) =>
      (!i.gameVersionTypeId || i.gameVersionTypeId === gvType) &&
      (i.releaseType || 1) <= maxType
  );
  // Among the channels the user allows, take the newest build rather than
  // always preferring the most stable one.
  const files = indexes
    .map((idx) => (mod.latestFiles || []).find((f) => f.id === idx.fileId))
    .filter(Boolean);
  if (files.length) {
    return files.sort((a, b) => new Date(b.fileDate || 0) - new Date(a.fileDate || 0))[0];
  }
  const allowed = (mod.latestFiles || []).filter((f) => (f.releaseType || 1) <= maxType);
  const pool = allowed.length ? allowed : mod.latestFiles || [];
  return [...pool].sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate))[0] || null;
}

// Which channels this addon actually publishes, and the build each one would
// install. Providers differ — WoWInterface and Tukui have no channels at all,
// and many CurseForge/Wago authors only ship stable — so the UI must offer
// only what really exists rather than a fixed stable/beta/alpha menu.
const CF_TYPE_TO_CHANNEL = { 1: "stable", 2: "beta", 3: "alpha" };

function cfChannelVersions(mod, gvType = RETAIL_GAME_VERSION_TYPE) {
  const out = {};
  const retailIdx = (mod.latestFilesIndexes || []).filter(
    (i) => !i.gameVersionTypeId || i.gameVersionTypeId === gvType
  );
  for (const idx of retailIdx) {
    const ch = CF_TYPE_TO_CHANNEL[idx.releaseType || 1];
    if (!ch || out[ch]) continue;
    const f = (mod.latestFiles || []).find((f) => f.id === idx.fileId);
    if (f) out[ch] = f.displayName || "";
  }
  if (!Object.keys(out).length) {
    for (const f of mod.latestFiles || []) {
      const ch = CF_TYPE_TO_CHANNEL[f.releaseType || 1];
      if (ch && !out[ch]) out[ch] = f.displayName || "";
    }
  }
  return out;
}

function cfModToResult(mod, channel = "stable", gvType = RETAIL_GAME_VERSION_TYPE) {
  const file = cfPickLatestFile(mod, channel, gvType);
  const allVersions = (mod.latestFiles || []).flatMap((f) => f.gameVersions || []);
  const channelVersions = cfChannelVersions(mod, gvType);
  return {
    provider: "curseforge",
    id: String(mod.id),
    name: mod.name,
    author: ((mod.authors || [])[0] || {}).name || "",
    summary: mod.summary || "",
    downloads: mod.downloadCount || 0,
    remoteVersion: file ? file.displayName || "" : "",
    fileDate: file ? file.fileDate || "" : "",
    downloadUrl: file ? file.downloadUrl || cfDownloadUrl(file.id, file.fileName) : null,
    pageUrl: (mod.links && mod.links.websiteUrl) || `https://www.curseforge.com/projects/${mod.id}`,
    logoUrl: (mod.logo && mod.logo.thumbnailUrl) || "",
    categories: (mod.categories || []).map((c) => c.name),
    flavors: flavorsFromVersions(allVersions),
    interfaceNum: maxInterfaceNum(allVersions),
    channelVersions,
    availableChannels: CHANNELS.filter((c) => channelVersions[c]),
  };
}

async function cfOfficial(pathname, apiKey, opts = {}) {
  try {
    return await netJson(`${CF_API}${pathname}`, {
      ...opts,
      // Never forward x-api-key through a redirect. All documented CurseForge
      // API endpoints are already canonical HTTPS URLs, so a redirect is an
      // unexpected condition rather than something authentication should follow.
      redirect: "error",
      headers: { ...(opts.headers || {}), "x-api-key": String(apiKey || "").trim() },
    });
  } catch (err) {
    if (err && (err.status === 401 || err.status === 403)) {
      const authError = new Error(
        `CurseForge rejected the API key (HTTP ${err.status}). Confirm the key and its application are approved and active in console.curseforge.com.`
      );
      authError.status = err.status;
      authError.code = "CURSEFORGE_AUTH_REJECTED";
      throw authError;
    }
    throw err;
  }
}

// Use a small authenticated endpoint to verify credentials. A syntactically
// plausible key can still be pending, disabled, or revoked, so format checks
// alone cannot predict whether CurseForge will accept it.
async function validateCurseApiKey(apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("Enter a CurseForge API key first.");
  await cfOfficial(`/games/${CF_GAME_WOW}`, key);
  return true;
}

// All check* functions return maps keyed by package key.
async function checkCurse(packages, apiKey, channelOf = () => "stable", gvType = RETAIL_GAME_VERSION_TYPE) {
  const withIds = packages.filter((p) => p.curseId && /^\d+$/.test(p.curseId));
  if (!withIds.length) return {};
  const out = {};
  // CurseForge is only accessed through its official API with the user's own
  // key — the intended, permitted use. Without a key, report that plainly
  // rather than scraping CurseForge's website (which their ToS forbids).
  if (!apiKey) {
    for (const p of withIds) out[p.key] = { provider: "curseforge", needsCurseKey: true };
    return out;
  }
  const data = await cfOfficial("/mods", apiKey, {
    method: "POST",
    body: { modIds: withIds.map((p) => Number(p.curseId)) },
  });
  const byModId = {};
  for (const mod of data.data || []) byModId[String(mod.id)] = mod;
  for (const p of withIds) if (byModId[p.curseId]) out[p.key] = cfModToResult(byModId[p.curseId], channelOf(p), gvType);
  return out;
}

const CF_PAGE_SIZE = 50;

async function searchCurse(
  query,
  apiKey,
  { categoryId, pageSize = CF_PAGE_SIZE, index = 0, sortOrder = "desc", channel = "stable", gvType = RETAIL_GAME_VERSION_TYPE } = {}
) {
  if (!apiKey) return { results: [], note: "CurseForge search needs an API key (Settings)." };
  const params = new URLSearchParams({
    gameId: String(CF_GAME_WOW),
    classId: String(CF_CLASS_ADDONS),
    pageSize: String(pageSize),
    index: String(index),
    sortField: String(CF_SORT_POPULARITY),
    sortOrder,
  });
  // The official API's text param is `searchFilter` — `filterText` is the
  // website API's name and gets silently ignored here.
  if (query) params.set("searchFilter", query);
  if (categoryId) params.set("categoryId", String(categoryId));
  params.set("gameVersionTypeId", String(gvType));
  const data = await cfOfficial(`/mods/search?${params}`, apiKey);
  return {
    results: (data.data || []).map((m) => cfModToResult(m, channel, gvType)),
    total: (data.pagination || {}).totalCount || 0,
  };
}

let cfCategoryCache = { list: null, at: 0 };
async function cfCategories(apiKey) {
  if (!apiKey) return [];
  if (cfCategoryCache.list && Date.now() - cfCategoryCache.at < 6 * 3600e3) return cfCategoryCache.list;
  const data = await cfOfficial(`/categories?gameId=${CF_GAME_WOW}&classId=${CF_CLASS_ADDONS}`, apiKey);
  const list = (data.data || [])
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  cfCategoryCache = { list, at: Date.now() };
  return list;
}

// ---------------------------------------------------------------- wago

// Try each token until one works. The token that last succeeded goes first
// on subsequent calls (and is the one downloads must use) — a stale or
// wrong-kind token in Settings must never poison downloads.
let lastGoodWagoToken = "";

// Set by main.js so the ad panel can be reloaded when Wago tokens go stale
// (the public ad token is short-lived; without this, Wago search and update
// checks silently start failing after the app has been open a while).
let wagoRefreshHook = null;
let lastWagoRefresh = 0;

function setWagoRefreshHook(fn) {
  wagoRefreshHook = fn;
}

function requestWagoRefresh() {
  if (!wagoRefreshHook) return;
  // At most one refresh per minute, no matter how many calls fail at once.
  if (Date.now() - lastWagoRefresh < 60e3) return;
  lastWagoRefresh = Date.now();
  try { wagoRefreshHook(); } catch { /* best effort */ }
}

function wagoTokenOrder(tokens) {
  return [...new Set([lastGoodWagoToken, ...(tokens || [])])].filter(Boolean);
}

// A token that just got rejected is dead — stop preferring it, and ask for
// a fresh one from the ad panel.
function noteWagoAuthFailure(token) {
  if (lastGoodWagoToken === token) lastGoodWagoToken = "";
  requestWagoRefresh();
}

async function wagoGet(pathname, tokens) {
  const usable = wagoTokenOrder(tokens);
  if (!usable.length) throw Object.assign(new Error("No Wago token yet"), { noToken: true });
  let lastErr;
  for (const token of usable) {
    try {
      const res = await netJson(`${WAGO_API}${pathname}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      lastGoodWagoToken = token;
      return res;
    } catch (err) {
      lastErr = err;
      if (err.status !== 401 && err.status !== 403) throw err;
      noteWagoAuthFailure(token);
    }
  }
  throw lastErr;
}

function channelsUpTo(channel) {
  const i = Math.max(0, CHANNELS.indexOf(channel || "stable"));
  return CHANNELS.slice(0, i + 1);
}

function wagoRelease(addon, channel = "stable") {
  const rr = addon.recent_release || addon.recent_releases || {};
  const allowed = channelsUpTo(channel)
    .map((c) => rr[c])
    .filter(Boolean);
  if (!allowed.length) return rr.stable || rr.beta || rr.alpha || null;
  // Newest of the allowed channels wins.
  return allowed.sort(
    (a, b) => new Date(b.created_at || b.date || 0) - new Date(a.created_at || a.date || 0)
  )[0];
}

function wagoChannelVersions(addon) {
  const rr = addon.recent_release || addon.recent_releases || {};
  const out = {};
  for (const c of CHANNELS) {
    const r = rr[c];
    if (r && (r.label || r.version)) out[c] = r.label || r.version;
  }
  return out;
}

function wagoToResult(addon, channel = "stable") {
  const rel = wagoRelease(addon, channel) || {};
  const patches = rel.supported_patches || (rel.patch ? [rel.patch] : null);
  return {
    flavors: patches ? flavorsFromVersions(patches) : ["Retail"],
    provider: "wago",
    id: addon.id || addon.slug || "",
    name: addon.display_name || addon.name || "",
    author:
      (Array.isArray(addon.authors) && addon.authors.join(", ")) ||
      (addon.owner && (addon.owner.display_name || addon.owner.name)) ||
      addon.author || "",
    summary: addon.summary || addon.description || "",
    downloads: addon.download_count || addon.downloads || 0,
    remoteVersion: rel.label || rel.version || "",
    fileDate: rel.created_at || rel.date || "",
    downloadUrl: rel.download_link || rel.link || null,
    pageUrl: addon.website_url || addon.url || (addon.slug ? `https://addons.wago.io/addons/${addon.slug}` : ""),
    logoUrl: addon.thumbnail_image || addon.thumbnail || "",
    categories: addon.categories || [],
    interfaceNum: maxInterfaceNum(patches),
    channelVersions: wagoChannelVersions(addon),
    availableChannels: CHANNELS.filter((c) => wagoChannelVersions(addon)[c]),
  };
}

async function wagoPost(pathname, tokens, body) {
  const usable = wagoTokenOrder(tokens);
  if (!usable.length) throw Object.assign(new Error("No Wago token yet"), { noToken: true });
  let lastErr;
  for (const token of usable) {
    try {
      const res = await netJson(`${WAGO_API}${pathname}`, {
        method: "POST",
        body,
        headers: { authorization: `Bearer ${token}` },
      });
      lastGoodWagoToken = token;
      return res;
    } catch (err) {
      lastErr = err;
      if (err.status !== 401 && err.status !== 403) throw err;
      noteWagoAuthFailure(token);
    }
  }
  throw lastErr;
}

// Check Wago the way WowUp does: fingerprint every folder and let Wago's
// _match endpoint identify them. This works even when .toc files carry
// stale or missing X-Wago-IDs, and returns releases in the same call.
// Falls back to per-id lookups for anything _match doesn't recognize.
async function checkWago(packages, tokens, addonsDir, channelOf = () => "stable", game = "retail") {
  const out = {};
  if (!packages.length) return out;

  // _match returns an array of addons, each with a `modules` map naming the
  // folders that belong to it — that is how results map back to packages.
  let matchedByFolder = {};
  const discoveredIds = {}; // pkg.key -> {wago, curseforge?, wowinterface?}
  try {
    const allFolders = packages.flatMap((p) => p.folders || []);
    const hashes = await fingerprintFolders(addonsDir, allFolders);
    const req = {
      game_version: game,
      addons: Object.entries(hashes).map(([name, hash]) => {
        const owner = packages.find((p) => (p.folders || []).includes(name)) || {};
        const a = { name, hash };
        if (owner.wagoId) a.wago = owner.wagoId;
        if (owner.curseId) a.cf = owner.curseId;
        return a;
      }),
    };
    const res = await wagoPost(`/addons/_match`, tokens, req);
    for (const addon of res.addons || []) {
      for (const folder of Object.keys(addon.modules || {})) {
        matchedByFolder[folder] = addon;
      }
    }
  } catch (err) {
    if (err.noToken) throw err;
    // _match failed entirely — per-id fallback below still runs.
  }

  const unresolved = [];
  for (const p of packages) {
    const addon = (p.folders || []).map((f) => matchedByFolder[f]).find(Boolean);
    if (addon) {
      const r = wagoToResult(addon, channelOf(p));
      if (addon.id) {
        discoveredIds[p.key] = { wago: String(addon.id) };
        if (addon.cf) discoveredIds[p.key].curseforge = String(addon.cf);
        if (addon.wowi) discoveredIds[p.key].wowinterface = String(addon.wowi);
      }
      if (r.remoteVersion) {
        out[p.key] = r;
        continue;
      }
    }
    unresolved.push(p);
  }

  await mapLimit(unresolved.filter((p) => p.wagoId), 4, async (p) => {
    try {
      const addon = await wagoGet(`/addons/${encodeURIComponent(p.wagoId)}?game_version=${game}&stability=${channelOf(p)}`, tokens);
      const r = wagoToResult(addon, channelOf(p));
      if (r.remoteVersion) out[p.key] = r;
    } catch (err) {
      out[p.key] = { provider: "wago", error: String(err.message || err) };
    }
  });

  out.__discoveredIds = discoveredIds;
  return out;
}

async function searchWago(query, tokens, channel = "stable", game = "retail") {
  try {
    const j = await wagoGet(`/addons/_search?query=${encodeURIComponent(query)}&game_version=${game}&stability=${channel}`, tokens);
    const list = j.data || j.addons || (Array.isArray(j) ? j : []);
    return { results: list.map((a) => wagoToResult(a, channel)) };
  } catch (err) {
    if (err.noToken) return { results: [], note: "Wago search connects automatically once the ad panel loads." };
    throw err;
  }
}

async function popularWago(tokens, channel = "stable", game = "retail") {
  try {
    const j = await wagoGet(`/addons/popular?game_version=${game}&stability=${channel}`, tokens);
    const list = j.data || j.addons || (Array.isArray(j) ? j : []);
    return list.map((a) => wagoToResult(a, channel));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- wowinterface

let wowiCache = { list: null, at: 0 };

async function wowiFilelist() {
  if (wowiCache.list && Date.now() - wowiCache.at < 30 * 60 * 1000) return wowiCache.list;
  const list = await netJson(`${WOWI_API}/filelist.json`);
  wowiCache = { list, at: Date.now() };
  return list;
}

function wowiToResult(f) {
  return {
    provider: "wowinterface",
    id: String(f.UID),
    name: f.UIName || "",
    author: f.UIAuthorName || "",
    summary: "",
    downloads: Number(f.UIDownloadTotal || 0),
    remoteVersion: f.UIVersion || "",
    fileDate: f.UIDate ? new Date(f.UIDate).toISOString() : "",
    downloadUrl: f.UIDownload || null, // present in filedetails, not filelist
    pageUrl: f.UIFileInfoURL || `https://www.wowinterface.com/downloads/info${f.UID}`,
    logoUrl: ((f.UIIMG_Thumbs || [])[0]) || "",
    categories: [],
    flavors: flavorsFromVersions((f.UICompatibility || []).map((c) => c.version)),
    interfaceNum: maxInterfaceNum((f.UICompatibility || []).map((c) => c.version)),
    // WoWInterface publishes one release stream — no beta/alpha channels.
    availableChannels: [],
    channelVersions: {},
  };
}

async function checkWowi(packages) {
  const withIds = packages.filter((p) => p.wowiId && /^\d+$/.test(p.wowiId));
  if (!withIds.length) return {};
  const out = {};
  try {
    const ids = withIds.map((p) => p.wowiId).join(",");
    const details = await netJson(`${WOWI_API}/filedetails/${ids}.json`);
    const byId = {};
    for (const f of details || []) byId[String(f.UID)] = wowiToResult(f);
    for (const p of withIds) if (byId[p.wowiId]) out[p.key] = byId[p.wowiId];
  } catch (err) {
    for (const p of withIds) out[p.key] = { provider: "wowinterface", error: String(err.message || err) };
  }
  return out;
}

// WoWInterface publishes its whole catalog (~8k addons) in one cached call,
// so paging is a local slice — no extra requests, and nothing is out of reach.
// WoWInterface serves ONE catalog for every game version, so filter by each
// file's declared compatibility instead of hitting a per-flavor endpoint.
async function searchWowi(query, { offset = 0, limit = CF_PAGE_SIZE, wantFlavor = "Retail" } = {}) {
  const list = await wowiFilelist();
  const q = query.toLowerCase();
  const qn = normName(query);
  const matchesFlavor = (f) => {
    const fl = flavorsFromVersions((f.UICompatibility || []).map((c) => c.version));
    return !fl.length || fl.includes(wantFlavor);
  };
  const hits = (query
    ? list.filter(
        (f) =>
          normName(f.UIName).includes(qn) ||
          (f.UIAuthorName || "").toLowerCase().includes(q)
      )
    : list
  ).filter(matchesFlavor).sort((a, b) => Number(b.UIDownloadMonthly || 0) - Number(a.UIDownloadMonthly || 0));
  return {
    results: hits.slice(offset, offset + limit).map(wowiToResult),
    total: hits.length,
    hasMore: offset + limit < hits.length,
  };
}

async function popularWowi() {
  const list = await wowiFilelist();
  return [...list]
    .sort((a, b) => Number(b.UIDownloadMonthly || 0) - Number(a.UIDownloadMonthly || 0))
    .slice(0, 30)
    .map(wowiToResult);
}

// Search results lack the download URL — resolve it on demand.
async function wowiResolveDownload(uid) {
  const details = await netJson(`${WOWI_API}/filedetails/${uid}.json`);
  const f = (details || [])[0];
  return f ? f.UIDownload || null : null;
}

// ---------------------------------------------------------------- tukui

let tukuiCache = { list: null, at: 0 };

async function tukuiAddons() {
  if (tukuiCache.list && Date.now() - tukuiCache.at < 30 * 60 * 1000) return tukuiCache.list;
  const list = await netJson(`${TUKUI_API}/addons`);
  tukuiCache = { list, at: Date.now() };
  return list;
}

function tukuiToResult(a) {
  return {
    provider: "tukui",
    id: String(a.id),
    name: a.name || a.slug || "",
    author: a.author || "",
    summary: "",
    downloads: Number(a.downloads || 0),
    remoteVersion: a.version || "",
    fileDate: a.last_update || "",
    downloadUrl: a.url || null,
    pageUrl: a.web_url || "https://tukui.org",
    logoUrl: "",
    categories: [],
    flavors: a.patch ? flavorsFromVersions([a.patch]) : ["Retail"],
    interfaceNum: a.patch ? maxInterfaceNum([a.patch]) : null,
    // Tukui publishes one release stream — no beta/alpha channels.
    availableChannels: [],
    channelVersions: {},
  };
}

async function checkTukui(packages) {
  const withIds = packages.filter((p) => p.tukuiId);
  if (!withIds.length) return {};
  const out = {};
  try {
    const list = await tukuiAddons();
    for (const p of withIds) {
      const a = (list || []).find((x) => String(x.id) === String(p.tukuiId));
      if (a) out[p.key] = tukuiToResult(a);
    }
  } catch (err) {
    for (const p of withIds) out[p.key] = { provider: "tukui", error: String(err.message || err) };
  }
  return out;
}

async function searchTukui(query) {
  const list = await tukuiAddons();
  const qn = normName(query);
  return {
    results: (list || [])
      .filter((a) => normName(a.name).includes(qn) || normName(a.slug).includes(qn))
      .map(tukuiToResult),
  };
}

// ---------------------------------------------------------------- combine

// Loose version comparison: exact match (ignoring a leading "v") or
// substring containment ("Auctionator 330" vs "330").
function isUpToDate(localVersion, remoteVersion) {
  if (!localVersion || !remoteVersion) return false;
  const norm = (v) => String(v).trim().replace(/^v/i, "").toLowerCase();
  const l = norm(localVersion);
  const r = norm(remoteVersion);
  if (l === r) return true;
  const containsWholeToken = (longer, shorter) => {
    const escaped = shorter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(longer);
  };
  return containsWholeToken(r, l) || containsWholeToken(l, r);
}

// Compare two version strings numerically. Returns 1 if remote is newer,
// -1 if remote is older, 0 if equal, null if they aren't comparable (e.g.
// different numbering schemes between providers).
function compareVersions(local, remote) {
  const nums = (v) => {
    const m = String(v || "").match(/\d+/g);
    return m ? m.map(Number) : null;
  };
  const a = nums(local);
  const b = nums(remote);
  if (!a || !b) return null;
  // Wildly different shapes (e.g. "4.19" vs a 20260707 datestamp) aren't
  // comparable — treating them as ordered produces phantom downgrades.
  const bigA = a[0] > 20000000, bigB = b[0] > 20000000;
  if (bigA !== bigB) return null;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (y > x) return 1;
    if (y < x) return -1;
  }
  return 0;
}

// Build the per-package result, refusing to present an older build as an
// "update". Providers number their builds differently, so a version that
// looks older is either a genuine downgrade or an incomparable scheme —
// neither is something to offer as an upgrade.
function updateEntry(pkg, hit) {
  const cmp = compareVersions(pkg.version, hit.remoteVersion);
  const same = isUpToDate(pkg.version, hit.remoteVersion);
  return {
    ...hit,
    upToDate: same || cmp === 0 || cmp === -1,
    remoteOlder: !same && cmp === -1,
  };
}

function wagoTokensOf(settings) {
  return [settings.wagoApiKey, settings.wagoPublicToken].filter(Boolean);
}

// Which release channel applies to this addon: a per-addon override if the
// user set one, otherwise the global default.
function channelFor(pkg, settings) {
  const per = (settings.channelChoice || {})[pkg && pkg.key];
  const chosen = per || settings.releaseChannel || "stable";
  return CHANNELS.includes(chosen) ? chosen : "stable";
}

// Which provider serves this package's updates?
// Explicit per-addon choice first; then the provider it was installed from;
// then CurseForge (works keyless); then the rest.
function effectiveProvider(pkg, settings) {
  const hasWagoAuth = wagoTokensOf(settings).length > 0;
  const usable = {
    curseforge: !!pkg.curseId,
    wago: !!pkg.wagoId && hasWagoAuth,
    wowinterface: !!pkg.wowiId,
    tukui: !!pkg.tukuiId,
  };
  const choice = (settings.providerChoice || {})[pkg.key];
  // An explicit pick is absolute — if it isn't reachable, check nothing.
  if (choice) return usable[choice] ? choice : null;
  // The provider an addon was installed from is authoritative. Providers
  // number their builds independently, so checking a Wago-installed addon
  // against CurseForge yields bogus "updates" and downgrade prompts. If that
  // provider is unreachable, report nothing rather than compare a stranger.
  if (pkg.installedVia) return usable[pkg.installedVia] ? pkg.installedVia : null;
  if (usable.curseforge) return "curseforge";
  if (usable.wago) return "wago";
  if (usable.wowinterface) return "wowinterface";
  if (usable.tukui) return "tukui";
  return null;
}

const PKG_ID_FIELD = {
  curseforge: "curseId",
  wago: "wagoId",
  wowinterface: "wowiId",
  tukui: "tukuiId",
};

async function checkUpdates(packages, settings) {
  const results = { perPackage: {}, errors: [], discoveredWagoIds: {} };
  const wagoTokens = wagoTokensOf(settings);
  const addonsDir = flavors.addonsDirFor(settings.wowPath || "", settings.flavor);
  const byProvider = { curseforge: [], wago: [], wowinterface: [], tukui: [] };
  for (const p of packages) {
    const chosen = effectiveProvider(p, settings);
    if (chosen) byProvider[chosen].push(p);
    else if (p.wagoManaged && wagoTokens.length) byProvider.wago.push(p); // no ids at all, but _match can identify it
  }

  const fetched = {};
  const jobs = [
    ["curseforge", () => checkCurse(byProvider.curseforge, settings.curseApiKey, (p) => channelFor(p, settings), cfTypeOf(settings))],
    ["wago", () => checkWago(byProvider.wago, wagoTokens, addonsDir, (p) => channelFor(p, settings), wagoGameOf(settings))],
    ["wowinterface", () => checkWowi(byProvider.wowinterface)],
    ["tukui", () => checkTukui(byProvider.tukui)],
  ];
  await Promise.all(
    jobs.map(async ([name, fn]) => {
      if (!byProvider[name].length) return;
      try {
        fetched[name] = await fn();
      } catch (err) {
        fetched[name] = {};
        results.errors.push(`${name}: ${err.message || err}`);
      }
    })
  );

  results.discoveredWagoIds = (fetched.wago || {}).__discoveredIds || {};
  if (fetched.wago) delete fetched.wago.__discoveredIds;

  for (const p of packages) {
    let chosen = effectiveProvider(p, settings);
    if (!chosen && p.wagoManaged && wagoTokens.length) chosen = "wago";
    if (!chosen) {
      if ((p.wagoId || p.wagoManaged) && !wagoTokens.length) {
        results.perPackage[p.key] = { needsWagoToken: true };
      } else if (p.installedVia === "wago") {
        results.perPackage[p.key] = { needsWagoToken: true, provider: "wago" };
      }
      continue;
    }
    const hit = (fetched[chosen] || {})[p.key];
    if (!hit) {
      if (!wagoTokens.length && (p.wagoId || p.wagoManaged)) {
        results.perPackage[p.key] = { needsWagoToken: true };
      }
      continue;
    }
    if (hit.needsCurseKey) {
      results.perPackage[p.key] = { needsCurseKey: true, provider: "curseforge" };
      continue;
    }
    if (hit.error) {
      // A 404 means the project is gone from this provider, not that the
      // request failed — worth telling the user plainly.
      const gone = /HTTP 404/.test(String(hit.error));
      // Only try another provider when we don't know where this addon came
      // from. Substituting providers on a known-source addon is what produced
      // phantom downgrade prompts.
      const pinned = p.installedVia || (settings.providerChoice || {})[p.key];
      const fallback = pinned && !gone ? null : await fallbackCheck(p, chosen, settings);
      results.perPackage[p.key] = fallback
        ? { ...fallback, wasRemovedFrom: gone ? chosen : undefined }
        : { error: hit.error, provider: chosen, removed: gone };
      continue;
    }
    results.perPackage[p.key] = updateEntry(p, hit);
  }

  // What the installed client will actually accept right now, read straight
  // from .build.info — the same number the game itself checks a .toc's
  // Interface line against, so this needs no provider or network at all.
  const clientIface = flavors.clientInterfaceFor(settings.wowPath, settings.flavor);
  if (clientIface) {
    results.clientInterface = clientIface;
    for (const p of packages) {
      if (!interfaceBehindClient((p.gameVersion || {}).num, clientIface.num)) continue;
      const entry = results.perPackage[p.key] || (results.perPackage[p.key] = {});
      entry.localInterfaceOutOfDate = true;
    }
  }

  await annotateStaleness(packages, results.perPackage, settings, clientIface);
  return results;
}

// ---------------------------------------------------------------- staleness

const STALE_DAYS = 120;      // when a build is old enough to be worth checking
const MEANINGFULLY_NEWER = 45; // how much fresher an alternate must be to flag

function daysSince(dateStr) {
  const t = Date.parse(dateStr || "");
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400e3);
}

// Authors move hosts: an addon can sit untouched on CurseForge for a year
// while its Wago listing gets weekly builds. Checking every alternate every
// time would be wasteful, so only investigate addons whose active provider
// already looks stale, or whose active build is behind what the client will
// accept — usually a handful. Both questions are answered from the same
// alternate-provider fetch rather than two passes.
async function annotateStaleness(packages, perPackage, settings, clientIface) {
  const candidates = [];
  for (const p of packages) {
    const u = perPackage[p.key];
    if (!u || u.error || u.needsWagoToken || u.needsCurseKey) continue;
    const behindClient = !!(clientIface && interfaceBehindClient(u.interfaceNum, clientIface.num));
    if (behindClient) u.remoteInterfaceBehind = true;
    const age = daysSince(u.fileDate);
    const ageStale = age !== null && age >= STALE_DAYS;
    if (!ageStale && !behindClient) continue;
    if (age !== null) u.buildAgeDays = age;
    const alternates = (p.sources || []).filter(
      (s) => s !== u.provider && p[PKG_ID_FIELD[s]] && (s !== "wago" || wagoTokensOf(settings).length)
    );
    if (alternates.length) candidates.push({ p, u, alternates, behindClient, ageStale });
    else {
      if (behindClient) u.brokenEverywhere = true;
      if (ageStale) u.staleEverywhere = true; // only one source, and it's gone quiet
    }
  }

  // Age-staleness and interface-incompatibility are independent questions —
  // a candidate can qualify via either one, so each outcome below is gated on
  // the flag that actually earned it a look, not on whether the other one held.
  await mapLimit(candidates, 3, async ({ p, u, alternates, behindClient, ageStale }) => {
    let best = null;
    let fix = null;
    for (const prov of alternates) {
      try {
        const r = await resolveInstall(prov, p[PKG_ID_FIELD[prov]], settings, channelFor(p, settings));
        if (!r || !r.remoteVersion) continue;
        const age = daysSince(r.fileDate);
        if (age !== null && (!best || age < best.age)) best = { provider: prov, age, result: r };
        if (behindClient && !fix && r.interfaceNum && !interfaceBehindClient(r.interfaceNum, clientIface.num)) {
          fix = { provider: prov, remoteVersion: r.remoteVersion, downloadUrl: r.downloadUrl, id: r.id };
        }
      } catch {
        /* alternate unreachable — nothing to suggest from it */
      }
    }
    if (behindClient) {
      if (fix) u.fixedElsewhere = fix;
      else u.brokenEverywhere = true;
    }

    if (!ageStale) return; // this candidate was only here for the compat check above

    if (!best) {
      u.staleEverywhere = true;
      return;
    }
    if (u.buildAgeDays - best.age >= MEANINGFULLY_NEWER) {
      u.betterElsewhere = {
        provider: best.provider,
        remoteVersion: best.result.remoteVersion,
        ageDays: best.age,
        downloadUrl: best.result.downloadUrl,
        id: best.result.id,
      };
    } else {
      u.staleEverywhere = true;
    }
  });
}

async function fallbackCheck(pkg, failedProvider, settings) {
  for (const prov of ["curseforge", "wago", "wowinterface", "tukui"]) {
    if (prov === failedProvider || !pkg[PKG_ID_FIELD[prov]]) continue;
    try {
      const r = await resolveInstall(prov, pkg[PKG_ID_FIELD[prov]], settings, channelFor(pkg, settings));
      if (r && r.remoteVersion) return updateEntry(pkg, r);
    } catch {
      /* keep trying */
    }
  }
  return null;
}

// Full details for one addon on one provider — used by installs, provider
// switching, and per-addon fallback checks.
async function resolveInstall(provider, id, settings, channel = "stable") {
  if (provider === "curseforge") {
    if (!settings.curseApiKey) {
      throw new Error("A CurseForge API key is required (add it in Settings — free at console.curseforge.com)");
    }
    const data = await cfOfficial(`/mods/${id}`, settings.curseApiKey);
    return cfModToResult(data.data, channel, cfTypeOf(settings));
  }
  if (provider === "wago") {
    const addon = await wagoGet(`/addons/${encodeURIComponent(id)}?game_version=${wagoGameOf(settings)}&stability=${channel}`, wagoTokensOf(settings));
    return wagoToResult(addon, channel);
  }
  if (provider === "wowinterface") {
    const details = await netJson(`${WOWI_API}/filedetails/${id}.json`);
    return details && details[0] ? wowiToResult(details[0]) : null;
  }
  if (provider === "tukui") {
    const list = await tukuiAddons();
    const a = (list || []).find((x) => String(x.id) === String(id));
    return a ? tukuiToResult(a) : null;
  }
  throw new Error(`Unknown provider ${provider}`);
}

// ---------------------------------------------------------------- search

function normName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Small Levenshtein with early exit — for typo tolerance ("detials" → details).
function editDistance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    let rowMin = dp[0];
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
      if (dp[j] < rowMin) rowMin = dp[j];
    }
    if (rowMin > max) return max + 1;
  }
  return dp[b.length];
}

// Lower is better. Token-aware and typo-tolerant; 9 = junk (provider fuzzy
// filler that has nothing to do with the query).
function relevance(result, ql, qn, qTokens) {
  if (!ql) return 3;
  const name = (result.name || "").toLowerCase();
  const nn = normName(name);
  if (name === ql || nn === qn) return 0;
  if (nn.startsWith(qn)) return 1;
  const nameTokens = name.split(/[^a-z0-9]+/).filter(Boolean);
  // every query word matches the start of some word in the name ("weak au" → WeakAuras)
  if (qTokens.length && qTokens.every((t) => nameTokens.some((w) => w.startsWith(t)))) return 1.5;
  if (nn.includes(qn)) return 2;
  if (qTokens.length && qTokens.every((t) => nn.includes(t))) return 2.2;
  // typo on the whole query vs the front of the name
  if (qn.length >= 4 && editDistance(qn, nn.slice(0, qn.length + 2), 2) <= (qn.length >= 7 ? 2 : 1)) return 2.5;
  // typo on individual words ("detials" → "details")
  if (
    qTokens.some(
      (t) =>
        t.length >= 4 &&
        nameTokens.some((w) => editDistance(t, w, 2) <= (t.length >= 7 ? 2 : 1))
    )
  ) return 2.7;
  // at least half the query words appear somewhere
  if (qTokens.length > 1 && qTokens.filter((t) => nn.includes(t)).length >= Math.ceil(qTokens.length / 2)) return 3;
  if ((result.author || "").toLowerCase().includes(ql)) return 3.5;
  return 9;
}

// When a query finds nothing (usually a typo — provider search is exact),
// fuzzy-score it against every catalog we can get locally: WoWInterface's
// full file list, Tukui's list, and a cached page of CurseForge populars.
let cfPopCache = { list: null, at: 0 };

async function cfPopularList(apiKey) {
  if (!apiKey) return [];
  if (cfPopCache.list && Date.now() - cfPopCache.at < 30 * 60 * 1000) return cfPopCache.list;
  const r = await searchCurse("", apiKey, { pageSize: 50 });
  cfPopCache = { list: r.results || [], at: Date.now() };
  return cfPopCache.list;
}

async function typoCandidates(settings, ql, qn, qTokens) {
  const cands = [];
  try { cands.push(...((await wowiFilelist()) || []).map(wowiToResult)); } catch {}
  try { cands.push(...((await tukuiAddons()) || []).map(tukuiToResult)); } catch {}
  try { cands.push(...(await cfPopularList(settings.curseApiKey))); } catch {}
  for (const r of cands) r.__score = relevance(r, ql, qn, qTokens);
  return cands
    .filter((r) => r.__score < 9)
    .sort((a, b) => a.__score - b.__score || (b.downloads || 0) - (a.downloads || 0))
    .slice(0, 15);
}

// WoWInterface and Tukui publish their entire catalog in one cached call, so
// every result can be cross-referenced against them for free. Without this a
// CurseForge-sourced row never reveals that Wago/WoWI/Tukui also carry it —
// which is why category browsing looked CurseForge-only.
async function enrichWithLocalCatalogs(results) {
  if (!results.length) return results;
  const index = new Map(); // normalized name -> [result-shaped entries]
  const add = (r) => {
    const k = normName(r.name);
    if (!k) return;
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(r);
  };
  try { ((await wowiFilelist()) || []).map(wowiToResult).forEach(add); } catch { /* offline */ }
  try { ((await tukuiAddons()) || []).map(tukuiToResult).forEach(add); } catch { /* offline */ }
  if (!index.size) return results;

  for (const r of results) {
    const extra = index.get(normName(r.name));
    if (!extra) continue;
    r.providers = r.providers || [{ provider: r.provider, id: r.id, remoteVersion: r.remoteVersion, downloadUrl: r.downloadUrl, pageUrl: r.pageUrl, downloads: r.downloads || 0 }];
    for (const e of extra) {
      if (r.providers.some((x) => x.provider === e.provider)) continue;
      r.providers.push({
        provider: e.provider,
        id: e.id,
        remoteVersion: e.remoteVersion,
        downloadUrl: e.downloadUrl,
        pageUrl: e.pageUrl,
        downloads: e.downloads || 0,
      });
      if (!r.logoUrl && e.logoUrl) r.logoUrl = e.logoUrl;
    }
  }
  return results;
}

// Category names differ between providers ("Boss Encounters" vs "Boss Mods"),
// so match loosely rather than demanding an exact string.
function categoryMatches(result, categoryName) {
  const want = String(categoryName || "").toLowerCase();
  if (!want) return true;
  return (result.categories || []).some((c) => {
    const have = String(c).toLowerCase();
    return have === want || have.includes(want) || want.includes(have);
  });
}

// The same addon usually exists on several providers — collapse to one row
// per addon. The primary entry is the one with a direct download and the
// most downloads; the rest ride along in `providers`.
function mergeResults(results) {
  const entryOf = (r) => ({
    provider: r.provider,
    id: r.id,
    remoteVersion: r.remoteVersion,
    downloadUrl: r.downloadUrl,
    pageUrl: r.pageUrl,
    downloads: r.downloads || 0,
  });
  const better = (a, b) => {
    if (!!a.downloadUrl !== !!b.downloadUrl) return a.downloadUrl ? a : b;
    return (a.downloads || 0) >= (b.downloads || 0) ? a : b;
  };
  const map = new Map();
  for (const r of results) {
    const k = normName(r.name);
    if (!k) continue;
    const cur = map.get(k);
    if (!cur) {
      map.set(k, { ...r, providers: [entryOf(r)] });
      continue;
    }
    // Same mod can arrive twice (e.g. both spellings of a compacted query).
    if (cur.providers.some((e) => e.provider === r.provider && String(e.id) === String(r.id))) {
      cur.__score = Math.min(cur.__score ?? 9, r.__score ?? 9);
      continue;
    }
    cur.providers.push(entryOf(r));
    cur.__score = Math.min(cur.__score ?? 9, r.__score ?? 9);
    cur.downloads = Math.max(cur.downloads || 0, r.downloads || 0);
    cur.flavors = [...new Set([...(cur.flavors || []), ...(r.flavors || [])])];
    if (!cur.logoUrl && r.logoUrl) cur.logoUrl = r.logoUrl;
    if (!cur.summary && r.summary) cur.summary = r.summary;
    // Re-pick the primary provider fields if this one is better.
    const best = better(cur, r);
    if (best === r) {
      for (const f of ["provider", "id", "remoteVersion", "downloadUrl", "pageUrl"]) cur[f] = r[f];
    }
  }
  return [...map.values()];
}

// CurseForge refuses index + pageSize beyond 10,000. Sorting the other way
// exposes a second 10k window from the opposite end of the same result set,
// which roughly doubles reach; within a category (all are well under 10k)
// nothing is out of reach at all.
const CF_INDEX_CAP = 10000;

function emptyCursor() {
  return { cfIndex: 0, cfOrder: "desc", cfDone: false, wowiOffset: 0, wowiDone: false };
}

// `cursor` tracks each provider's position independently; `carryRaw` holds the
// un-merged results from previous pages so the merged list stays correct as
// pages accumulate (an addon can appear on page 1 via Wago and page 3 via CF).
async function search(
  query,
  settings,
  { categoryId, categoryName, cursor, carryRaw = [] } = {}
) {
  const out = { results: [], notes: [], errors: [] };
  const q = String(query || "").trim();
  const cur = { ...emptyCursor(), ...(cursor || {}) };
  const index = cur.cfIndex;
  // Browsing has no per-addon context yet, so the global default applies.
  const browseChannel = channelFor(null, settings);
  // Providers treat spaces as hard word boundaries, so "craft sim" misses
  // "CraftSim" — query the compacted form too and let merging dedupe.
  const qCompact = q.replace(/[\s-_]+/g, "");
  const cfSearch = async () => {
    if (cur.cfDone) return { results: [], total: 0 };
    const r1 = await searchCurse(q, settings.curseApiKey, {
      categoryId,
      index: cur.cfIndex,
      sortOrder: cur.cfOrder,
      channel: browseChannel,
      gvType: cfTypeOf(settings),
    });
    let results = r1.results || [];
    // The compacted spelling ("craft sim" → "craftsim") only matters for the
    // first page; later pages are pure continuations of the main query.
    if (cur.cfIndex === 0 && cur.cfOrder === "desc" && qCompact.toLowerCase() !== q.toLowerCase()) {
      try {
        const r2 = await searchCurse(qCompact, settings.curseApiKey, { categoryId, gvType: cfTypeOf(settings) });
        results = [...results, ...(r2.results || [])];
      } catch { /* variant is best-effort */ }
    }

    // Advance the cursor: walk this sort direction to the API's ceiling, then
    // flip direction to reach the far end of the same result set.
    const total = r1.total || 0;
    const pageWasFull = (r1.results || []).length >= CF_PAGE_SIZE;
    const next = cur.cfIndex + CF_PAGE_SIZE;
    const reachedEnd = !pageWasFull || (total && next >= total);
    const reachedCap = next + CF_PAGE_SIZE > CF_INDEX_CAP;
    if (reachedEnd) {
      cur.cfDone = true;
    } else if (reachedCap) {
      if (cur.cfOrder === "desc" && total >= CF_INDEX_CAP) {
        cur.cfOrder = "asc";
        cur.cfIndex = 0;
      } else {
        cur.cfDone = true;
      }
    } else {
      cur.cfIndex = next;
    }
    return { ...r1, results };
  };

  const wowiSearch = async () => {
    // WoWInterface has no category index, so in category mode its rows would
    // be fetched only to be filtered out. Its catalog is still consulted via
    // enrichWithLocalCatalogs(), which attaches it to matching CF results.
    if (categoryId) {
      cur.wowiDone = true;
      return { results: [] };
    }
    if (cur.wowiDone) return { results: [] };
    const r = await searchWowi(q, { offset: cur.wowiOffset, wantFlavor: flavors.byId(settings.flavor).wowiFlavor });
    cur.wowiOffset += CF_PAGE_SIZE;
    if (!r.hasMore) cur.wowiDone = true;
    return r;
  };

  // Wago's API ignores page/limit params — it returns its top ~20 matches and
  // nothing more, so it only contributes on the first page. Tukui's catalog is
  // two addons. CurseForge and WoWInterface are the ones that actually page.
  const firstPage = cur.cfIndex === 0 && cur.cfOrder === "desc" && cur.wowiOffset === 0;
  const jobs = [
    ["CurseForge", cfSearch],
    ["WoWInterface", wowiSearch],
    ...(firstPage
      ? [
          [
            "Wago",
            async () =>
              q
                ? await searchWago(q, wagoTokensOf(settings), browseChannel, wagoGameOf(settings))
                : { results: await popularWago(wagoTokensOf(settings), browseChannel, wagoGameOf(settings)) },
          ],
          // Tukui publishes retail builds only, so it contributes nothing elsewhere.
          ...(flavors.byId(settings.flavor).tukui
            ? [["Tukui", async () => (q ? searchTukui(q) : { results: (await tukuiAddons()).map(tukuiToResult) })]]
            : []),
        ]
      : []),
  ];
  let cfTotal = 0;
  let wowiTotal = 0;
  await Promise.all(
    jobs.map(async ([label, fn]) => {
      try {
        const r = await fn();
        if (r.note) out.notes.push(r.note);
        out.results.push(...(r.results || []));
        if (label === "CurseForge") cfTotal = r.total || 0;
        if (label === "WoWInterface") wowiTotal = r.total || 0;
      } catch (err) {
        out.errors.push(`${label}: ${err.message || err}`);
      }
    })
  );

  // Keep the raw (un-merged) results so the next page can re-merge against
  // everything fetched so far, and report whether more remain upstream.
  out.results = [...carryRaw, ...out.results];
  out.cursor = cur;
  out.hasMore = !cur.cfDone || !cur.wowiDone;
  // CurseForge caps its reported total at 10,000 even when more exist; the
  // combined figure is the honest "at least this many".
  out.total = (cfTotal || 0) + (wowiTotal || 0);

  const ql = q.toLowerCase();
  const qn = normName(q);
  const qTokens = ql.split(/[^a-z0-9]+/).filter(Boolean);
  for (const r of out.results) r.__score = relevance(r, ql, qn, qTokens);

  // Nothing at all? Assume a typo and fuzzy-match the local catalogs.
  if (ql && !out.results.length) {
    const alt = await typoCandidates(settings, ql, qn, qTokens);
    out.results = alt;
    if (alt.length) out.notes.push(`No exact matches for “${q}” — showing the closest names.`);
  }

  out.raw = out.results;
  out.results = mergeResults(out.results);

  // Category narrowing runs AFTER merging so an addon that passes
  // CurseForge's category filter keeps its Wago/WoWInterface install options.
  // CurseForge is the only provider with a queryable category catalog, so it
  // decides membership; results from other providers stay if their own
  // category labels agree.
  if (categoryName) {
    out.results = out.results.filter(
      (r) =>
        (r.providers || [r]).some((e) => e.provider === "curseforge") ||
        categoryMatches(r, categoryName)
    );
  }

  // Attach every other provider that carries these addons, so the rows show
  // real cross-provider choices instead of looking single-sourced.
  await enrichWithLocalCatalogs(out.results);

  // Exact and prefix matches share a tier so download counts decide between
  // them — typing "dbm" should surface Deadly Boss Mods, not a tiny addon
  // that happens to be named exactly "dbm". Weak name matches (score 9,
  // matched via description server-side) rank last but are never dropped.
  const tier = (s) => (s <= 1 ? 1 : s);
  out.results.sort(
    (a, b) => tier(a.__score ?? 9) - tier(b.__score ?? 9) || (b.downloads || 0) - (a.downloads || 0)
  );
  return out;
}

// ---------------------------------------------------------------- matching

// Find this installed package on providers its .toc doesn't mention, by
// exact normalized-name match. Results are cached by the caller.
async function matchProviders(pkg, settings) {
  const found = {};
  const target = normName(pkg.name);
  const have = new Set(pkg.sources || []);

  const tryMatch = (results, provider) => {
    const hit = (results || []).find((r) => normName(r.name) === target);
    if (hit) found[provider] = String(hit.id);
  };

  const jobs = [];
  if (!have.has("curseforge") && settings.curseApiKey) {
    jobs.push(searchCurse(pkg.name, settings.curseApiKey, { pageSize: 10, gvType: cfTypeOf(settings) })
      .then((r) => tryMatch(r.results, "curseforge")).catch(() => {}));
  }
  if (!have.has("wago") && wagoTokensOf(settings).length) {
    // Flavor-scoped like the CurseForge branch above — an unscoped search hits
    // the retail catalog and can match a retail-only addon by name, which then
    // persists into settings.matchedIds as a wrong id for this client.
    jobs.push(searchWago(pkg.name, wagoTokensOf(settings), channelFor(pkg, settings), wagoGameOf(settings))
      .then((r) => tryMatch(r.results, "wago")).catch(() => {}));
  }
  if (!have.has("wowinterface")) {
    jobs.push(searchWowi(pkg.name, { limit: 10 })
      .then((r) => tryMatch(r.results, "wowinterface")).catch(() => {}));
  }
  if (!have.has("tukui")) {
    jobs.push(searchTukui(pkg.name)
      .then((r) => tryMatch(r.results, "tukui")).catch(() => {}));
  }
  await Promise.all(jobs);
  return found;
}

// Wago downloads require the token as a query parameter (WowUp's
// getDownloadAuth does the same). Prefer the token that API calls actually
// succeeded with — the ad-panel token when the Settings one is invalid.
function wagoDownloadUrl(url, settings) {
  const token = lastGoodWagoToken || settings.wagoPublicToken || settings.wagoApiKey;
  if (!token || !url) return url;
  const u = new URL(url);
  u.searchParams.set("token", token);
  return u.toString();
}

module.exports = {
  checkUpdates,
  search,
  resolveInstall,
  matchProviders,
  cfCategories,
  validateCurseApiKey,
  wowiResolveDownload,
  wagoDownloadUrl,
  setWagoRefreshHook,
  _test: { isUpToDate, compareVersions, interfaceNumFromVersionString, maxInterfaceNum, interfaceBehindClient, annotateStaleness },
};
