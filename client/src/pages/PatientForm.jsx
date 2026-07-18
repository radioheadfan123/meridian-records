import { useState } from 'react';
import { useNavigate, Link, Navigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';

export default function PatientForm() {
  const { api, user } = useAuth();
  const nav = useNavigate();
  const [form, setForm] = useState({
    firstName: '', lastName: '', dob: '', phone: '', email: '', address: '', ssn: '', diagnosis: '', medicationHistory: '',
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (!user.permissions.createPatient) return <Navigate to="/patients" replace />;
  const canClinical = user.permissions.updateFields.includes('diagnosis');

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = { ...form };
    if (!canClinical) { delete body.diagnosis; delete body.medicationHistory; }
    if (!body.ssn) delete body.ssn;
    try {
      const d = await api('/patients', { method: 'POST', body });
      nav(`/patients/${d.patient.id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div>
      <Link to="/patients" className="backlink">← All patients</Link>
      <h1>New patient</h1>
      <p className="muted small">Use made-up details only. This is a public demo, so nothing real should be entered here.</p>
      <form className="card" onSubmit={submit}>
        <div className="form-grid">
          <label>First name<input value={form.firstName} onChange={set('firstName')} required /></label>
          <label>Last name<input value={form.lastName} onChange={set('lastName')} required /></label>
          <label>Date of birth<input type="date" value={form.dob} onChange={set('dob')} required /></label>
          <label>Phone<input value={form.phone} onChange={set('phone')} required /></label>
          <label>Email<input type="email" value={form.email} onChange={set('email')} /></label>
          <label>Address<input value={form.address} onChange={set('address')} /></label>
          <label>SSN <span className="sealed-tag">encrypted before storage</span>
            <input value={form.ssn} onChange={set('ssn')} placeholder="900-xx-xxxx (use a fake one)" />
          </label>
          {canClinical && (
            <>
              <label>Diagnosis <span className="sealed-tag">encrypted before storage</span>
                <input value={form.diagnosis} onChange={set('diagnosis')} />
              </label>
              <label>Medication history <span className="sealed-tag">encrypted before storage</span>
                <input value={form.medicationHistory} onChange={set('medicationHistory')} />
              </label>
            </>
          )}
        </div>
        {!canClinical && <p className="muted small">Clinical fields (diagnosis, medications) are added later by a provider.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="form-actions">
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create patient'}</button>
        </div>
      </form>
    </div>
  );
}
