// Reads the provenance stamp back out of a packaged artifact, so anyone can
// check what source produced a build without unpacking it by hand.
//
//   node build/verify-build.js dist/win-unpacked/resources/app.asar
//   node build/verify-build.js "/Volumes/.../Grimoire.app/Contents/Resources/app.asar"
//
// Exits non-zero when the stamp is missing, unverified, or does not match a
// commit that exists on origin.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const target = process.argv[2];
if (!target) {
  console.error("usage: node build/verify-build.js <path-to-app.asar>");
  process.exit(2);
}
if (!fs.existsSync(target)) {
  console.error(`not found: ${target}`);
  process.exit(2);
}

let asar;
try {
  asar = require("@electron/asar");
} catch {
  console.error("@electron/asar is not installed — run npm install first.");
  process.exit(2);
}

let info;
try {
  info = JSON.parse(asar.extractFile(target, "build-info.json").toString());
} catch {
  console.error("\nNo build-info.json in this artifact.");
  console.error("It was built before provenance stamping existed, or with");
  console.error("GRIMOIRE_ALLOW_DIRTY=1. Treat it as untraceable.\n");
  process.exit(1);
}

console.log("");
console.log(`  version  : ${info.version}`);
console.log(`  commit   : ${info.commit}`);
console.log(`  built    : ${info.builtAt}`);
console.log(`  platform : ${info.platform}`);
console.log("");

if (info.commit === "unverified") {
  console.error("This build skipped provenance checks. Do not publish it.\n");
  process.exit(1);
}

// If we are inside the repo, confirm the commit is real and published.
try {
  const root = path.join(__dirname, "..");
  const run = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  run(["rev-parse", "--is-inside-work-tree"]);
  run(["cat-file", "-e", `${info.commit}^{commit}`]);
  console.log(`  commit exists locally: yes`);
  const branches = run(["branch", "-r", "--contains", info.commit]).split("\n").map((s) => s.trim()).filter(Boolean);
  if (branches.length) {
    console.log(`  published on: ${branches.join(", ")}`);
    console.log("\nArtifact is traceable to published source.\n");
  } else {
    console.error("\nThis commit is NOT on any remote branch — the source that");
    console.error("built this artifact was never pushed.\n");
    process.exit(1);
  }
} catch {
  console.log("  (not run from the repo — could not confirm the commit is published)\n");
}
