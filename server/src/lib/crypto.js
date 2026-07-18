// Field-level encryption for sensitive PHI (SSN, diagnosis, medication history).
// AES-256-GCM with a random IV per value. Output format: base64(iv):base64(authTag):base64(ciphertext)
// The key lives only in FIELD_ENCRYPTION_KEY (64 hex chars = 32 bytes) and never touches the DB,
// so ciphertext is what Supabase stores regardless of its own at-rest encryption.
//
// Documented limitation: no key rotation / versioning. A production system would prefix
// values with a key version and re-encrypt on rotation.

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

function getKey() {
  const hex = process.env.FIELD_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'FIELD_ENCRYPTION_KEY must be set to 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32'
    );
  }
  return Buffer.from(hex, 'hex');
}

function encryptField(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

function decryptField(stored) {
  if (!stored) return null;
  const [ivB64, tagB64, ctB64] = stored.split(':');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('Malformed encrypted field');
  const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}

module.exports = { encryptField, decryptField };
