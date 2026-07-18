# Meridian Records — HIPAA-style patient record system (demo)

> **⚠️ All patient data in this application is synthetic.** Every name, date of birth, SSN, diagnosis, and medication entry was invented for demonstration purposes. SSNs use the 900-range, which the Social Security Administration never issues. Do not enter real patient information; this is a public demo.
>
> This project demonstrates the *technical safeguards* HIPAA asks for (access control, encryption, audit trails). It is **not** a certified or legally HIPAA-compliant system. Real compliance also requires signed Business Associate Agreements with every vendor (Supabase, Railway, Netlify free tiers won't sign one), administrative policies, training, breach procedures, and more.

A patient record system focused on secure data handling rather than clinical functionality: role-based access control, application-level field encryption for PHI, and an append-only audit log of every read and write.

## Stack

- **Backend:** Node + Express, Prisma ORM, Passport (local strategy) + bcrypt + JWT
- **Database:** Postgres on Supabase
- **Frontend:** React (Vite), plain CSS
- **Hardening:** helmet, express-rate-limit, account lockout

## Security design

### Role-based access control

Three roles with different permissions on patient records, enforced server-side from a single permission matrix (`server/src/lib/permissions.js`). The frontend hides what a role can't use, but the API is the enforcement point.

| Action | Admin | Provider | Front desk |
|---|---|---|---|
| List patients (demographics only) | ✓ | ✓ | ✓ |
| View SSN | ✓ | | ✓ |
| View diagnosis / medications | ✓ | ✓ | |
| Create patient | ✓ | | ✓ |
| Update demographics + SSN | ✓ | | ✓ |
| Update clinical fields | ✓ | ✓ | |
| Delete patient | ✓ | | |
| View audit logs | ✓ | | |

Front desk retains SSN access because intake and insurance verification require it; clinical detail is withheld from them instead (minimum necessary standard).

### Field-level encryption

SSN, diagnosis, and medication history are encrypted with **AES-256-GCM in application code** (`server/src/lib/crypto.js`) before they ever reach the database. Each value gets a random IV; ciphertext is stored as `iv:authTag:ciphertext`. The key lives only in the `FIELD_ENCRYPTION_KEY` env var, so what Supabase stores is ciphertext regardless of its own at-rest encryption. Decryption only happens for fields the requesting role is allowed to see: the server never decrypts a value it won't return.

### Audit logging

Every access is written to an append-only `AuditLog` table: **reads, not just writes**, plus logins, failed logins, and denied attempts. Each entry records who, what action, which patient, which sensitive fields were decrypted, source IP, and timestamp. The API exposes no update or delete operations on this table, and deleting a patient preserves their audit rows. Admins get a filterable viewer in the UI.

### Auth

- bcrypt password hashing (cost 12), constant-time-ish handling to avoid user enumeration
- JWT sessions, 1 hour expiry, verified on every request
- Account lockout: 15 minutes after 5 failed attempts
- Login rate limit (10/15min per IP) on top of a global limiter, helmet security headers, strict CORS allowlist

### Documented tradeoffs (things a production system would do differently)

- No encryption key rotation/versioning
- No refresh tokens; sessions just expire after an hour
- JWT stored in localStorage for simplicity; httpOnly cookies would reduce XSS token-theft risk
- Audit log integrity relies on DB permissions, not cryptographic chaining

## Local setup

Prereqs: Node 18+, a free [Supabase](https://supabase.com) project.

```bash
# 1. Backend
cd server
cp .env.example .env
# Fill in .env:
#   DATABASE_URL / DIRECT_URL from Supabase > Project Settings > Database
#   JWT_SECRET:            openssl rand -hex 64
#   FIELD_ENCRYPTION_KEY:  openssl rand -hex 32   (must be exactly 64 hex chars)
npm install
npm run db:push      # creates tables
npm run db:seed      # demo users + 10 synthetic patients
npm run dev          # API on :4000

# 2. Frontend (new terminal)
cd client
npm install
npm run dev          # UI on :5173, /api proxied to :4000
```

Demo logins (also shown on the login screen):

| Role | Email | Password |
|---|---|---|
| Admin | admin@demo.clinic | AdminDemo123! |
| Provider | provider@demo.clinic | ProviderDemo123! |
| Front desk | frontdesk@demo.clinic | FrontdeskDemo123! |

Try it: sign in as the provider, open a record (note SSN is hidden), then sign in as admin and watch the audit log fill up, including any DENIED rows if you tried something the role didn't allow.

## Deployment

**Database (Supabase):** create a project, grab both connection strings (pooled on 6543 with `?pgbouncer=true` for `DATABASE_URL`, direct on 5432 for `DIRECT_URL`).

**Backend (Railway):** new service from this repo, root directory `server`. Set env vars: `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`, `FIELD_ENCRYPTION_KEY`, `CORS_ORIGIN` (your Netlify URL, e.g. `https://your-app.netlify.app`). Start command `npm start`. Run once from a shell or locally against the prod DB: `npm run db:push && npm run db:seed`. Render works identically (web service, root `server`).

**Frontend (Netlify):** new site from the repo, base directory `client`, build command `npm run build`, publish directory `client/dist`. Env var: `VITE_API_URL` = your Railway URL (no trailing slash). The included `public/_redirects` handles SPA routing. Vercel works too: framework Vite, root `client`, same env var.

After deploy, update `CORS_ORIGIN` on the backend to the final frontend URL.

## Project structure

```
server/
  prisma/schema.prisma      data model + audit log
  prisma/seed.js            demo users, synthetic patients
  src/lib/crypto.js         AES-256-GCM field encryption
  src/lib/permissions.js    RBAC matrix (single source of truth)
  src/lib/audit.js          audit write helper
  src/middleware/auth.js    JWT verification, role guard (logs DENIED)
  src/config/passport.js    local strategy, bcrypt, lockout
  src/routes/               auth, patients, audit
client/
  src/pages/                Login, PatientList, PatientDetail, PatientForm, AuditLog
```
