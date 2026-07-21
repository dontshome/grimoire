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

const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100000;

async function download(url, destFile) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("Invalid download URL"); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Download URL must use HTTP or HTTPS");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(parsed, { redirect: "follow", signal: controller.signal });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const length = Number(res.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_ARCHIVE_BYTES) {
      throw new Error("Addon archive is larger than the 1 GB safety limit");
    }
    if (!res.body) throw new Error("Download returned no data");
    const fd = fs.openSync(destFile, "wx");
    let received = 0;
    let writeError = null;
    try {
      for await (const chunk of res.body) {
        received += chunk.byteLength;
        if (received > MAX_ARCHIVE_BYTES) {
          throw new Error("Addon archive is larger than the 1 GB safety limit");
        }
        fs.writeSync(fd, Buffer.from(chunk));
      }
    } catch (err) {
      writeError = err;
    } finally {
      fs.closeSync(fd);
    }
    if (writeError) {
      try { fs.rmSync(destFile, { force: true }); } catch {}
      throw writeError;
    }
  } catch (err) {
    if (err && err.name === "AbortError") throw new Error("Addon download timed out");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function moveDir(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (!err || err.code !== "EXDEV") throw err;
    // rename(2) cannot cross filesystem boundaries (for example macOS's
    // internal temp volume -> an external WoW drive). Copy completely before
    // removing the source so a failed copy never destroys the only good copy.
    // Clear any existing destination first so this path replaces rather than
    // merges — matching renameSync's semantics, so a stale file from an old
    // version can't survive an update.
    fs.rmSync(to, { recursive: true, force: true });
    try {
      fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
    } catch (copyErr) {
      try { fs.rmSync(to, { recursive: true, force: true }); } catch {}
      throw copyErr;
    }
    fs.rmSync(from, { recursive: true, force: false });
  }
}

function assertFolderName(folder) {
  if (
    typeof folder !== "string" ||
    !folder ||
    folder === "." ||
    folder === ".." ||
    folder.includes("\0") ||
    path.basename(folder) !== folder ||
    folder.includes("/") ||
    folder.includes("\\")
  ) {
    throw new Error(`Unsafe addon folder name: ${JSON.stringify(folder)}`);
  }
  return folder;
}

function safeLabel(label) {
  const cleaned = String(label || "addon").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "");
  return cleaned.slice(0, 80) || "addon";
}

function validateArchive(zip) {
  const entries = zip.getEntries();
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error("Addon archive contains too many files");
  let total = 0;
  for (const entry of entries) {
    total += Number(entry.header && entry.header.size) || 0;
    if (total > MAX_ARCHIVE_BYTES) {
      throw new Error("Expanded addon archive is larger than the 1 GB safety limit");
    }
  }
}

function backupFolders(folders, addonsDir, userDataDir, label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(
    userDataDir,
    "backups",
    `${safeLabel(label)}-${stamp}-${Math.random().toString(36).slice(2, 8)}`
  );
  const backedUp = [];
  try {
    for (const rawFolder of folders) {
      const folder = assertFolderName(rawFolder);
      const existing = path.join(addonsDir, folder);
      if (fs.existsSync(existing)) {
        moveDir(existing, path.join(backupDir, folder));
        backedUp.push(folder);
      }
    }
  } catch (err) {
    const restoreErrors = restoreBackup(backedUp, backupDir, addonsDir);
    if (restoreErrors.length) err.message += `; backup rollback failed for: ${restoreErrors.join(", ")}`;
    throw err;
  }
  return { backupDir: backedUp.length ? backupDir : null, backedUp };
}

function restoreBackup(folders, backupDir, addonsDir) {
  const failed = [];
  for (const folder of [...folders].reverse()) {
    try {
      const backup = path.join(backupDir, folder);
      const destination = path.join(addonsDir, folder);
      if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
      if (fs.existsSync(backup)) moveDir(backup, destination);
    } catch {
      failed.push(folder);
    }
  }
  return failed;
}

// job: { key, downloadUrl, folders, provider, id, version }
async function install(job, addonsDir, userDataDir, { downloadFile = download } = {}) {
  if (!job || typeof job !== "object") throw new Error("Invalid install request");
  if (!job.downloadUrl) throw new Error("No download URL for this addon");
  const oldFolders = [...new Set((job.folders || []).map(assertFolderName))];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-"));
  const zipFile = path.join(tmp, "addon.zip");
  const extractDir = path.join(tmp, "extract");
  let backup = null;
  const installed = [];

  try {
    await downloadFile(job.downloadUrl, zipFile);

    const zip = new AdmZip(zipFile);
    validateArchive(zip);
    fs.mkdirSync(extractDir, { recursive: true });
    zip.extractAllTo(extractDir, true);

    const newFolders = fs
      .readdirSync(extractDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "__MACOSX")
      .map((e) => assertFolderName(e.name));
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
    const toReplace = [...new Set([...oldFolders, ...newFolders])];
    backup = backupFolders(toReplace, addonsDir, userDataDir, job.key || "addon");

    for (const folder of newFolders) {
      moveDir(path.join(extractDir, folder), path.join(addonsDir, folder));
      installed.push(folder);
    }

    return {
      ok: true,
      installedFolders: newFolders,
      backedUp: backup.backedUp,
      backupDir: backup.backupDir,
    };
  } catch (err) {
    if (backup) {
      for (const folder of installed) {
        try { fs.rmSync(path.join(addonsDir, folder), { recursive: true, force: true }); } catch {}
      }
      const restoreErrors = restoreBackup(backup.backedUp, backup.backupDir, addonsDir);
      // Naming the folders is not enough — if they could not be put back, the
      // user's only copy is in the backup directory and the message has to say
      // where, or this reads as data loss.
      if (restoreErrors.length) {
        err.message +=
          `; install rollback failed for: ${restoreErrors.join(", ")}` +
          (backup.backupDir ? `\nYour previous version is safe in:\n${backup.backupDir}` : "");
      }
    }
    throw err;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Remove an addon: all its folders go to a timestamped backup (never deleted
// outright, so an accidental uninstall is always recoverable).
function uninstall(job, addonsDir, userDataDir) {
  if (!job || typeof job !== "object") throw new Error("Invalid uninstall request");
  const folders = [...new Set((job.folders || []).map(assertFolderName))];
  if (!folders.length) throw new Error("Nothing to uninstall");
  const { backupDir, backedUp } = backupFolders(folders, addonsDir, userDataDir, `uninstall-${job.key || "addon"}`);
  if (!backedUp.length) throw new Error("Folders were already gone");
  return { ok: true, removed: backedUp, backupDir };
}

module.exports = { install, uninstall, moveDir };
