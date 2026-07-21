// WowUp-compatible folder fingerprint, used by Wago's _match endpoint to
// recognize installed addons regardless of what the .toc files claim.
//
// Algorithm (ported from WowUp's wowup-folder-scanner.ts):
//   1. collect the folder's "matching files": its .toc files, every file
//      they include (recursively, .toc → .lua/.xml, .xml → <Include>/<Script>),
//      plus Bindings.xml
//   2. md5 each file, sort the hex digests, concatenate, md5 the result.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const TOC_COMMENTS = /\s*#.*$/gim;
const TOC_INCLUDES = /^\s*((?:(?!\.\.).)+\.(?:xml|lua))\s*$/gim;
const XML_COMMENTS = /<!--.*?-->/gis;
const XML_INCLUDES = /<(?:Include|Script)\s+file=["']((?:(?!\.\.).)+)["']\s*\/>/gi;
const TOC_FILE = /^([^/\\]+)[\\/]\1([-_](mainline|bcc|tbc|classic|vanilla|wrath|wotlkc|cata|mists))?\.toc$/i;
const BINDINGS_XML = /^[^/\\]+[/\\]Bindings\.xml$/i;

function md5(buf) {
  return crypto.createHash("md5").update(buf).digest("hex");
}

async function readDirRecursive(dir) {
  const out = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await readDirRecursive(p)));
    else out.push(p);
  }
  return out;
}

function matchAll(str, regex) {
  const matches = [];
  let m;
  regex.lastIndex = 0;
  while ((m = regex.exec(str))) matches.push(m[1]);
  return matches;
}

async function fingerprintFolder(folderPath) {
  const files = await readDirRecursive(folderPath);
  const fileMap = {};
  for (const f of files) fileMap[f.toLowerCase()] = f;

  const parentDir = path.normalize(path.dirname(folderPath) + path.sep).toLowerCase();
  const tocFiles = [];
  const matching = [];

  for (const f of files) {
    const rel = f.toLowerCase().replace(parentDir, "");
    if (TOC_FILE.test(rel)) tocFiles.push(f);
    else if (BINDINGS_XML.test(rel)) matching.push(f);
  }

  async function processInclude(filePath) {
    const real = fileMap[filePath.toLowerCase()];
    if (!real || matching.includes(real)) return;
    matching.push(real);

    let content;
    try {
      content = await fsp.readFile(real, "utf8");
    } catch {
      return;
    }
    const ext = path.extname(real).toLowerCase();
    let includes = [];
    if (ext === ".toc") includes = matchAll(content.replace(TOC_COMMENTS, ""), TOC_INCLUDES);
    else if (ext === ".xml") includes = matchAll(content.replace(XML_COMMENTS, ""), XML_INCLUDES);
    const dir = path.dirname(real);
    for (const inc of includes) {
      if (/[|\0\t\n\v\f\r]/.test(inc)) continue;
      await processInclude(path.join(dir, inc.replace(/\\/g, path.sep)));
    }
  }

  for (const toc of tocFiles.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
    await processInclude(toc);
  }

  const hashes = [];
  for (const f of matching) {
    try {
      hashes.push(md5(await fsp.readFile(f)));
    } catch {
      /* unreadable file — skip, matching WowUp behavior on errors */
    }
  }
  return md5(hashes.sort().join(""));
}

// Fingerprint many folders under an AddOns dir; returns { folderName: hash }.
async function fingerprintFolders(addonsDir, folderNames) {
  const out = {};
  for (const name of folderNames) {
    const dir = path.join(addonsDir, name);
    if (!fs.existsSync(dir)) continue;
    try {
      out[name] = await fingerprintFolder(dir);
    } catch {
      /* skip broken folder */
    }
  }
  return out;
}

module.exports = { fingerprintFolder, fingerprintFolders };
