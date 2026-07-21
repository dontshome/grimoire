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

module.exports = { FLAVORS, CF_TYPE_NAMES, byId, addonsDirFor, ensureAddonsDir, detectFlavors, normalizeRoot };
