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

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`sealed:${value}`, "utf8"),
    decryptString: (value) => {
      const text = value.toString("utf8");
      if (!text.startsWith("sealed:")) throw new Error("bad ciphertext");
      return text.slice(7);
    },
  };
}

test("secret codec encrypts, decrypts, trims no data, and supports legacy fallback", () => {
  const codec = createSecretCodec(fakeSafeStorage());
  const encrypted = codec.encryptSecret("curse-key");
  assert.notEqual(encrypted, "curse-key");
  assert.deepEqual(codec.readSecrets({ curseApiKeyEnc: encrypted, wagoApiKey: "legacy-wago" }), {
    curseApiKey: "curse-key",
    wagoApiKey: "legacy-wago",
  });
  assert.equal(hasLegacySecrets({ curseApiKey: "legacy" }), true);
  assert.equal(hasLegacySecrets({ curseApiKeyEnc: encrypted }), false);
});

test("secret codec refuses to produce ciphertext when secure storage is unavailable", () => {
  const codec = createSecretCodec(fakeSafeStorage(false));
  assert.equal(codec.encryptionAvailable(), false);
  assert.equal(codec.encryptSecret("must-not-hit-disk"), "");
});

test("settings saves preserve, replace, and remove credentials without plaintext", () => {
  const codec = createSecretCodec(fakeSafeStorage());
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
