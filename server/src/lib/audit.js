const prisma = require('./prisma');

// Every read and write of a patient record goes through here.
// Awaited by callers so a failed audit write fails the request:
// under HIPAA, an unauditable access should not happen silently.
async function audit({ userId, action, patientId = null, fieldsAccessed = [], detail = null, req = null }) {
  const ip = req ? (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null) : null;
  return prisma.auditLog.create({
    data: { userId, action, patientId, fieldsAccessed, detail, ip },
  });
}

module.exports = { audit };
