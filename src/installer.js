// Downloads an addon zip and installs it into Interface\AddOns.
// The old folders are moved to a timestamped backup directory first, so a
// bad update can always be rolled back by hand.
//
// Every folder we install gets a ".grimoire" marker recording which provider
// it came from, the provider's addon id, and the exact version — so the app
// always knows the truth about where an addon was installed from.

const fs = require("fs");
const path = require("path");
const os = require("os");
const AdmZip = require("adm-zip");

async function download(url, destFile) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destFile, buf);
}

function moveDir(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

function backupFolders(folders, addonsDir, userDataDir, label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(userDataDir, "backups", `${label}-${stamp}`);
  const backedUp = [];
  for (const folder of folders) {
    const existing = path.join(addonsDir, folder);
    if (fs.existsSync(existing)) {
      moveDir(existing, path.join(backupDir, folder));
      backedUp.push(folder);
    }
  }
  return { backupDir: backedUp.length ? backupDir : null, backedUp };
}

// job: { key, downloadUrl, folders, provider, id, version }
async function install(job, addonsDir, userDataDir) {
  if (!job.downloadUrl) throw new Error("No download URL for this addon");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-"));
  const zipFile = path.join(tmp, "addon.zip");
  const extractDir = path.join(tmp, "extract");

  try {
    await download(job.downloadUrl, zipFile);

    const zip = new AdmZip(zipFile);
    fs.mkdirSync(extractDir, { recursive: true });
    zip.extractAllTo(extractDir, true);

    const newFolders = fs
      .readdirSync(extractDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    if (!newFolders.length) throw new Error("Zip contained no addon folders");

    // Stamp each new folder with its install source before moving into place.
    if (job.provider) {
      const marker = JSON.stringify(
        { provider: job.provider, id: job.id || "", version: job.version || "", at: new Date().toISOString() },
        null,
        2
      );
      for (const folder of newFolders) {
        try { fs.writeFileSync(path.join(extractDir, folder, ".grimoire"), marker, "utf8"); } catch {}
      }
    }

    // Back up every folder we are about to replace, plus any previously
    // installed folder belonging to this package that the new zip drops.
    const toReplace = [...new Set([...(job.folders || []), ...newFolders])];
    const { backupDir, backedUp } = backupFolders(toReplace, addonsDir, userDataDir, job.key || "addon");

    for (const folder of newFolders) {
      moveDir(path.join(extractDir, folder), path.join(addonsDir, folder));
    }

    return { ok: true, installedFolders: newFolders, backedUp, backupDir };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Remove an addon: all its folders go to a timestamped backup (never deleted
// outright, so an accidental uninstall is always recoverable).
function uninstall(job, addonsDir, userDataDir) {
  const folders = job.folders || [];
  if (!folders.length) throw new Error("Nothing to uninstall");
  const { backupDir, backedUp } = backupFolders(folders, addonsDir, userDataDir, `uninstall-${job.key || "addon"}`);
  if (!backedUp.length) throw new Error("Folders were already gone");
  return { ok: true, removed: backedUp, backupDir };
}

module.exports = { install, uninstall };
