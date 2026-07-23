const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const scanner = require("../src/scanner");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// folder -> array of "## Key: Value" toc lines
function writeAddon(addonsDir, folder, lines) {
  const dir = path.join(addonsDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${folder}.toc`), lines.join("\n"));
}

// Mirrors DBM's real folder shape as installed on disk: DBM-Test-Dungeons
// depends on DBM-Test, which depends on DBM-Core, and only DBM-Core carries
// the real CurseForge id. DBM-Test-Dungeons' own Interface line is a stale
// Classic-Era number (11508) left over from a module that doesn't need
// updating on retail — grouping it under DBM-Core is what stops that number
// from being reported as the whole addon's compatibility.
test("scan groups a multi-hop RequiredDeps chain under its real-id root, ignoring a stale sub-module's own Interface", () => {
  const addonsDir = tempDir("grimoire-scan-dbm-");
  try {
    writeAddon(addonsDir, "DBM-Core", [
      "## Interface: 120007, 120100",
      "## Title: DBM Core",
      "## X-Curse-Project-ID: 3358",
      "## Dependencies: DBM-StatusBarTimers",
    ]);
    writeAddon(addonsDir, "DBM-Test", [
      "## Interface: 120007, 120100",
      "## Dependencies: DBM-Core",
    ]);
    writeAddon(addonsDir, "DBM-Test-Dungeons", [
      "## Interface: 11508",
      "## Dependencies: DBM-Test",
    ]);
    writeAddon(addonsDir, "DBM-PvP", [
      "## Interface: 120007",
      "## X-Curse-Project-ID: 61882",
      "## RequiredDeps: DBM-Core",
    ]);

    const { packages } = scanner.scan(addonsDir, ["Mainline"]);
    const byKey = Object.fromEntries(packages.map((p) => [p.key, p]));

    assert.equal(packages.length, 2, "DBM-Test/DBM-Test-Dungeons collapse into DBM-Core; DBM-PvP stays separate");
    assert.ok(byKey["DBM-Core"]);
    assert.deepEqual(
      byKey["DBM-Core"].folders,
      ["DBM-Core", "DBM-Test", "DBM-Test-Dungeons"].sort()
    );
    // The merged package reports DBM-Core's own current Interface, not the
    // stale 11508 pulled in from DBM-Test-Dungeons.
    assert.equal(byKey["DBM-Core"].gameVersion.num, 120100);

    // A sub-folder with its own distinct provider id is a genuinely separate
    // addon (DBM PvP is its own CurseForge project) and must not be merged.
    assert.ok(byKey["DBM-PvP"]);
    assert.deepEqual(byKey["DBM-PvP"].folders, ["DBM-PvP"]);
  } finally {
    fs.rmSync(addonsDir, { recursive: true, force: true });
  }
});

// A folder with no provider id of its own must not be swallowed into an
// unrelated dependency just because that dependency happens to be a
// standalone, separately-installed addon folder (e.g. a shared library) —
// only deps within the same name family are followed.
test("scan does not cross-merge unrelated addon families over a shared dependency", () => {
  const addonsDir = tempDir("grimoire-scan-crossfamily-");
  try {
    writeAddon(addonsDir, "SharedMedia", [
      "## Interface: 120007",
      "## X-Curse-Project-ID: 99999",
    ]);
    writeAddon(addonsDir, "SomeAddon", [
      "## Interface: 120007",
      "## Dependencies: SharedMedia",
    ]);

    const { packages } = scanner.scan(addonsDir, ["Mainline"]);
    const keys = packages.map((p) => p.key).sort();

    assert.deepEqual(keys, ["SharedMedia", "SomeAddon"]);
  } finally {
    fs.rmSync(addonsDir, { recursive: true, force: true });
  }
});
