// No lib/prisma mock needed - crypto.js touches only env vars and node:crypto.

const ORIGINAL_ENV = { ...process.env };

function clearKeys() {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('FIELD_ENCRYPTION_KEY')) delete process.env[k];
  }
}

function freshCrypto() {
  jest.resetModules();
  return require('../lib/crypto');
}

const KEY_V1 = '1'.repeat(64);
const KEY_V2 = '2'.repeat(64);

// The global test setup (test-support/env.setup.js) sets a dummy FIELD_ENCRYPTION_KEY
// so app.js's boot check passes in every other test file. Cleared here so each test in
// this file starts from a genuinely empty key state and opts in to whatever it needs.
beforeEach(clearKeys);
afterAll(() => {
  clearKeys();
  Object.assign(process.env, ORIGINAL_ENV);
});

test('round-trips a value under a single key', () => {
  process.env.FIELD_ENCRYPTION_KEY = KEY_V1;
  const { encryptField, decryptField } = freshCrypto();
  expect(decryptField(encryptField('900-11-2222'))).toBe('900-11-2222');
});

test('null/undefined/empty string all encrypt to null and decrypt back to null', () => {
  process.env.FIELD_ENCRYPTION_KEY = KEY_V1;
  const { encryptField, decryptField } = freshCrypto();
  for (const v of [null, undefined, '']) {
    expect(encryptField(v)).toBeNull();
  }
  expect(decryptField(null)).toBeNull();
});

test('new encryptions use the highest available version, and stamp it in the output', () => {
  process.env.FIELD_ENCRYPTION_KEY = KEY_V1; // v1
  process.env.FIELD_ENCRYPTION_KEY_V2 = KEY_V2;
  const { encryptField, storedVersion, currentActiveVersion } = freshCrypto();
  expect(currentActiveVersion()).toBe(2);
  const stored = encryptField('secret');
  expect(stored.startsWith('v2:')).toBe(true);
  expect(storedVersion(stored)).toBe(2);
});

test('a value encrypted under an old version still decrypts once that key is still present', () => {
  process.env.FIELD_ENCRYPTION_KEY = KEY_V1;
  let mod = freshCrypto();
  const v1Ciphertext = mod.encryptField('old secret');

  // Rotate: v2 becomes active, but v1 key is still configured for reading old rows.
  process.env.FIELD_ENCRYPTION_KEY_V2 = KEY_V2;
  mod = freshCrypto();
  expect(mod.decryptField(v1Ciphertext)).toBe('old secret');
  expect(mod.storedVersion(v1Ciphertext)).toBe(1);
});

test('pre-rotation 3-part ciphertext (no version prefix) is treated as v1', () => {
  process.env.FIELD_ENCRYPTION_KEY = KEY_V1;
  const { encryptField, decryptField, storedVersion } = freshCrypto();
  const versioned = encryptField('legacy-shaped value');
  // Strip the "v1:" prefix to simulate a value written before this feature existed.
  const legacyShaped = versioned.replace(/^v1:/, '');
  expect(storedVersion(legacyShaped)).toBe(1);
  expect(decryptField(legacyShaped)).toBe('legacy-shaped value');
});

test('decrypting a version whose key is no longer configured throws a clear error', () => {
  process.env.FIELD_ENCRYPTION_KEY = KEY_V1;
  let mod = freshCrypto();
  const v1Ciphertext = mod.encryptField('will be orphaned');

  // v1 key removed entirely, only v2 remains - simulates finishing a rotation
  // and retiring the old key before every row was actually re-encrypted.
  delete process.env.FIELD_ENCRYPTION_KEY;
  process.env.FIELD_ENCRYPTION_KEY_V2 = KEY_V2;
  mod = freshCrypto();
  expect(() => mod.decryptField(v1Ciphertext)).toThrow(/FIELD_ENCRYPTION_KEY_V1/);
});

test('a malformed stored value throws instead of silently returning garbage', () => {
  process.env.FIELD_ENCRYPTION_KEY = KEY_V1;
  const { decryptField } = freshCrypto();
  expect(() => decryptField('not-the-right-shape')).toThrow(/Malformed/);
});

test('no key configured at all throws on first use, not silently', () => {
  const { encryptField } = freshCrypto();
  expect(() => encryptField('anything')).toThrow(/No encryption key set/);
});
