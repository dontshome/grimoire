const fs = require("fs");

const SECRET_FIELDS = ["curseApiKey", "wagoApiKey"];
const OWNER_ONLY_MODE = 0o600;

function createSecretCodec(safeStorage) {
  function encryptionAvailable() {
    try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
  }

  function encryptSecret(value) {
    if (!value || !encryptionAvailable()) return "";
    try { return safeStorage.encryptString(value).toString("base64"); } catch { return ""; }
  }

  function decryptSecret(blob) {
    if (!blob) return "";
    try { return safeStorage.decryptString(Buffer.from(blob, "base64")); } catch { return ""; }
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

  return { encryptionAvailable, encryptSecret, decryptSecret, readSecrets };
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
