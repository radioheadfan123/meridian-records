import { useEffect, useState } from 'react';
import { useAuth } from '../AuthContext';

const ACTIONS = ['', 'LOGIN', 'LOGIN_FAILED', 'LIST', 'READ', 'CREATE', 'UPDATE', 'DELETE', 'DENIED', 'BREAK_GLASS'];

export default function AuditLog() {
  const { api } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);

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
        </div>
      </div>
      <p className="muted small">
        Append-only record of every access. {data.total} entries. Reads are logged, not just writes, DENIED rows
        show blocked attempts, and BREAK_GLASS rows show emergency overrides that need review.
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
