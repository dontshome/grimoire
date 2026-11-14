const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const flavors = require("../src/flavors");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const BUILD_INFO_HEADER =
  "Branch!STRING:0|Active!DEC:1|Build Key!HEX:16|CDN Key!HEX:16|Install Key!HEX:16|IM Size!DEC:1|Product!STRING:0|Tags!STRING:0|Armadillo!STRING:0|Last Activated!STRING:0|Version!STRING:0|KeyID!STRING:0";

function buildInfoRow(product, version) {
  return `us|1|deadbeef|deadbeef||123|${product}|windows|| |${version}|`;
}

test("clientInterfaceFor reads .build.info and converts the client version to an Interface number", () => {
  const root = tempDir("grimoire-buildinfo-");
  try {
    fs.writeFileSync(
      path.join(root, ".build.info"),
      [BUILD_INFO_HEADER, buildInfoRow("wow", "11.2.0.58224"), buildInfoRow("wow_classic", "5.5.4.12345")].join("\n")
    );
    assert.deepEqual(flavors.clientInterfaceFor(root, "retail"), {
      num: 110200,
      version: "11.2.0.58224",
      label: "11.2.0",
    });
    assert.deepEqual(flavors.clientInterfaceFor(root, "classic"), {
      num: 50504,
      version: "5.5.4.12345",
      label: "5.5.4",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("clientInterfaceFor fails soft when the flavor, row, or file is missing", () => {
  const root = tempDir("grimoire-buildinfo-");
  try {
    fs.writeFileSync(path.join(root, ".build.info"), [BUILD_INFO_HEADER, buildInfoRow("wow", "11.2.0.58224")].join("\n"));
    // No known product code for this flavor — must not guess.
    assert.equal(flavors.clientInterfaceFor(root, "xptr"), null);
    // Product code known, but no matching row in this install.
    assert.equal(flavors.clientInterfaceFor(root, "classic_era"), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  // No .build.info at all (e.g. a bad WoW path).
  assert.equal(flavors.clientInterfaceFor(tempDir("grimoire-empty-"), "retail"), null);
  assert.equal(flavors.clientInterfaceFor("", "retail"), null);
});

test("a _forever_ client is detected as WoW Forever with its own AddOns folder", () => {
  const root = tempDir("grimoire-forever-");
  try {
    fs.mkdirSync(path.join(root, "_retail_", "Interface", "AddOns"), { recursive: true });
    fs.mkdirSync(path.join(root, "_forever_", "Interface", "AddOns"), { recursive: true });
    const found = flavors.detectFlavors(root);
    assert.deepEqual(found.map((f) => f.id), ["retail", "forever"]);
    assert.equal(found.find((f) => f.id === "forever").label, "Forever");
    assert.equal(flavors.addonsDirFor(root, "forever"), path.join(root, "_forever_", "Interface", "AddOns"));
    const forever = flavors.byId("forever");
    assert.notEqual(forever.cfTypeId, flavors.byId("classic_era").cfTypeId);
    assert.deepEqual(forever.tocSuffix, ["Forever", "Camelot"]);
    assert.equal(forever.wago, "forever");
    fs.writeFileSync(
      path.join(root, ".build.info"),
      [BUILD_INFO_HEADER, buildInfoRow("wow", "12.1.5.70783"), buildInfoRow("wowf", "1.60.1.70938")].join("\n")
    );
    assert.equal(flavors.clientInterfaceFor(root, "forever").num, 16001);
    assert.equal(flavors.clientInterfaceFor(root, "retail").num, 120105);
    assert.notEqual(forever.wago, flavors.byId("classic_era").wago);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
