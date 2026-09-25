// Audit anomaly flags: patterns in the audit log that a privacy officer would want
// to look at. Real hospitals catch snooping this way - after the fact, from the logs -
// because blocking access up front is a patient-safety risk. This is that review step.
//
// Pure function over audit rows so it's testable without a database. Nothing here is
// a verdict: a doctor reading 12 charts in an hour might just be rounding. Flags are
// "go look", not "this person did something wrong".

const HOUR = 60 * 60 * 1000;

const DEFAULTS = {
  // distinct patient charts opened by one user inside any rolling hour
  bulkReadThreshold: 8,
  // DENIED rows by one user inside any rolling hour (someone probing past their role)
  deniedThreshold: 3,
  // LOGIN_FAILED rows on one account inside any rolling hour. Lockout fires at 5,
  // so 3 is the "someone is trying" warning before the lock does its job.
  failedLoginThreshold: 3,
  // clinic hours, local time: [start, end)
  businessHours: [7, 19],
  timeZone: process.env.CLINIC_TIMEZONE || 'America/Chicago',
};

const CHART_ACCESS = new Set(['READ', 'BREAK_GLASS', 'UPDATE', 'CREATE', 'DELETE']);

function localHour(date, timeZone) {
  const h = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(date);
  return Number(h);
}

function byUser(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.userId)) m.set(r.userId, []);
    m.get(r.userId).push(r);
  }
  for (const list of m.values()) list.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return m;
}

// Largest number of rows (or distinct keys, when keyOf is given) inside any rolling
// window of `windowMs`. Two-pointer sweep over time-sorted rows.
function peakWindow(rows, windowMs, keyOf = null) {
  let best = { count: 0, from: null, to: null };
  let lo = 0;
  const counts = new Map();
  for (let hi = 0; hi < rows.length; hi++) {
    const k = keyOf ? keyOf(rows[hi]) : hi;
    counts.set(k, (counts.get(k) || 0) + 1);
    while (new Date(rows[hi].timestamp) - new Date(rows[lo].timestamp) > windowMs) {
      const lk = keyOf ? keyOf(rows[lo]) : lo;
      const n = counts.get(lk) - 1;
      if (n === 0) counts.delete(lk);
      else counts.set(lk, n);
      lo++;
    }
    if (counts.size > best.count) {
      best = { count: counts.size, from: rows[lo].timestamp, to: rows[hi].timestamp };
    }
  }
  return best;
}

function findAnomalies(rows, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const flags = [];
  const users = byUser(rows);

  for (const [userId, list] of users) {
    const reads = list.filter((r) => (r.action === 'READ' || r.action === 'BREAK_GLASS') && r.patientId);
    const bulk = peakWindow(reads, HOUR, (r) => r.patientId);
    if (bulk.count >= o.bulkReadThreshold) {
      flags.push({
        type: 'BULK_READ', severity: 'high', userId, count: bulk.count, from: bulk.from, to: bulk.to,
        detail: `opened ${bulk.count} different patient charts within one hour`,
      });
    }

    const denied = peakWindow(list.filter((r) => r.action === 'DENIED'), HOUR);
    if (denied.count >= o.deniedThreshold) {
      flags.push({
        type: 'REPEATED_DENIED', severity: 'medium', userId, count: denied.count, from: denied.from, to: denied.to,
        detail: `${denied.count} blocked attempts within one hour`,
      });
    }

    const failed = peakWindow(list.filter((r) => r.action === 'LOGIN_FAILED'), HOUR);
    if (failed.count >= o.failedLoginThreshold) {
      flags.push({
        type: 'FAILED_LOGINS', severity: 'medium', userId, count: failed.count, from: failed.from, to: failed.to,
        detail: `${failed.count} failed logins within one hour`,
      });
    }

    const [start, end] = o.businessHours;
    const off = list.filter((r) => {
      if (!CHART_ACCESS.has(r.action)) return false;
      const h = localHour(new Date(r.timestamp), o.timeZone);
      return h < start || h >= end;
    });
    if (off.length) {
      flags.push({
        type: 'OFF_HOURS', severity: 'low', userId, count: off.length,
        from: off[0].timestamp, to: off[off.length - 1].timestamp,
        detail: `${off.length} chart access${off.length === 1 ? '' : 'es'} outside ${start}:00-${end}:00 (${o.timeZone})`,
      });
    }
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return flags.sort((a, b) => rank[a.severity] - rank[b.severity] || b.count - a.count);
}

module.exports = { findAnomalies, DEFAULTS };
