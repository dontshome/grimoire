// WoW game flavors (Retail, Classic Era, MoP Classic, PTRs, Beta).
//
// Each flavor maps a client folder under the WoW root to the identifiers each
// provider uses for it:
//   cfTypeId   — CurseForge gameVersionTypeId (from /v1/games/1/version-types)
//   wago       — Wago's game_version value (their client uses retail/mop/classic)
//   tocSuffix  — the .toc suffixes Blizzard uses for that client, best first
//   wowiFlavor — matches the flavor labels we derive from WoWInterface's
//                per-file compatibility list (WoWI serves one catalog)
//
// NOTE: "_classic_" tracks Blizzard's *current* progression season. It is MoP
// Classic as of 2026; when Blizzard advances it, update cfTypeId/wago/tocSuffix
// here and nothing else needs to change.

const fs = require("fs");
const path = require("path");

const FLAVORS = [
  {
    id: "retail", dir: "_retail_", name: "Retail",
    cfTypeId: 517, wago: "retail", tukui: true, wowiFlavor: "Retail",
    tocSuffix: ["Mainline"],
  },
  {
    id: "classic_era", dir: "_classic_era_", name: "Classic Era",
    cfTypeId: 67408, wago: "classic", tukui: false, wowiFlavor: "Era",
    tocSuffix: ["Vanilla", "Classic"],
  },
  {
    // The 20th Anniversary / Fresh Classic client. Vanilla 1.15.x, so it uses
    // the same addon builds as Classic Era on every provider.
    id: "anniversary", dir: "_anniversary_", name: "Classic Anniversary",
    cfTypeId: 67408, wago: "classic", tukui: false, wowiFlavor: "Era",
    tocSuffix: ["Vanilla", "Classic"],
  },
  {
    id: "anniversary_ptr", dir: "_anniversary_ptr_", name: "Classic Anniversary PTR",
    cfTypeId: 67408, wago: "classic", tukui: false, wowiFlavor: "Era",
    tocSuffix: ["Vanilla", "Classic"],
  },
  {
    id: "classic", dir: "_classic_", name: "MoP Classic",
    cfTypeId: 79434, wago: "mop", tukui: false, wowiFlavor: "MoP",
    tocSuffix: ["Mists"],
  },
  {
    id: "ptr", dir: "_ptr_", name: "Retail PTR",
    cfTypeId: 517, wago: "retail", tukui: true, wowiFlavor: "Retail",
    tocSuffix: ["Mainline"],
  },
  {
    id: "xptr", dir: "_xptr_", name: "Retail XPTR",
    cfTypeId: 517, wago: "retail", tukui: true, wowiFlavor: "Retail",
    tocSuffix: ["Mainline"],
  },
  {
    id: "beta", dir: "_beta_", name: "Retail Beta",
    cfTypeId: 517, wago: "retail", tukui: true, wowiFlavor: "Retail",
    tocSuffix: ["Mainline"],
  },
  {
    id: "classic_ptr", dir: "_classic_ptr_", name: "MoP Classic PTR",
    cfTypeId: 79434, wago: "mop", tukui: false, wowiFlavor: "MoP",
    tocSuffix: ["Mists"],
  },
  {
    id: "classic_beta", dir: "_classic_beta_", name: "MoP Classic Beta",
    cfTypeId: 79434, wago: "mop", tukui: false, wowiFlavor: "MoP",
    tocSuffix: ["Mists"],
  },
  {
    id: "classic_era_ptr", dir: "_classic_era_ptr_", name: "Classic Era PTR",
    cfTypeId: 67408, wago: "classic", tukui: false, wowiFlavor: "Era",
    tocSuffix: ["Vanilla", "Classic"],
  },
];

// Other CurseForge version types we may see on files but that have no live
// client folder — used only so an addon's supported-versions list reads right.
const CF_TYPE_NAMES = {
  517: "Retail",
  67408: "Classic Era",
  73246: "TBC Classic",
  73713: "Wrath Classic",
  77522: "Cataclysm Classic",
  79434: "MoP Classic",
  81212: "Wrath Titan",
};

const byId = (id) => FLAVORS.find((f) => f.id === id) || FLAVORS[0];

// Blizzard's TACT product code for each flavor's row in .build.info. Only
// codes confirmed from Blizzard's own build metadata are listed — flavors
// left unmapped (xptr, the anniversary clients) simply get no client-version
// check rather than a guessed, possibly-wrong one.
const BUILD_INFO_PRODUCT = {
  retail: "wow",
  ptr: "wowt",
  beta: "wow_beta",
  classic: "wow_classic",
  classic_ptr: "wow_classic_ptr",
  classic_beta: "wow_classic_beta",
  classic_era: "wow_classic_era",
  classic_era_ptr: "wow_classic_era_ptr",
};

// "11.2.0.58224" -> 110200, the same Interface-number scheme .toc files use
// (major*10000 + minor*100 + patch).
function interfaceFromClientVersion(v) {
  const m = String(v || "").match(/^(\d{1,2})\.(\d{1,2})\.(\d{1,2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 10000 + parseInt(m[2], 10) * 100 + parseInt(m[3], 10);
}

// The WoW root's .build.info lists every installed product as a pipe-delimited
// table (one row per client, headers on row 1). This is Blizzard's own record
// of what's actually installed — the same source the client itself would use
// to know its version, so comparing against it tells us exactly what the game
// will accept, no network round-trip required.
function readBuildInfo(wowRoot) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(wowRoot, ".build.info"), "utf8");
  } catch {
    return [];
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  // Header cells look like "Product!STRING:0" — only the name before "!" matters.
  const headers = lines[0].split("|").map((h) => h.split("!")[0].trim());
  return lines.slice(1).map((line) => {
    const cells = line.split("|");
    const row = {};
    headers.forEach((h, i) => (row[h] = cells[i]));
    return row;
  });
}

// The exact Interface number the installed client for this flavor will
// accept right now, or null if the flavor has no known product code or the
// client hasn't been installed/updated yet.
function clientInterfaceFor(wowRoot, flavorId) {
  const product = BUILD_INFO_PRODUCT[flavorId];
  if (!product || !wowRoot) return null;
  const rows = readBuildInfo(wowRoot);
  const row = rows.find((r) => r.Product === product);
  if (!row || !row.Version) return null;
  const num = interfaceFromClientVersion(row.Version);
  if (!num) return null;
  return { num, version: row.Version, label: `${Math.floor(num / 10000)}.${Math.floor((num % 10000) / 100)}.${num % 100}` };
}

function addonsDirFor(wowRoot, flavorId) {
  return path.join(wowRoot, byId(flavorId).dir, "Interface", "AddOns");
}

// Which flavors are actually installed under this WoW root. A client counts as
// installed if it has an AddOns folder OR a game executable — a freshly
// installed client has no Interface/AddOns until it's been launched once, and
// we still want to manage it (the folder is created on demand at install time).
function detectFlavors(wowRoot) {
  if (!wowRoot) return [];
  return FLAVORS.filter((f) => {
    const clientDir = path.join(wowRoot, f.dir);
    try {
      if (fs.existsSync(path.join(clientDir, "Interface", "AddOns"))) return true;
      return fs
        .readdirSync(clientDir)
        .some((n) => /^wow.*\.exe$/i.test(n) && !/^BlizzardError/i.test(n));
    } catch {
      return false;
    }
  }).map((f) => ({ id: f.id, name: f.name, dir: f.dir }));
}

// Create the AddOns folder if the client has never made one.
function ensureAddonsDir(wowRoot, flavorId) {
  const dir = addonsDirFor(wowRoot, flavorId);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* permissions */ }
  return dir;
}

// Accepts either a WoW root or a client folder (…/World of Warcraft/_retail_)
// and returns the root, so old settings that pointed at _retail_ still work.
function normalizeRoot(p) {
  if (!p) return "";
  const base = path.basename(p);
  if (/^_.*_$/.test(base)) return path.dirname(p);
  return p;
}

module.exports = { FLAVORS, CF_TYPE_NAMES, byId, addonsDirFor, ensureAddonsDir, detectFlavors, normalizeRoot, clientInterfaceFor };
