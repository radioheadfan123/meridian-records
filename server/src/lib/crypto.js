// Field-level encryption for sensitive PHI (SSN, diagnosis, medication history).
// AES-256-GCM with a random IV per value. Output format: v<version>:base64(iv):base64(authTag):base64(ciphertext)
// The key(s) live only in env vars and never touch the DB, so ciphertext is what
// Supabase stores regardless of its own at-rest encryption.
//
// Key rotation: FIELD_ENCRYPTION_KEY is always version 1 (unchanged from before this
// feature existed, so a deploy with no other changes keeps working with zero config).
// To rotate, add FIELD_ENCRYPTION_KEY_V2 (a freshly generated key) alongside it - new
// encryptions immediately start using the highest version present, while decryption
// still reads whichever version a value was written under, including old unversioned
// ciphertext (3 parts instead of 4), which is treated as v1. Old rows stay readable
// until scripts/reencrypt-to-latest.js migrates them; nothing breaks mid-rotation.

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

function parseKey(envVarName, hex) {
  if (!hex || hex.length !== 64) {
    throw new Error(`${envVarName} must be set to 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32`);
  }
  return Buffer.from(hex, 'hex');
}

function loadKeys() {
  const keys = {};
  if (process.env.FIELD_ENCRYPTION_KEY) {
    keys[1] = parseKey('FIELD_ENCRYPTION_KEY', process.env.FIELD_ENCRYPTION_KEY);
  }
  for (const [name, value] of Object.entries(process.env)) {
    const m = name.match(/^FIELD_ENCRYPTION_KEY_V(\d+)$/);
    if (m && value) {
      keys[Number(m[1])] = parseKey(name, value);
    }
  }
  return keys;
}

function requireKeys() {
  const keys = loadKeys();
  if (Object.keys(keys).length === 0) {
    throw new Error(
      'No encryption key set. Set FIELD_ENCRYPTION_KEY (64 hex chars): openssl rand -hex 32'
    );
  }
  return keys;
}

function activeVersion(keys) {
  return Math.max(...Object.keys(keys).map(Number));
}

function encryptField(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const keys = requireKeys();
  const version = activeVersion(keys);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, keys[version], iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v${version}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

function decryptField(stored) {
  if (!stored) return null;
  const parts = stored.split(':');
  const keys = requireKeys();

  let version, ivB64, tagB64, ctB64;
  if (parts.length === 4) {
    const m = parts[0].match(/^v(\d+)$/);
    if (!m) throw new Error('Malformed encrypted field: bad version prefix');
    version = Number(m[1]);
    [, ivB64, tagB64, ctB64] = parts;
  } else if (parts.length === 3) {
    // Pre-rotation format, written before versioning existed. Implicitly v1.
    version = 1;
    [ivB64, tagB64, ctB64] = parts;
  } else {
    throw new Error('Malformed encrypted field');
  }

  const key = keys[version];
  if (!key) {
    throw new Error(`No key available for version ${version}. Set FIELD_ENCRYPTION_KEY_V${version}.`);
  }

  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}

// Exposed for the re-encrypt script: which version a stored value is under, and
// what the current active (newest) version is, without decrypting anything.
function storedVersion(stored) {
  if (!stored) return null;
  const parts = stored.split(':');
  if (parts.length === 4) return Number(parts[0].match(/^v(\d+)$/)?.[1]);
  if (parts.length === 3) return 1;
  return null;
}

function currentActiveVersion() {
  return activeVersion(requireKeys());
}

module.exports = { encryptField, decryptField, storedVersion, currentActiveVersion };
