import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';

export default function PatientList() {
  const { api, user } = useAuth();
  const nav = useNavigate();
  const [patients, setPatients] = useState(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState(null);

  // Search runs on the server so each lookup lands in the audit log.
  // Debounced so typing a name writes one audit row, not one per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      const query = q.trim();
      api(query ? `/patients?q=${encodeURIComponent(query)}` : '/patients')
        .then((d) => { setPatients(d.patients); setError(null); })
        .catch((e) => setError(e.message));
    }, q ? 400 : 0);
    return () => clearTimeout(t);
  }, [api, q]);

  if (!patients && !error) return <p className="muted">Loading patients…</p>;

  const filtered = patients || [];

  return (
    <div>
      <div className="page-head">
        <h1>Patients</h1>
        <div className="page-head-actions">
          <input
            className="search"
            placeholder="Search by name"
            value={q}
            maxLength={60}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search patients by name"
          />
          {user.permissions.createPatient && (
            <button className="btn btn-primary" onClick={() => nav('/patients/new')}>New patient</button>
          )}
        </div>
      </div>
      <p className="muted small">This list shows demographics only. Sensitive fields decrypt on the record page. Every search and every record open is written to the audit log.</p>
      {error && <p className="error">{error}</p>}
      <table className="table">
        <thead>
          <tr><th>Name</th><th>Date of birth</th><th>Phone</th><th></th></tr>
        </thead>
        <tbody>
          {filtered.map((p) => (
            <tr key={p.id}>
              <td><Link to={`/patients/${p.id}`}>{p.lastName}, {p.firstName}</Link></td>
              <td className="mono">{new Date(p.dob).toLocaleDateString()}</td>
              <td className="mono">{p.phone}</td>
              <td className="td-open"><Link to={`/patients/${p.id}`}>Open record →</Link></td>
            </tr>
          ))}
          {filtered.length === 0 && (
            <tr><td colSpan="4" className="muted">No patients match that name.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
