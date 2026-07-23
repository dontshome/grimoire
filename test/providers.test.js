const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("../src/providers");

test("version containment only matches complete tokens", () => {
  assert.equal(_test.isUpToDate("330", "Auctionator 330"), true);
  assert.equal(_test.isUpToDate("1.2", "1.20"), false);
  assert.equal(_test.isUpToDate("v2.5.0", "2.5.0"), true);
});

test("numeric version comparison handles missing zero components", () => {
  assert.equal(_test.compareVersions("1.2", "1.20"), 1);
  assert.equal(_test.compareVersions("2.5", "2.5.0"), 0);
  assert.equal(_test.compareVersions("build 12", "build 11"), -1);
});

test("interfaceNumFromVersionString accepts both dotted client versions and raw Interface numbers", () => {
  assert.equal(_test.interfaceNumFromVersionString("11.2.0"), 110200);
  assert.equal(_test.interfaceNumFromVersionString("11.2"), 110200);
  assert.equal(_test.interfaceNumFromVersionString("110200"), 110200);
  assert.equal(_test.interfaceNumFromVersionString("not a version"), null);
});

test("maxInterfaceNum picks the highest supported build across mixed flavors without cross-contamination", () => {
  // A file supporting both a Classic and a Retail build should compare
  // against the Retail number — the higher of the two, never the lower.
  assert.equal(_test.maxInterfaceNum(["5.5.4", "11.2.0"]), 110200);
  assert.equal(_test.maxInterfaceNum(["11.1.0", "11.2.0", "11.0.5"]), 110200);
  assert.equal(_test.maxInterfaceNum([]), null);
  assert.equal(_test.maxInterfaceNum(undefined), null);
});

test("interfaceBehindClient only flags a different content-patch era, not a hotfix behind", () => {
  // Same major.minor "era" (12.0.x) — a hotfix bump never breaks the addon API.
  assert.equal(_test.interfaceBehindClient(120000, 120007), false);
  assert.equal(_test.interfaceBehindClient(120005, 120007), false);
  assert.equal(_test.interfaceBehindClient(120007, 120007), false);
  // A different major.minor era — this is the boundary that can actually break things.
  assert.equal(_test.interfaceBehindClient(110800, 120007), true);
  assert.equal(_test.interfaceBehindClient(11508, 120007), true);
  // Missing data never asserts incompatibility.
  assert.equal(_test.interfaceBehindClient(null, 120007), false);
  assert.equal(_test.interfaceBehindClient(120000, null), false);
});

test("mergeResults carries each provider's interfaceNum into the merged row and its provider list", () => {
  const merged = _test.mergeResults([
    // No direct download — never picked as primary over one that has it.
    { name: "DBM", provider: "wowinterface", id: "1", remoteVersion: "3.0", interfaceNum: 110200 },
    { name: "DBM", provider: "wago", id: "2", remoteVersion: "2.9", downloadUrl: "https://x", interfaceNum: 110100 },
  ]);
  assert.equal(merged.length, 1);
  const row = merged[0];
  // Wago is the only entry with a direct download, so it becomes primary —
  // its interfaceNum (not WoWInterface's) must be what the row-level fields report.
  assert.equal(row.provider, "wago");
  assert.equal(row.interfaceNum, 110100);
  const byProvider = Object.fromEntries(row.providers.map((e) => [e.provider, e.interfaceNum]));
  assert.deepEqual(byProvider, { wowinterface: 110200, wago: 110100 });
});

test("annotateStaleness flags an interface-incompatible build without misreporting a fresh build as stale-everywhere", async () => {
  // No CurseForge key / Wago token in settings, and no real network available
  // in this test process, so the WoWInterface alternate lookup below rejects
  // deterministically — exercising the "no alternate confirmed a fix" path
  // without needing to mock anything.
  const settings = {};
  const clientIface = { num: 110200, label: "11.2.0" };
  const pkg = { key: "Foo", sources: ["curseforge", "wowinterface"], curseId: "111", wowiId: "333" };
  const perPackage = {
    Foo: {
      provider: "curseforge",
      interfaceNum: 110000, // behind the 11.2.0 client
      fileDate: new Date().toISOString(), // today — must not read as "stale"
    },
  };

  await _test.annotateStaleness([pkg], perPackage, settings, clientIface);

  assert.equal(perPackage.Foo.remoteInterfaceBehind, true);
  assert.equal(perPackage.Foo.brokenEverywhere, true);
  // The build is fresh (age ~0 days) and was never age-stale, so the
  // age-staleness outcomes must stay untouched — this is the bug that was
  // fixed: a candidate that qualified only via interface incompatibility
  // used to get marked staleEverywhere/betterElsewhere too.
  assert.equal(perPackage.Foo.staleEverywhere, undefined);
  assert.equal(perPackage.Foo.betterElsewhere, undefined);
});

test("annotateStaleness leaves age-only staleness behavior unchanged when there is no client interface to compare", async () => {
  const settings = {};
  const pkg = { key: "Bar", sources: ["curseforge"], curseId: "111" };
  const perPackage = {
    Bar: {
      provider: "curseforge",
      fileDate: new Date(Date.now() - 200 * 86400e3).toISOString(), // 200 days old
    },
  };

  await _test.annotateStaleness([pkg], perPackage, settings, null);

  assert.equal(perPackage.Bar.staleEverywhere, true);
  assert.equal(perPackage.Bar.brokenEverywhere, undefined);
  assert.equal(perPackage.Bar.remoteInterfaceBehind, undefined);
});
