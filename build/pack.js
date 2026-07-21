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
  // electron's app.getPath("userData") on Windows = %APPDATA%/<productName>
  return path.join(process.env.APPDATA || os.homedir(), "Grimoire", "settings.json");
}

function authorKeys() {
  const raw = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  const keys = { curseApiKey: raw.curseApiKey || "", wagoApiKey: raw.wagoApiKey || "" };
  if (!keys.curseApiKey && !keys.wagoApiKey) {
    throw new Error("No API keys found in settings.json — set them in the app first.");
  }
  return keys;
}

function runBuilder(artifactName) {
  execFileSync(process.execPath, [builderCli, "--win", "nsis", "-c.nsis.artifactName", artifactName], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env },
  });
}

function buildClean() {
  if (fs.existsSync(DAT)) fs.unlinkSync(DAT);
  console.log("\n=== Building CLEAN public installer ===");
  runBuilder("Grimoire-Setup-${version}.exe");
}

function buildDad() {
  const keys = authorKeys();
  fs.writeFileSync(DAT, encrypt(keys), "utf8");
  console.log("\n=== Building DAD installer (keys embedded) ===");
  try {
    runBuilder("Grimoire-Setup-${version}-dad.exe");
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
  for (const f of fs.readdirSync(OUT).filter((f) => f.endsWith(".exe"))) {
    console.log("  " + f);
  }
} catch (e) {
  console.error("\nBuild failed:", e.message);
  process.exit(1);
}
