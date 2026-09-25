import { useEffect, useState } from 'react';
import { useAuth } from '../AuthContext';
import { download } from '../api';

const ACTIONS = ['', 'LOGIN', 'LOGIN_FAILED', 'LIST', 'READ', 'CREATE', 'UPDATE', 'DELETE', 'DENIED', 'BREAK_GLASS'];

const FLAG_LABEL = {
  BULK_READ: 'Bulk chart access',
  REPEATED_DENIED: 'Repeated blocked attempts',
  FAILED_LOGINS: 'Failed logins',
  OFF_HOURS: 'Off-hours access',
};

function Anomalies() {
  const { api } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api('/audit/anomalies?days=7').then(setData).catch((e) => setError(e.message));
  }, [api]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted small">Scanning the last 7 days for unusual access…</p>;
  return (
    <div className="card anomalies">
      <div className="anomalies-head">
        <strong>Review flags</strong>
        <span className="muted small">last {data.days} days, {data.scanned} entries scanned</span>
      </div>
      {data.flags.length === 0 ? (
        <p className="muted small">Nothing unusual. No bulk chart access, repeated blocked attempts, failed-login bursts or off-hours access.</p>
      ) : (
        <ul className="flag-list">
          {data.flags.map((f, i) => (
            <li key={i} className={`flag flag-${f.severity}`}>
              <span className="flag-type">{FLAG_LABEL[f.type] || f.type}</span>
              <span>{f.user ? `${f.user.name} (${f.user.role})` : 'Unknown user'} {f.detail}</span>
              <span className="mono small muted">
                {new Date(f.from).toLocaleString()}{f.to !== f.from ? ` to ${new Date(f.to).toLocaleString()}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">Flags mean "go look", not "someone did something wrong". A provider rounding on a full floor will open a lot of charts.</p>
    </div>
  );
}

export default function AuditLog() {
  const { api, token } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const [verify, setVerify] = useState(null);
  const [busy, setBusy] = useState('');

  async function runVerify() {
    setBusy('verify');
    try {
      setVerify(await api('/audit/verify'));
    } catch (e) {
      setVerify({ ok: false, reason: e.message });
    }
    setBusy('');
  }

  async function exportCsv() {
    setBusy('export');
    try {
      const params = new URLSearchParams();
      if (action) params.set('action', action);
      await download(`/audit/export?${params}`, {
        token,
        filename: `audit-log-${new Date().toISOString().slice(0, 10)}.csv`,
      });
    } catch (e) {
      setError(e.message);
    }
    setBusy('');
  }

  useEffect(() => {
    const params = new URLSearchParams({ page, pageSize: 25 });
    if (action) params.set('action', action);
    api(`/audit?${params}`).then(setData).catch((e) => setError(e.message));
  }, [api, action, page]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading audit trail…</p>;

  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));

  return (
    <div>
      <div className="page-head">
        <h1>Audit log</h1>
        <div className="page-head-actions">
          <select value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} aria-label="Filter by action">
            {ACTIONS.map((a) => <option key={a} value={a}>{a || 'All actions'}</option>)}
          </select>
          <button className="btn" onClick={runVerify} disabled={busy === 'verify'}>
            {busy === 'verify' ? 'Verifying…' : 'Verify chain'}
          </button>
          <button className="btn" onClick={exportCsv} disabled={busy === 'export'}>
            {busy === 'export' ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
      </div>
      {verify && (
        <p className={verify.ok ? 'verify-ok small' : 'error small'} role="status">
          {verify.ok
            ? `Hash chain intact: all ${verify.total} entries verified from genesis.`
            : `Chain check failed: ${verify.reason}${verify.brokenAt ? ` (row ${verify.brokenAt})` : ''}`}
        </p>
      )}
      <Anomalies />
      <p className="muted small">
        Append-only record of every access. {data.total} entries. Reads are logged, not just writes, DENIED rows
        show blocked attempts, and BREAK_GLASS rows show emergency overrides that need review. Exporting is
        logged too.
      </p>
      <table className="table audit-table">
        <thead>
          <tr><th>When</th><th>Who</th><th>Action</th><th>Patient</th><th>Fields</th><th>Detail</th><th>IP</th></tr>
        </thead>
        <tbody>
          {data.logs.map((l) => (
            <tr
              key={l.id}
              className={
                l.action === 'BREAK_GLASS'
                  ? 'row-breakglass'
                  : l.action === 'DENIED' || l.action === 'LOGIN_FAILED'
                  ? 'row-denied'
                  : ''
              }
            >
              <td className="mono small">{new Date(l.timestamp).toLocaleString()}</td>
              <td>{l.user.name}<div className="muted small">{l.user.role}</div></td>
              <td><span className={`action-chip action-${l.action}`}>{l.action}</span></td>
              <td>{l.patient ? `${l.patient.lastName}, ${l.patient.firstName}` : l.patientId ? '(deleted)' : '—'}</td>
              <td className="mono small">{l.fieldsAccessed.join(', ') || '—'}</td>
              <td className="small">{l.detail || '—'}</td>
              <td className="mono small">{l.ip || '—'}</td>
            </tr>
          ))}
          {data.logs.length === 0 && <tr><td colSpan="7" className="muted">No entries match this filter.</td></tr>}
        </tbody>
      </table>
      <div className="pager">
        <button className="btn btn-ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Newer</button>
        <span className="muted small">Page {page} of {pages}</span>
        <button className="btn btn-ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>Older →</button>
      </div>
    </div>
  );
}
