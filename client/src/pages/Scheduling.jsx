import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../AuthContext';

// The visible half of the scoped scheduling view. What it is meant to make obvious
// on screen: the front desk is looking at scheduling context, not a chart. The
// reason line is a scheduling note and says so, and there is nothing clinical on
// this panel for any role. Server-side rules still decide everything - hiding a
// button here is cosmetic, exactly as elsewhere in this app.

const VISIT_TYPES = [
  ['NEW_PATIENT', 'New patient'],
  ['FOLLOW_UP', 'Follow-up'],
  ['ANNUAL_PHYSICAL', 'Annual physical'],
  ['LAB_REVIEW', 'Lab review'],
  ['VACCINATION', 'Vaccination'],
  ['TELEHEALTH', 'Telehealth'],
  ['URGENT', 'Urgent'],
];

const STATUS_LABEL = {
  SCHEDULED: 'Scheduled',
  CHECKED_IN: 'Checked in',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No show',
};

const VISIT_LABEL = Object.fromEntries(VISIT_TYPES);

function when(iso, durationMinutes) {
  const start = new Date(iso);
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
  const time = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${start.toLocaleDateString()} · ${time(start)}–${time(end)}`;
}

export default function Scheduling({ patientId }) {
  const { api, user } = useAuth();
  const perms = user.permissions.appointments;

  const [appointments, setAppointments] = useState(null);
  const [error, setError] = useState(null);
  const [booking, setBooking] = useState(false);
  const [form, setForm] = useState({ visitType: 'FOLLOW_UP', reason: '', startsAt: '', durationMinutes: 30 });
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api(`/appointments?patientId=${patientId}`)
      .then((d) => setAppointments(d.appointments))
      .catch((e) => setError(e.message));
  }, [api, patientId]);

  useEffect(load, [load]);

  async function book(e) {
    e.preventDefault();
    setFormError(null);
    setSaving(true);
    try {
      await api('/appointments', {
        method: 'POST',
        body: {
          patientId,
          visitType: form.visitType,
          reason: form.reason,
          startsAt: new Date(form.startsAt).toISOString(),
          durationMinutes: Number(form.durationMinutes),
        },
      });
      setBooking(false);
      setForm({ visitType: 'FOLLOW_UP', reason: '', startsAt: '', durationMinutes: 30 });
      load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(id, status) {
    try {
      await api(`/appointments/${id}/status`, { method: 'PATCH', body: { status } });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!perms?.view) return null;

  return (
    <section className="card">
      <div className="page-head">
        <h2>Scheduling</h2>
        {perms.schedule && (
          <button className="btn btn-ghost btn-sm" onClick={() => setBooking(!booking)}>
            {booking ? 'Cancel' : 'Book appointment'}
          </button>
        )}
      </div>

      <p className="muted small">
        Visit type and scheduling reason only. This is the minimum needed to run a calendar, so it is visible to the
        front desk. The clinical record above is not.
      </p>

      {booking && (
        <form className="break-glass-form" onSubmit={book}>
          <label>
            Visit type
            <select value={form.visitType} onChange={(e) => setForm({ ...form, visitType: e.target.value })}>
              {VISIT_TYPES.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            Date and time
            <input
              type="datetime-local"
              value={form.startsAt}
              onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
              required
            />
          </label>
          <label>
            Duration (minutes)
            <input
              type="number"
              min={5}
              max={480}
              value={form.durationMinutes}
              onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })}
            />
          </label>
          <label>
            Scheduling reason <span className="sealed-tag">encrypted before storage</span>
            <input
              value={form.reason}
              maxLength={200}
              placeholder="e.g. follow-up on lab results"
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
          </label>
          {formError && <p className="error" role="alert">{formError}</p>}
          <div className="form-actions">
            <button className="btn btn-primary" type="submit" disabled={saving}>
              {saving ? 'Booking…' : 'Book'}
            </button>
          </div>
        </form>
      )}

      {error && <p className="error" role="alert">{error}</p>}
      {!appointments && !error && <p className="muted">Loading schedule…</p>}
      {appointments?.length === 0 && <p className="muted">No appointments on file.</p>}

      {appointments?.map((a) => (
        <div key={a.id} className="appt">
          <div className="appt-main">
            <div className="appt-when mono">{when(a.startsAt, a.durationMinutes)}</div>
            <div className="appt-type">{VISIT_LABEL[a.visitType] || a.visitType}</div>
            {a.reason !== undefined && (
              <div className="appt-reason">
                {a.reason || <span className="muted">no reason on file</span>}
                <span className="sealed-tag">encrypted at field level</span>
              </div>
            )}
            <div className="muted small">{a.provider ? `With ${a.provider.name}` : 'Provider not yet assigned'}</div>
          </div>
          <div className="appt-side">
            <span className={`appt-status appt-status-${a.status.toLowerCase()}`}>{STATUS_LABEL[a.status]}</span>
            {a.status === 'SCHEDULED' && perms.setStatus && (
              <button className="btn btn-ghost btn-sm" onClick={() => setStatus(a.id, 'CHECKED_IN')}>Check in</button>
            )}
            {a.status === 'CHECKED_IN' && perms.setStatus && (
              <button className="btn btn-ghost btn-sm" onClick={() => setStatus(a.id, 'COMPLETED')}>Complete</button>
            )}
            {['SCHEDULED', 'CHECKED_IN'].includes(a.status) && perms.cancel && (
              <button className="btn btn-ghost btn-sm btn-danger" onClick={() => setStatus(a.id, 'CANCELLED')}>
                Cancel
              </button>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}
