// Single source of truth for role-based access control.
//
//                            ADMIN  PROVIDER  FRONT_DESK
// list patients                x       x         x
// view SSN                     x                 x     (front desk needs it for insurance/intake)
// view diagnosis/meds          x       x
// create patient               x                 x
// update demographics          x                 x
// update clinical              x       x
// delete patient               x
// view audit logs              x
// manage staff accounts        x                       (list, unlock a lockout)
// ---- scheduling (scoped view) ----------------------------------------------
// view appointments            x       x         x
// view appointment reason      x       x         x     (scheduling note, NOT the diagnosis)
// book / reschedule            x                 x     (front desk owns the calendar)
// cancel                       x                 x
// set status (check-in/done)   x       x         x
//
// The scheduling rows are the point of the scoped view: FRONT_DESK still cannot
// read diagnosis or medicationHistory, but it is no longer left with nothing to
// run a calendar on. It gets a purpose-limited slice - visit category, a short
// scheduling reason, a time - instead of an all-or-nothing field block. That is
// minimum necessary applied to a job function rather than to a column.
//
// PROVIDER deliberately cannot book or cancel: the front desk owns the schedule.
// Providers move a visit through its states (checked in, completed, no-show),
// which is the part of scheduling that is actually theirs.

const SENSITIVE_FIELDS = ['ssn', 'diagnosis', 'medicationHistory'];
const DEMOGRAPHIC_FIELDS = ['firstName', 'lastName', 'dob', 'phone', 'email', 'address'];
const CLINICAL_FIELDS = ['diagnosis', 'medicationHistory'];

// Fields a caller may set when booking or rescheduling.
const APPOINTMENT_FIELDS = ['visitType', 'reason', 'startsAt', 'durationMinutes', 'providerId'];

const PERMISSIONS = {
  ADMIN: {
    viewFields: ['ssn', 'diagnosis', 'medicationHistory'],
    createPatient: true,
    updateFields: [...DEMOGRAPHIC_FIELDS, 'ssn', ...CLINICAL_FIELDS],
    deletePatient: true,
    viewAudit: true,
    appointments: { view: true, schedule: true, cancel: true, setStatus: true, viewReason: true },
  },
  PROVIDER: {
    viewFields: ['diagnosis', 'medicationHistory'],
    createPatient: false,
    updateFields: [...CLINICAL_FIELDS],
    deletePatient: false,
    viewAudit: false,
    appointments: { view: true, schedule: false, cancel: false, setStatus: true, viewReason: true },
  },
  FRONT_DESK: {
    viewFields: ['ssn'],
    createPatient: true,
    updateFields: [...DEMOGRAPHIC_FIELDS, 'ssn'],
    deletePatient: false,
    viewAudit: false,
    appointments: { view: true, schedule: true, cancel: true, setStatus: true, viewReason: true },
  },
};

module.exports = {
  PERMISSIONS,
  SENSITIVE_FIELDS,
  DEMOGRAPHIC_FIELDS,
  CLINICAL_FIELDS,
  APPOINTMENT_FIELDS,
};
