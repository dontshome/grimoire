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
// so running this on macOS produces the dmg/zip and on Windows the nsis exe.
function runBuilder(suffix) {
  const args = [builderCli];
  if (process.platform === "darwin") {
    args.push("--mac", "-c.mac.artifactName", `\${productName}-\${version}-mac-\${arch}${suffix}.\${ext}`);
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
  if (mode === "clean") buildClean();
  else if (mode === "dad") buildDad();
  // Build dad first, clean last, so the published update feed (latest.yml)
  // ends up referencing the public installer, not the private dad one.
  else { buildDad(); buildClean(); }
  console.log("\nDone. Installers are in:", OUT);
  const artifacts = /\.(exe|dmg|zip)$/i;
  for (const f of fs.readdirSync(OUT).filter((f) => artifacts.test(f))) {
    console.log("  " + f);
  }
} catch (e) {
  console.error("\nBuild failed:", e.message);
  process.exit(1);
}
