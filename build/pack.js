// Builds Grimoire installers.
//   node build/pack.js clean   → public installer, no keys
//   node build/pack.js dad     → installer with the author's keys baked in
//   node build/pack.js both    → both of the above
//
// The "dad" build reads the author's keys from Grimoire's own settings.json,
// encrypts them into build root as bundled.dat, builds, then deletes it so the
// keys never linger in the source tree.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { encrypt, FILE } = require("../src/bundledKeys");

const ROOT = path.join(__dirname, "..");
const DAT = path.join(ROOT, FILE);
const OUT = path.join(ROOT, "dist");
const PROVENANCE = path.join(ROOT, "build-info.json");

// ------------------------------------------------------------- provenance

// Releases have twice shipped from a downloaded source zip rather than the
// repository, so the published tag pointed at code that was never what built
// the artifact. Nothing detected it except manually unpacking app.asar
// afterwards. These checks make that failure mode loud instead of silent.

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function refuse(reason, remedy) {
  console.error(`\nBuild refused: ${reason}\n`);
  console.error(`${remedy}\n`);
  console.error("To build anyway (not for anything you intend to publish):");
  console.error("  GRIMOIRE_ALLOW_DIRTY=1 node build/pack.js <mode>\n");
  process.exit(1);
}

// Returns the commit the artifact is being built from, or null when the checks
// were explicitly bypassed.
function verifyProvenance() {
  if (process.env.GRIMOIRE_ALLOW_DIRTY === "1") {
    console.log("\n!! GRIMOIRE_ALLOW_DIRTY=1 — provenance checks skipped. Do not publish this build.\n");
    return null;
  }

  let head;
  try {
    git(["rev-parse", "--is-inside-work-tree"]);
    head = git(["rev-parse", "HEAD"]);
  } catch {
    refuse(
      "this is not a git checkout, so there is no way to tell what source it is.",
      "Build from a clone instead of a downloaded zip:\n" +
      "  git clone https://github.com/dontshome/grimoire.git"
    );
  }

  const dirty = git(["status", "--porcelain"]);
  if (dirty) {
    refuse(
      "the working tree has uncommitted changes, so the build would not match any commit.",
      "Commit and push first, then build:\n" + dirty.split("\n").slice(0, 10).map((l) => "  " + l).join("\n")
    );
  }

  // A build is only reproducible if the commit actually exists on the remote.
  try {
    git(["fetch", "origin", "--quiet"]);
    const remote = git(["rev-parse", "origin/main"]);
    if (head !== remote) {
      const ahead = git(["rev-list", "--count", "origin/main..HEAD"]);
      const behind = git(["rev-list", "--count", "HEAD..origin/main"]);
      refuse(
        `HEAD does not match origin/main (${ahead} ahead, ${behind} behind), so the published tag would not describe this build.`,
        Number(ahead) > 0
          ? "Push your commits first:\n  git push origin main"
          : "Pull the latest changes first:\n  git pull origin main"
      );
    }
  } catch (e) {
    if (e && e.status === 1) throw e;
    console.warn("  (could not reach origin — skipping the remote comparison)");
  }

  return head;
}

// Written into the package so any artifact can be traced back to its source.
function writeProvenance(commit) {
  const info = {
    version: require(path.join(ROOT, "package.json")).version,
    commit: commit || "unverified",
    builtAt: new Date().toISOString(),
    platform: process.platform,
  };
  fs.writeFileSync(PROVENANCE, JSON.stringify(info, null, 2), "utf8");
  return info;
}

// Call electron-builder's JS entrypoint with the current node — avoids the
// Windows "spawnSync .cmd EINVAL" problem with npx/.cmd shims entirely.
const builderCli = path.join(ROOT, "node_modules", "electron-builder", "out", "cli", "cli.js");

function settingsPath() {
  // Mirrors electron's app.getPath("userData") per platform.
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "Grimoire", "settings.json");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Grimoire", "settings.json");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "Grimoire", "settings.json");
}

// The app now encrypts credentials at rest with electron's safeStorage, which
// is backed by the OS keyring and unreachable from plain node. So the dad build
// takes its keys from the environment:
//
//   GRIMOIRE_CURSE_KEY=… GRIMOIRE_WAGO_KEY=… node build/pack.js dad
//
// Pre-encryption settings.json files are still read as a fallback so this keeps
// working on a machine that has not launched the new build yet.
function authorKeys() {
  const keys = {
    curseApiKey: process.env.GRIMOIRE_CURSE_KEY || "",
    wagoApiKey: process.env.GRIMOIRE_WAGO_KEY || "",
  };
  if (keys.curseApiKey || keys.wagoApiKey) return keys;

  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(settingsPath(), "utf8")); } catch { /* absent */ }
  keys.curseApiKey = raw.curseApiKey || "";
  keys.wagoApiKey = raw.wagoApiKey || "";
  if (keys.curseApiKey || keys.wagoApiKey) return keys;

  if (raw.curseApiKeyEnc || raw.wagoApiKeyEnc) {
    throw new Error(
      "settings.json holds encrypted keys, which this script cannot read.\n" +
      "Pass them explicitly instead:\n" +
      "  GRIMOIRE_CURSE_KEY=… GRIMOIRE_WAGO_KEY=… node build/pack.js dad"
    );
  }
  throw new Error("No API keys found — set them in the app, or pass GRIMOIRE_CURSE_KEY / GRIMOIRE_WAGO_KEY.");
}

// suffix is "" for the public build and "-dad" for the keyed one. Each platform
// names its own artifact — electron-builder can only build the host's format,
// so running this on macOS produces the dmg/zip, on Linux the AppImage, and on
// Windows the nsis exe.
function runBuilder(suffix) {
  const args = [builderCli];
  if (process.platform === "darwin") {
    args.push("--mac", "-c.mac.artifactName", `\${productName}-\${version}-mac-\${arch}${suffix}.\${ext}`);
  } else if (process.platform === "linux") {
    args.push("--linux", "AppImage", "-c.linux.artifactName", `\${productName}-\${version}-linux-\${arch}${suffix}.\${ext}`);
  } else {
    args.push("--win", "nsis", "-c.nsis.artifactName", `Grimoire-Setup-\${version}${suffix}.exe`);
  }
  execFileSync(process.execPath, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env },
  });
}

function buildClean() {
  if (fs.existsSync(DAT)) fs.unlinkSync(DAT);
  console.log("\n=== Building CLEAN public installer ===");
  runBuilder("");
}

function buildDad() {
  const keys = authorKeys();
  fs.writeFileSync(DAT, encrypt(keys), "utf8");
  console.log("\n=== Building DAD installer (keys embedded) ===");
  try {
    runBuilder("-dad");
  } finally {
    fs.unlinkSync(DAT); // never leave keys in the tree
  }
}

const mode = (process.argv[2] || "both").toLowerCase();
try {
  console.log("\n=== Verifying source provenance ===");
  const commit = verifyProvenance();
  const info = writeProvenance(commit);
  console.log(`  version ${info.version} @ ${info.commit.slice(0, 7)}`);

  if (mode === "clean") buildClean();
  else if (mode === "dad") buildDad();
  // Build dad first, clean last, so the published update feed (latest.yml)
  // ends up referencing the public installer, not the private dad one.
  else { buildDad(); buildClean(); }
  console.log("\nDone. Installers are in:", OUT);
  const artifacts = /\.(exe|dmg|zip|AppImage)$/i;
  for (const f of fs.readdirSync(OUT).filter((f) => artifacts.test(f))) {
    console.log("  " + f);
  }
  console.log(`\nBuilt from ${info.commit} — verify any artifact with:`);
  console.log("  npm run verify-build -- <path-to-app.asar>");
} catch (e) {
  console.error("\nBuild failed:", e.message);
  process.exit(1);
} finally {
  try { fs.unlinkSync(PROVENANCE); } catch { /* never packaged twice */ }
}
