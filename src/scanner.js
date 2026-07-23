const fs = require("fs");
const path = require("path");

// Strip WoW UI escape sequences from .toc strings: |cffab34cd...|r colors,
// |TInterface\...|t textures, and stray pipes.
function stripWowCodes(s) {
  if (!s) return s;
  return s
    .replace(/\|c[0-9a-fA-F]{8}/g, "")
    .replace(/\|r/g, "")
    .replace(/\|T[^|]*\|t/g, "")
    .trim();
}

// Blizzard suffixes .toc files per client: Foo_Mainline.toc (retail),
// Foo_Vanilla.toc (Classic Era), Foo_Mists.toc (MoP Classic), and so on. Pick
// the one matching the flavor being scanned, then fall back to the plain .toc.
function findToc(dir, folderName, tocSuffix = ["Mainline"]) {
  const preferred = [];
  for (const suffix of tocSuffix) {
    preferred.push(`${folderName}_${suffix}.toc`, `${folderName}-${suffix}.toc`);
  }
  preferred.push(`${folderName}.toc`);
  for (const name of preferred) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  try {
    const any = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith(".toc"));
    return any ? path.join(dir, any) : null;
  } catch {
    return null;
  }
}

function parseToc(tocPath) {
  const meta = {};
  let raw;
  try {
    raw = fs.readFileSync(tocPath, "utf8");
  } catch {
    return meta;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^##\s*([^:]+?)\s*:\s*(.*)$/);
    if (m) meta[m[1].toLowerCase()] = m[2].trim();
  }
  return meta;
}

// The Wago App writes a ".wago" marker ({"version":"..."}) into every folder
// it installs — the most reliable signal that an addon is Wago-managed, and
// the exact version string the app installed.
function readWagoMarker(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, ".wago"), "utf8"));
    return j && j.version ? String(j.version) : "";
  } catch {
    return "";
  }
}

// Grimoire's own install marker: { provider, id, version, at }.
function readGrimoireMarker(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, ".grimoire"), "utf8"));
    return j && j.provider ? j : null;
  } catch {
    return null;
  }
}

function readFolder(addonsDir, folderName, tocSuffix) {
  const dir = path.join(addonsDir, folderName);
  const tocPath = findToc(dir, folderName, tocSuffix);
  if (!tocPath) return null;
  const meta = parseToc(tocPath);
  return {
    wagoFileVersion: readWagoMarker(dir),
    grimoireMarker: readGrimoireMarker(dir),
    folder: folderName,
    title: stripWowCodes(meta["title"]) || folderName,
    notes: stripWowCodes(meta["notes"]) || "",
    version: stripWowCodes(meta["version"]) || "",
    author: stripWowCodes(meta["author"]) || "",
    interface: meta["interface"] || "",
    category: meta["x-category"] || meta["category"] || "",
    website: meta["x-website"] || meta["x-url"] || "",
    curseId: meta["x-curse-project-id"] || "",
    wagoId: meta["x-wago-id"] || "",
    tukuiId: meta["x-tukui-projectid"] || "",
    wowiId: meta["x-wowi-id"] || "",
    partOf: meta["x-part-of"] || "",
    deps: (meta["requireddeps"] || meta["dependencies"] || meta["dependency"] || "")
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean),
  };
}

// A sub-folder carrying its own provider id that the candidate parent
// doesn't share is a separate addon that just squats on the parent's name
// (ElvUI_WindTools vs ElvUI, DBM-PvP vs DBM-Core). No id of its own, or the
// same id as the parent, means it's genuinely part of that parent.
function belongsTo(info, parent) {
  const ownId = info.curseId || info.wagoId;
  const parentId = parent.curseId || parent.wagoId;
  return !(ownId && ownId !== parentId);
}

// The name segment before the first "-" or "_", e.g. "DBM" from both
// "DBM-Core" and "DBM_StatusBarTimers". Used to keep dependency-chain
// grouping inside one addon family — without it, an addon with no provider
// id of its own that happens to depend on some unrelated standalone shared
// library folder would get silently folded into that library's package.
function familyToken(folder) {
  const m = folder.match(/^[^-_]+/);
  return m ? m[0] : folder;
}

// Decide which folder a sub-folder belongs to, one hop up. "BigWigs_Plugins"
// belongs to "BigWigs" (underscore-prefix convention); DBM's many hyphenated
// modules (DBM-Test-Dungeons, DBM-Challenges, ...) instead declare their real
// parent via RequiredDeps/Dependencies, so that's checked too, gated to the
// same name family so it can't cross into an unrelated dependency.
function parentKeyOf(info, byFolder) {
  if (info.partOf && byFolder[info.partOf]) return info.partOf;

  const idx = info.folder.indexOf("_");
  if (idx > 0) {
    const prefix = info.folder.slice(0, idx);
    const parent = byFolder[prefix];
    if (parent && belongsTo(info, parent)) return prefix;
  }

  const family = familyToken(info.folder);
  for (const dep of info.deps || []) {
    if (dep === info.folder) continue;
    const parent = byFolder[dep];
    if (parent && familyToken(dep) === family && belongsTo(info, parent)) return dep;
  }
  return null;
}

// Follow parentKeyOf hop by hop to the ultimate root (DBM-Test-Dungeons ->
// DBM-Test -> DBM-Core), so multi-level dependency chains collapse into one
// package keyed by whichever folder turns out not to belong to anything else.
function resolveRoot(name, byFolder) {
  const seen = new Set();
  let cur = name;
  while (!seen.has(cur)) {
    seen.add(cur);
    const info = byFolder[cur];
    if (!info) break;
    const parent = parentKeyOf(info, byFolder);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  return cur;
}

// "110207, 120007" -> { num: 120007, label: "12.0.7" } (highest listed).
function parseInterfaceVersion(interfaceField) {
  const nums = String(interfaceField)
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0);
  if (!nums.length) return { num: 0, label: "" };
  const n = Math.max(...nums);
  return {
    num: n,
    label: `${Math.floor(n / 10000)}.${Math.floor((n % 10000) / 100)}.${n % 100}`,
  };
}

function scan(addonsDir, tocSuffix = ["Mainline"]) {
  const started = Date.now();
  let entries;
  try {
    entries = fs
      .readdirSync(addonsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch (err) {
    return { error: String(err), packages: [] };
  }

  const byFolder = {};
  for (const name of entries) {
    const info = readFolder(addonsDir, name, tocSuffix);
    if (info) byFolder[name] = info;
  }

  // Group folders into packages.
  const packages = {};
  for (const name of Object.keys(byFolder)) {
    const key = resolveRoot(name, byFolder);
    if (!packages[key]) packages[key] = { key, folders: [] };
    packages[key].folders.push(byFolder[name]);
  }

  const result = [];
  for (const key of Object.keys(packages)) {
    const root = byFolder[key] || packages[key].folders[0];
    const folders = packages[key].folders;
    // Provider ids may live on any member folder.
    const firstOf = (field) =>
      (root[field]) || (folders.find((f) => f[field]) || {})[field] || "";
    const wagoManaged = folders.some((f) => f.wagoFileVersion);
    // Grimoire's own marker is the definitive install source when present.
    const grim = root.grimoireMarker || (folders.find((f) => f.grimoireMarker) || {}).grimoireMarker || null;
    const installedVia = grim ? grim.provider : wagoManaged ? "wago" : null;
    // Provider ids: .toc fields first, then Grimoire's marker fills gaps.
    const ids = {
      curseId: firstOf("curseId"),
      wagoId: firstOf("wagoId"),
      wowiId: firstOf("wowiId"),
      tukuiId: firstOf("tukuiId"),
    };
    if (grim && grim.id) {
      const field = { curseforge: "curseId", wago: "wagoId", wowinterface: "wowiId", tukui: "tukuiId" }[grim.provider];
      if (field && !ids[field]) ids[field] = String(grim.id);
    }
    // Every provider this package is available from.
    const sources = [];
    if (ids.curseId) sources.push("curseforge");
    if (wagoManaged || ids.wagoId) sources.push("wago");
    if (ids.wowiId) sources.push("wowinterface");
    if (ids.tukuiId) sources.push("tukui");
    if (installedVia && !sources.includes(installedVia)) sources.push(installedVia);
    const provider = sources.length > 1 ? "multi" : sources[0] || "unknown";
    // Marker versions beat the .toc version — they are exactly what the
    // manager installed, in the provider's own format.
    const installedVersion =
      (grim && grim.version) ||
      root.wagoFileVersion ||
      (folders.find((f) => f.wagoFileVersion) || {}).wagoFileVersion ||
      root.version ||
      (folders.find((f) => f.version) || {}).version ||
      "";
    // This package carries its own distinct provider id (see belongsTo), so
    // it didn't merge into anything — but it may still declare a same-family
    // dependency on a package that did resolve as a root elsewhere (DBM-Core
    // is Core's own root; DBM-Challenges/-PvP/-Party-* stay separate but all
    // require it). Recorded so a staleness check can tell "this is a quiet
    // companion module of an actively-maintained addon" from "this looks
    // abandoned" — its own upload cadence isn't the whole story.
    let dependsOnKey = null;
    for (const f of folders) {
      for (const dep of f.deps || []) {
        if (dep === key || !byFolder[dep]) continue;
        const depRoot = resolveRoot(dep, byFolder);
        if (depRoot !== key && familyToken(depRoot) === familyToken(key)) {
          dependsOnKey = depRoot;
          break;
        }
      }
      if (dependsOnKey) break;
    }
    result.push({
      key,
      name: root.title || key,
      notes: root.notes,
      version: installedVersion,
      tocVersion: root.version || "",
      wagoManaged,
      installedVia,
      grimoireId: grim ? grim.id : "",
      author: root.author,
      category: root.category || (folders.find((f) => f.category) || {}).category || "",
      website: root.website,
      interface: root.interface,
      curseId: ids.curseId,
      wagoId: ids.wagoId,
      wowiId: ids.wowiId,
      tukuiId: ids.tukuiId,
      provider,
      sources,
      dependsOnKey,
      gameVersion: parseInterfaceVersion(
        root.interface || (folders.find((f) => f.interface) || {}).interface || ""
      ),
      folders: folders.map((f) => f.folder).sort(),
    });
  }

  result.sort((a, b) => a.name.localeCompare(b.name));
  return { packages: result, scannedFolders: entries.length, tookMs: Date.now() - started };
}

module.exports = { scan };
