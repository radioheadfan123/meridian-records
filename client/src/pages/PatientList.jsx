import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';

export default function PatientList() {
  const { api, user } = useAuth();
  const nav = useNavigate();
  const [patients, setPatients] = useState(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    api('/patients').then((d) => setPatients(d.patients)).catch((e) => setError(e.message));
  }, [api]);

  if (error) return <p className="error">{error}</p>;
  if (!patients) return <p className="muted">Loading patients…</p>;

  const filtered = patients.filter((p) =>
    `${p.firstName} ${p.lastName}`.toLowerCase().includes(q.toLowerCase())
  );

  return (
    <div>
      <div className="page-head">
        <h1>Patients</h1>
        <div className="page-head-actions">
          <input
            className="search"
            placeholder="Filter by name"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Filter patients by name"
          />
          {user.permissions.createPatient && (
            <button className="btn btn-primary" onClick={() => nav('/patients/new')}>New patient</button>
          )}
        </div>
      </div>
      <p className="muted small">This list shows demographics only. Sensitive fields decrypt on the record page, and each open is written to the audit log.</p>
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
