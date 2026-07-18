// Single source of truth for role-based access control.
//
//                       ADMIN  PROVIDER  FRONT_DESK
// list patients           x       x         x
// view SSN                x                 x     (front desk needs it for insurance/intake)
// view diagnosis/meds     x       x
// create patient          x                 x
// update demographics     x                 x
// update clinical         x       x
// delete patient          x
// view audit logs         x

const SENSITIVE_FIELDS = ['ssn', 'diagnosis', 'medicationHistory'];
const DEMOGRAPHIC_FIELDS = ['firstName', 'lastName', 'dob', 'phone', 'email', 'address'];
const CLINICAL_FIELDS = ['diagnosis', 'medicationHistory'];

const PERMISSIONS = {
  ADMIN: {
    viewFields: ['ssn', 'diagnosis', 'medicationHistory'],
    createPatient: true,
    updateFields: [...DEMOGRAPHIC_FIELDS, 'ssn', ...CLINICAL_FIELDS],
    deletePatient: true,
    viewAudit: true,
  },
  PROVIDER: {
    viewFields: ['diagnosis', 'medicationHistory'],
    createPatient: false,
    updateFields: [...CLINICAL_FIELDS],
    deletePatient: false,
    viewAudit: false,
  },
  FRONT_DESK: {
    viewFields: ['ssn'],
    createPatient: true,
    updateFields: [...DEMOGRAPHIC_FIELDS, 'ssn'],
    deletePatient: false,
    viewAudit: false,
  },
};

module.exports = { PERMISSIONS, SENSITIVE_FIELDS, DEMOGRAPHIC_FIELDS, CLINICAL_FIELDS };
