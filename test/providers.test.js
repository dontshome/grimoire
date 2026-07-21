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
