import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../AuthContext';

const ROLE_LABEL = { ADMIN: 'Administrator', PROVIDER: 'Provider', FRONT_DESK: 'Front desk' };

export default function Staff() {
  const { api } = useAuth();
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => {
    api('/users').then((d) => setUsers(d.users)).catch((e) => setError(e.message));
  }, [api]);
  useEffect(load, [load]);

  async function unlock(u) {
    setBusy(u.id);
    try {
      await api(`/users/${u.id}/unlock`, { method: 'POST' });
      load();
    } catch (e) {
      setError(e.message);
    }
    setBusy(null);
  }

  if (error) return <p className="error">{error}</p>;
  if (!users) return <p className="muted">Loading staff accounts…</p>;

  return (
    <div>
      <div className="page-head"><h1>Staff accounts</h1></div>
      <p className="muted small">
        Five wrong passwords lock an account for 15 minutes. Unlocking early is written to the audit log with the
        lockout it cleared.
      </p>
      <table className="table">
        <thead>
          <tr><th>Name</th><th>Role</th><th>Failed attempts</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className={u.locked ? 'row-denied' : ''}>
              <td>{u.name}<div className="muted small">{u.email}</div></td>
              <td>{ROLE_LABEL[u.role]}</td>
              <td className="mono">{u.failedAttempts}</td>
              <td className="small">
                {u.locked ? `Locked until ${new Date(u.lockedUntil).toLocaleTimeString()}` : 'Active'}
              </td>
              <td className="td-open">
                {(u.locked || u.failedAttempts > 0) && (
                  <button className="btn btn-sm" onClick={() => unlock(u)} disabled={busy === u.id}>
                    {u.locked ? 'Unlock' : 'Reset count'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
