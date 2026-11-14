const fs = require("fs");

const SECRET_FIELDS = ["curseApiKey", "wagoApiKey"];
const OWNER_ONLY_MODE = 0o600;

// Electron's safeStorage is async-only from Electron 46 (the sync
// encryptString/decryptString were deprecated in 45). The rest of the app reads
// settings synchronously, so the async work happens at two well-defined points
// and is cached here:
//   init(blobs)      — at startup: check availability and decrypt every stored
//                      ciphertext once (data written by the old sync API
//                      decrypts with decryptStringAsync).
//   prepare(values)  — before a save that may carry a new credential: encrypt
//                      it ahead of time.
// encryptSecret/decryptSecret stay synchronous and only read the cache. A
// value that was never prepared encrypts to "" — the existing save path then
// refuses to store it rather than writing plaintext.
function createSecretCodec(safeStorage) {
  let available = false;
  const plainOf = new Map(); // ciphertext (base64) -> plaintext
  const sealedOf = new Map(); // plaintext -> ciphertext (base64)

  function remember(blob, plain) {
    plainOf.set(blob, plain);
    sealedOf.set(plain, blob);
  }

  async function init(blobs = []) {
    try { available = !!(await safeStorage.isAsyncEncryptionAvailable()); } catch { available = false; }
    let needsReEncrypt = false;
    for (const blob of new Set(blobs.filter(Boolean))) {
      if (plainOf.has(blob)) continue;
      try {
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(blob, "base64"));
        if (typeof result !== "string") continue;
        remember(blob, result);
        if (shouldReEncrypt) needsReEncrypt = true;
      } catch { /* undecryptable (other OS account, reset keychain): treated as absent */ }
    }
    return { needsReEncrypt };
  }

  // Encrypt values ahead of a save. Values already sealed are reused unless
  // `force` (key rotation asked for a fresh ciphertext).
  async function prepare(values = [], { force = false } = {}) {
    if (!available) return;
    for (const value of new Set(values.filter((v) => typeof v === "string" && v))) {
      if (!force && sealedOf.has(value)) continue;
      try {
        const blob = (await safeStorage.encryptStringAsync(value)).toString("base64");
        remember(blob, value);
      } catch { /* left unsealed; the save will refuse it */ }
    }
  }

  function encryptionAvailable() {
    return available;
  }

  // Reusing a ciphertext we already hold needs no encryptor, so an unrelated
  // save keeps working even if the OS credential service went away since
  // startup. Only new values (sealed by prepare) need encryption available.
  function encryptSecret(value) {
    if (!value) return "";
    return sealedOf.get(value) || "";
  }

  function decryptSecret(blob) {
    if (!blob) return "";
    return plainOf.get(blob) || "";
  }

  function readSecrets(raw) {
    const out = {};
    for (const field of SECRET_FIELDS) {
      const encrypted = raw && raw[`${field}Enc`];
      // Keep the plaintext fallback for legacy migrations interrupted after
      // encryption but before the old field was removed.
      out[field] = (encrypted ? decryptSecret(encrypted) : "") || (raw && raw[field]) || "";
    }
    return out;
  }

  return { init, prepare, encryptionAvailable, encryptSecret, decryptSecret, readSecrets };
}

function hasLegacySecrets(raw) {
  return !!raw && SECRET_FIELDS.some((field) => raw[field]);
}

function redactSecretsInText(text) {
  let out = String(text || "");
  for (const field of SECRET_FIELDS) {
    // Both on-disk forms must be covered. Credentials are stored as
    // "<field>Enc" (ciphertext) and only legacy files still carry the bare
    // "<field>". Matching just the bare name made this a no-op on every file
    // written since encryption at rest landed.
    for (const name of [field, `${field}Enc`]) {
      // Match a complete JSON string, including escaped quotes and backslashes.
      const value = '"(?:\\\\.|[^"\\\\])*"';
      out = out.replace(new RegExp(`("${name}"\\s*:\\s*)${value}`, "g"), '$1"<redacted>"');
    }
  }
  return out;
}

function hardenFile(file) {
  try { fs.chmodSync(file, OWNER_ONLY_MODE); } catch { /* absent or unsupported */ }
}

function secureWriteText(file, text) {
  fs.writeFileSync(file, text, { encoding: "utf8", mode: OWNER_ONLY_MODE });
  // writeFileSync does not change the mode of an existing file.
  hardenFile(file);
}

function secureCopyFile(source, destination) {
  fs.copyFileSync(source, destination);
  hardenFile(destination);
}

function applySecretsForSave(copy, existing, suppliedSecrets, encryptSecret) {
  for (const field of SECRET_FIELDS) {
    const explicitlySupplied = Object.prototype.hasOwnProperty.call(suppliedSecrets, field);
    const plain = explicitlySupplied ? suppliedSecrets[field] : "";
    delete copy[field];
    delete copy[`${field}Enc`];
    if (explicitlySupplied) {
      if (!plain) continue;
      const encrypted = encryptSecret(plain);
      if (encrypted) copy[`${field}Enc`] = encrypted;
      else if (existing[field] === plain) copy[field] = plain;
      else throw new Error("Secure credential storage is unavailable. The API key was not saved.");
    } else if (existing[`${field}Enc`]) {
      copy[`${field}Enc`] = existing[`${field}Enc`];
    } else if (existing[field]) {
      copy[field] = existing[field];
    }
  }
  return copy;
}

module.exports = {
  SECRET_FIELDS,
  OWNER_ONLY_MODE,
  createSecretCodec,
  hasLegacySecrets,
  redactSecretsInText,
  hardenFile,
  secureWriteText,
  secureCopyFile,
  applySecretsForSave,
};
