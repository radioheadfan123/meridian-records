import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../AuthContext';

const SENSITIVE = [
  { key: 'ssn', label: 'SSN' },
  { key: 'diagnosis', label: 'Diagnosis' },
  { key: 'medicationHistory', label: 'Medication history' },
];

function SealedField({ label, value, canView }) {
  const [revealed, setRevealed] = useState(false);
  if (!canView) {
    return (
      <div className="sealed sealed-denied">
        <div className="sealed-label">{label}</div>
        <div className="sealed-body">Not visible to your role</div>
      </div>
    );
  }
  return (
    <div className="sealed">
      <div className="sealed-label">{label} <span className="sealed-tag">encrypted at field level</span></div>
      <div className="sealed-body mono">
        {revealed ? (value ?? <span className="muted">not on file</span>) : '••••••••••••'}
      </div>
      <button className="btn btn-ghost btn-sm" onClick={() => setRevealed(!revealed)}>
        {revealed ? 'Hide' : 'Reveal'}
      </button>
    </div>
  );
}

export default function PatientDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { api, user } = useAuth();
  const [patient, setPatient] = useState(null);
  const [breakGlass, setBreakGlass] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [saveError, setSaveError] = useState(null);
  const [bgOpen, setBgOpen] = useState(false);
  const [bgReason, setBgReason] = useState('');
  const [bgError, setBgError] = useState(null);
  const [bgSubmitting, setBgSubmitting] = useState(false);

  const load = useCallback(() => {
    api(`/patients/${id}`)
      .then((d) => {
        setPatient(d.patient);
        setBreakGlass(d.breakGlass);
      })
      .catch((e) => setError(e.message));
  }, [api, id]);

  useEffect(load, [load]);

  async function requestBreakGlass(e) {
    e.preventDefault();
    setBgError(null);
    setBgSubmitting(true);
    try {
      await api(`/patients/${id}/break-glass`, { method: 'POST', body: { reason: bgReason } });
      setBgOpen(false);
      setBgReason('');
      load();
    } catch (err) {
      setBgError(err.message);
    } finally {
      setBgSubmitting(false);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!patient) return <p className="muted">Opening record… (this access is being logged)</p>;

  const perms = user.permissions;
  const canEditAnything = perms.updateFields.length > 0;
  const editableSensitive = SENSITIVE.filter((f) => perms.updateFields.includes(f.key));
  const editableDemo = ['firstName', 'lastName', 'phone', 'email', 'address'].filter((f) =>
    perms.updateFields.includes(f)
  );

  function startEdit() {
    setForm({
      ...Object.fromEntries(editableDemo.map((f) => [f, patient[f] ?? ''])),
      ...Object.fromEntries(editableSensitive.map((f) => [f.key, patient[f.key] ?? ''])),
    });
    setSaveError(null);
    setEditing(true);
  }

  async function save(e) {
    e.preventDefault();
    setSaveError(null);
    try {
      await api(`/patients/${id}`, { method: 'PUT', body: form });
      setEditing(false);
      load();
    } catch (err) {
      setSaveError(err.message);
    }
  }

  async function del() {
    if (!confirm(`Delete the record for ${patient.firstName} ${patient.lastName}? The audit trail is kept.`)) return;
    try {
      await api(`/patients/${id}`, { method: 'DELETE' });
      nav('/patients');
    } catch (err) {
      setError(err.message);
    }
  }

  const FIELD_LABEL = {
    firstName: 'First name', lastName: 'Last name', phone: 'Phone', email: 'Email', address: 'Address',
  };

  return (
    <div>
      <Link to="/patients" className="backlink">← All patients</Link>
      <div className="page-head">
        <h1>{patient.firstName} {patient.lastName}</h1>
        <div className="page-head-actions">
          {canEditAnything && !editing && <button className="btn" onClick={startEdit}>Edit record</button>}
          {perms.deletePatient && !editing && <button className="btn btn-danger" onClick={del}>Delete</button>}
        </div>
      </div>
      <p className="access-note">Opening this record wrote a READ entry to the audit log under your name{user.role === 'ADMIN' ? '' : ' (visible to administrators)'}.</p>

      {!editing && (
        <>
          <section className="card">
            <h2>Demographics</h2>
            <dl className="dl">
              <dt>Date of birth</dt><dd className="mono">{new Date(patient.dob).toLocaleDateString()}</dd>
              <dt>Phone</dt><dd className="mono">{patient.phone}</dd>
              <dt>Email</dt><dd className="mono">{patient.email || '—'}</dd>
              <dt>Address</dt><dd>{patient.address || '—'}</dd>
            </dl>
          </section>
          <section className="card">
            <div className="page-head">
              <h2>Protected fields</h2>
              {breakGlass?.active ? null : (
                <button className="btn btn-ghost btn-sm btn-danger" onClick={() => setBgOpen(!bgOpen)}>
                  {bgOpen ? 'Cancel' : 'Request emergency access'}
                </button>
              )}
            </div>

            {breakGlass?.active && (
              <p className="access-note access-note-urgent">
                Emergency access active until {new Date(breakGlass.expiresAt).toLocaleTimeString()}. Reason on file:
                &ldquo;{breakGlass.reason}&rdquo;. Every field opened under this grant is logged as BREAK_GLASS for
                admin review.
              </p>
            )}

            {bgOpen && !breakGlass?.active && (
              <form className="break-glass-form" onSubmit={requestBreakGlass}>
                <p className="muted small">
                  Bypasses your role's normal field restrictions. Requires a reason, expires in 15 minutes, and is
                  logged loudly for admin review.
                </p>
                <label>
                  Reason for emergency access
                  <textarea
                    value={bgReason}
                    onChange={(e) => setBgReason(e.target.value)}
                    minLength={10}
                    required
                    rows={2}
                  />
                </label>
                {bgError && <p className="error" role="alert">{bgError}</p>}
                <div className="form-actions">
                  <button className="btn btn-danger" type="submit" disabled={bgSubmitting}>
                    {bgSubmitting ? 'Requesting…' : 'Confirm emergency access'}
                  </button>
                </div>
              </form>
            )}

            <div className="sealed-grid">
              {SENSITIVE.map((f) => (
                <SealedField key={f.key} label={f.label} value={patient[f.key]} canView={patient[f.key] !== undefined} />
              ))}
            </div>
          </section>
        </>
      )}

      {editing && (
        <form className="card" onSubmit={save}>
          <h2>Edit record</h2>
          <p className="muted small">You can only change the fields your role allows. The server enforces this too.</p>
          {editableDemo.map((f) => (
            <label key={f}>
              {FIELD_LABEL[f]}
              <input value={form[f]} onChange={(e) => setForm({ ...form, [f]: e.target.value })} />
            </label>
          ))}
          {editableSensitive.map((f) => (
            <label key={f.key}>
              {f.label} <span className="sealed-tag">encrypted before storage</span>
              <input value={form[f.key]} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
            </label>
          ))}
          {saveError && <p className="error" role="alert">{saveError}</p>}
          <div className="form-actions">
            <button className="btn btn-primary" type="submit">Save changes</button>
            <button className="btn btn-ghost" type="button" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
