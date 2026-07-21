// Optional bundled API keys, for handing a ready-to-run build to someone who
// shouldn't have to get their own keys (e.g. family).
//
// HONEST SECURITY NOTE: the passphrase lives in this source, so this is
// obfuscation, not real protection — a determined person can recover the keys.
// It only stops casual discovery (keys aren't sitting in plain text). Never
// publish a bundled build; the embedded key is tied to the author's account.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Not a secret in any real sense — see the note above.
const PASSPHRASE = "grimoire-bundled-v1-do-not-share-builds";
const FILE = "bundled.dat";

function keyFrom(salt) {
  return crypto.scryptSync(PASSPHRASE, salt, 32);
}

function encrypt(obj) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFrom(salt), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, enc]).toString("base64");
}

function decrypt(b64) {
  const raw = Buffer.from(b64, "base64");
  const salt = raw.subarray(0, 16);
  const iv = raw.subarray(16, 28);
  const tag = raw.subarray(28, 44);
  const enc = raw.subarray(44);
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyFrom(salt), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(dec.toString("utf8"));
}

// Read keys baked into the app bundle, if any. Returns {} when this is a
// clean build (no bundled.dat present) or the file can't be read.
function readBundledKeys(appDir) {
  try {
    const p = path.join(appDir, FILE);
    if (!fs.existsSync(p)) return {};
    return decrypt(fs.readFileSync(p, "utf8")) || {};
  } catch {
    return {};
  }
}

module.exports = { encrypt, decrypt, readBundledKeys, FILE };
