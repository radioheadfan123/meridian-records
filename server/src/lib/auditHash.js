// Tamper-evidence for the append-only audit log: each row hashes the previous row's
// hash plus its own fields, so altering or deleting a historical row (even via direct
// DB access, which the API itself never allows) breaks every hash after it.
const crypto = require('crypto');

const GENESIS_HASH = crypto.createHash('sha256').update('meridian-records-audit-genesis').digest('hex');

function computeHash({ id, userId, action, patientId, fieldsAccessed, detail, ip, timestamp, prevHash }) {
  const payload = JSON.stringify({
    id,
    userId,
    action,
    patientId,
    fieldsAccessed,
    detail,
    ip,
    timestamp: new Date(timestamp).toISOString(),
    prevHash,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

module.exports = { GENESIS_HASH, computeHash };
