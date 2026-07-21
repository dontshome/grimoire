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

// Pick the .toc that applies to retail: Folder.toc, then Folder_Mainline.toc,
// then any other .toc as a last resort.
function findToc(dir, folderName) {
  const preferred = [
    `${folderName}.toc`,
    `${folderName}_Mainline.toc`,
    `${folderName}-Mainline.toc`,
  ];
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

function readFolder(addonsDir, folderName) {
  const dir = path.join(addonsDir, folderName);
  const tocPath = findToc(dir, folderName);
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

// Decide which folder a sub-folder belongs to. "BigWigs_Plugins" belongs to
// "BigWigs" unless it carries its own provider id different from the parent's
// (ElvUI_WindTools is its own addon even though it's named like a sub-folder).
function parentKeyOf(info, byFolder) {
  if (info.partOf && byFolder[info.partOf]) return info.partOf;

  const idx = info.folder.indexOf("_");
  if (idx > 0) {
    const prefix = info.folder.slice(0, idx);
    const parent = byFolder[prefix];
    if (parent) {
      // A sub-folder carrying its own provider id that the parent doesn't
      // share is a separate addon that just squats on the parent's name
      // (ElvUI_WindTools vs ElvUI). No id of its own = part of the parent.
      const ownId = info.curseId || info.wagoId;
      const parentId = parent.curseId || parent.wagoId;
      const distinct = ownId && ownId !== parentId;
      if (!distinct) return prefix;
    }
  }
  return null;
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

function scan(addonsDir) {
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
    const info = readFolder(addonsDir, name);
    if (info) byFolder[name] = info;
  }

  // Group folders into packages.
  const packages = {};
  for (const name of Object.keys(byFolder)) {
    const info = byFolder[name];
    const parent = parentKeyOf(info, byFolder);
    const key = parent || name;
    if (!packages[key]) packages[key] = { key, folders: [] };
    packages[key].folders.push(info);
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
