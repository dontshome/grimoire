const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  OWNER_ONLY_MODE,
  createSecretCodec,
  hasLegacySecrets,
  redactSecretsInText,
  secureWriteText,
  secureCopyFile,
  applySecretsForSave,
} = require("../src/credentials");

// Mirrors Electron 45+'s async safeStorage API. Every call counts, so tests
// can assert nothing is encrypted twice. `rotate` makes decryption report
// shouldReEncrypt, as after an OS key rotation.
function fakeSafeStorage({ available = true, rotate = false } = {}) {
  let n = 0;
  const fake = {
    encryptCalls: 0,
    isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async (value) => {
      fake.encryptCalls++;
      return Buffer.from(`sealed${n++}:${value}`, "utf8");
    },
    decryptStringAsync: async (value) => {
      const text = value.toString("utf8");
      const m = text.match(/^sealed\d*:/);
      if (!m) throw new Error("bad ciphertext");
      return { result: text.slice(m[0].length), shouldReEncrypt: rotate };
    },
  };
  return fake;
}

// Ciphertext as written by the OLD synchronous encryptString (same format the
// fake's decryptStringAsync accepts), to prove existing users' keys still load.
const legacySealed = (value) => Buffer.from(`sealed:${value}`, "utf8").toString("base64");

test("secret codec encrypts, decrypts, trims no data, and supports legacy fallback", async () => {
  const codec = createSecretCodec(fakeSafeStorage());
  await codec.init();
  await codec.prepare(["curse-key"]);
  const encrypted = codec.encryptSecret("curse-key");
  assert.ok(encrypted);
  assert.notEqual(encrypted, "curse-key");
  assert.deepEqual(codec.readSecrets({ curseApiKeyEnc: encrypted, wagoApiKey: "legacy-wago" }), {
    curseApiKey: "curse-key",
    wagoApiKey: "legacy-wago",
  });
  assert.equal(hasLegacySecrets({ curseApiKey: "legacy" }), true);
  assert.equal(hasLegacySecrets({ curseApiKeyEnc: encrypted }), false);
});

test("keys saved by the old synchronous API decrypt at startup and are reused, not re-encrypted", async () => {
  const storage = fakeSafeStorage();
  const codec = createSecretCodec(storage);
  const stored = legacySealed("existing-key");
  const { needsReEncrypt } = await codec.init([stored]);
  assert.equal(needsReEncrypt, false);
  assert.equal(codec.readSecrets({ curseApiKeyEnc: stored }).curseApiKey, "existing-key");
  // An unrelated save passes the decrypted value back; it must keep the
  // existing ciphertext rather than encrypting again.
  await codec.prepare(["existing-key"]);
  assert.equal(codec.encryptSecret("existing-key"), stored);
  assert.equal(storage.encryptCalls, 0);
});

test("undecryptable stored keys are treated as absent", async () => {
  const codec = createSecretCodec(fakeSafeStorage());
  await codec.init([Buffer.from("garbage").toString("base64")]);
  assert.equal(codec.readSecrets({ curseApiKeyEnc: Buffer.from("garbage").toString("base64") }).curseApiKey, "");
});

test("key rotation is reported and a forced prepare produces fresh ciphertext", async () => {
  const codec = createSecretCodec(fakeSafeStorage({ rotate: true }));
  const stored = legacySealed("rotating-key");
  const { needsReEncrypt } = await codec.init([stored]);
  assert.equal(needsReEncrypt, true);
  await codec.prepare(["rotating-key"], { force: true });
  const fresh = codec.encryptSecret("rotating-key");
  assert.ok(fresh);
  assert.notEqual(fresh, stored);
  assert.equal(codec.readSecrets({ curseApiKeyEnc: fresh }).curseApiKey, "rotating-key");
});

test("secret codec refuses to produce ciphertext when secure storage is unavailable", async () => {
  const codec = createSecretCodec(fakeSafeStorage({ available: false }));
  await codec.init();
  assert.equal(codec.encryptionAvailable(), false);
  await codec.prepare(["must-not-hit-disk"]);
  assert.equal(codec.encryptSecret("must-not-hit-disk"), "");
});

test("a value that was never prepared is not encrypted (the save then refuses it)", async () => {
  const codec = createSecretCodec(fakeSafeStorage());
  await codec.init();
  assert.equal(codec.encryptSecret("not-prepared"), "");
});

test("settings saves preserve, replace, and remove credentials without plaintext", async () => {
  const codec = createSecretCodec(fakeSafeStorage());
  await codec.init();
  await codec.prepare(["old-key", "new-key"]);
  const oldEncrypted = codec.encryptSecret("old-key");
  const existing = { curseApiKeyEnc: oldEncrypted, wowPath: "/old" };

  const preserved = applySecretsForSave({ wowPath: "/new" }, existing, {}, codec.encryptSecret);
  assert.equal(preserved.curseApiKeyEnc, oldEncrypted);

  const replaced = applySecretsForSave(
    { wowPath: "/new", curseApiKey: "new-key" },
    existing,
    { curseApiKey: "new-key" },
    codec.encryptSecret
  );
  assert.equal(codec.readSecrets(replaced).curseApiKey, "new-key");
  assert.equal(Object.hasOwn(replaced, "curseApiKey"), false);
  assert.notEqual(replaced.curseApiKeyEnc, oldEncrypted);

  const removed = applySecretsForSave(
    { wowPath: "/new", curseApiKey: "" },
    existing,
    { curseApiKey: "" },
    codec.encryptSecret
  );
  assert.equal(Object.hasOwn(removed, "curseApiKey"), false);
  assert.equal(Object.hasOwn(removed, "curseApiKeyEnc"), false);
});

test("a new credential is rejected rather than written in plaintext when encryption fails", () => {
  assert.throws(
    () => applySecretsForSave(
      { curseApiKey: "new-key" },
      {},
      { curseApiKey: "new-key" },
      () => ""
    ),
    /Secure credential storage is unavailable/
  );
});

test("corrupt settings redaction handles escaped JSON strings", () => {
  const input = String.raw`{"curseApiKey":"abc\\\"def","wagoApiKey": "token\\\\value", "wowPath":"/Games"}`;
  const redacted = redactSecretsInText(input);
  assert.equal(redacted.includes("abc"), false);
  assert.equal(redacted.includes("token"), false);
  assert.equal(redacted.includes('"wowPath":"/Games"'), true);
  assert.equal((redacted.match(/<redacted>/g) || []).length, 2);
});

// Regression: redaction keyed only on the bare field name, so it silently did
// nothing to any file written since credentials became encrypted at rest —
// which is every file a current install produces.
test("corrupt settings redaction covers the encrypted field names", () => {
  const input = '{"curseApiKeyEnc":"Y2lwaGVydGV4dC1jdXJzZQ==","wagoApiKeyEnc": "Y2lwaGVydGV4dC13YWdv","wowPath":"/Games"}';
  const redacted = redactSecretsInText(input);
  assert.equal(redacted.includes("Y2lwaGVydGV4dC1jdXJzZQ=="), false, "curseApiKeyEnc ciphertext must not survive");
  assert.equal(redacted.includes("Y2lwaGVydGV4dC13YWdv"), false, "wagoApiKeyEnc ciphertext must not survive");
  assert.equal(redacted.includes('"wowPath":"/Games"'), true, "non-secret settings must be preserved");
  assert.equal((redacted.match(/<redacted>/g) || []).length, 2);
});

// A file mid-migration can hold both forms; neither may leak.
test("corrupt settings redaction covers both forms at once", () => {
  const input = '{"curseApiKey":"plain-secret","curseApiKeyEnc":"Y2lwaGVy","wowPath":"/Games"}';
  const redacted = redactSecretsInText(input);
  assert.equal(redacted.includes("plain-secret"), false);
  assert.equal(redacted.includes("Y2lwaGVy"), false);
  assert.equal((redacted.match(/<redacted>/g) || []).length, 2);
});

// Windows has no POSIX mode bits: fs.chmod there only toggles the read-only
// attribute and cannot express "owner only", so the mode assertions are skipped
// rather than asserted-and-failed. Access on Windows comes from the ACL that
// %APPDATA% already applies. The content assertions still run everywhere.
test("credential-bearing writes and copies are owner-only", { skip: process.platform === "win32" ? "POSIX modes are not enforced on Windows" : false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-credentials-"));
  const source = path.join(dir, "settings.json");
  const backup = `${source}.bak`;
  try {
    fs.writeFileSync(source, "old", { mode: 0o644 });
    secureWriteText(source, "new");
    secureCopyFile(source, backup);
    assert.equal(fs.statSync(source).mode & 0o777, OWNER_ONLY_MODE);
    assert.equal(fs.statSync(backup).mode & 0o777, OWNER_ONLY_MODE);
    assert.equal(fs.readFileSync(backup, "utf8"), "new");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The parts of secureWriteText/secureCopyFile that DO work everywhere.
test("credential-bearing writes and copies replace content on every platform", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-credentials-x"));
  const source = path.join(dir, "settings.json");
  const backup = `${source}.bak`;
  try {
    fs.writeFileSync(source, "old", { mode: 0o644 });
    secureWriteText(source, "new");
    secureCopyFile(source, backup);
    assert.equal(fs.readFileSync(source, "utf8"), "new");
    assert.equal(fs.readFileSync(backup, "utf8"), "new");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
