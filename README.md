# Meridian Records

A demo patient record system I built to show off the security side of handling health data. Role based access control, actual field level encryption, and an audit log that tracks every single read and write. The clinical features are intentionally basic because that's not the point of the project.

**Important: every patient in here is fake.** All the names, SSNs, diagnoses, everything is made up. The SSNs all start with 900 which is a range the government never actually issues. Please don't type real patient info into this, it's a public demo.

Also to be clear, this demonstrates the technical safeguards HIPAA talks about but it is not actually HIPAA compliant in a legal sense. Real compliance needs signed BAAs with every vendor in the stack, and the free tiers of Supabase and Railway aren't going to sign one. Plus a bunch of admin policy stuff that has nothing to do with code.

## Stack

Node + Express backend, Prisma ORM, Postgres on Supabase, React frontend with Vite. Auth is Passport + bcrypt + JWT. Helmet and rate limiting on top.

## The interesting parts

### Roles

Three roles, each sees and does different things. The whole permission setup lives in one file (`server/src/lib/permissions.js`) and the server enforces it on every request. The frontend hides buttons too but that's cosmetic, the API is what actually says no.

| | Admin | Provider | Front desk |
|---|---|---|---|
| See patient list | yes | yes | yes |
| See SSN | yes | no | yes |
| See diagnosis / meds | yes | yes | no |
| Create patients | yes | no | yes |
| Edit demographics | yes | no | yes |
| Edit clinical fields | yes | yes | no |
| Delete patients | yes | no | no |
| View audit log | yes | no | no |

Why does front desk get SSN but not the provider? Insurance and intake need it, and the provider doesn't. Meanwhile front desk has no business reading your diagnosis. That's the minimum necessary idea from HIPAA, everyone gets what their job requires and nothing extra.

### Encryption that isn't just "the database does it"

SSN, diagnosis, and medication history get encrypted with AES-256-GCM in the app code before they're ever sent to the database. Random IV every time, key only exists as an env var. So if you open the Supabase table editor you just see base64 garbage in those columns. Supabase encrypts at rest too but that protects against someone stealing their disks, not against anyone with database access. This protects against both.

One rule I stuck to: the server never decrypts a field it isn't going to return. A provider requesting a record doesn't just have the SSN stripped from the response, the SSN ciphertext never gets decrypted at all.

### The audit log

This is the part that makes the project stand out imo. Every access gets logged. Not just edits, reads too, which is what HIPAA actually expects and what most demo projects skip. Who, what action, which patient, which sensitive fields got decrypted, IP, timestamp. Failed logins and denied attempts get logged as well, so if front desk tries to hit the audit endpoint you'll see a DENIED row with their name on it.

The table is append only, there's just no API for editing or deleting entries. Deleting a patient keeps their audit history around.

### Auth details

bcrypt at cost 12, JWTs that expire after an hour, accounts lock for 15 minutes after 5 bad passwords. Unknown emails still burn a bcrypt compare so you can't tell which accounts exist by timing. Login endpoint has its own rate limit on top of the global one.

### Stuff a real system would do that this doesn't

Being honest about the cut corners: no key rotation, no refresh tokens, JWT sits in localStorage (httpOnly cookies would be better against XSS), and the audit log's integrity depends on database permissions rather than any cryptographic chaining.

## Running it locally

You need Node 18+ and a free Supabase project.

```bash
cd server
cp .env.example .env
# fill in .env, the example file explains each value
npm install
npm run db:push
npm run db:seed
npm run dev
```

Then in another terminal:

```bash
cd client
npm install
npm run dev
```

Open localhost:5173. The seed gives you three logins, also shown right on the login page:

| Role | Email | Password |
|---|---|---|
| Admin | admin@demo.clinic | AdminDemo123! |
| Provider | provider@demo.clinic | ProviderDemo123! |
| Front desk | frontdesk@demo.clinic | FrontdeskDemo123! |

Fun demo flow: log in as the provider, open a record, notice the SSN says not visible to your role. Then log in as admin and check the audit page. Everything you just did is in there.

## Deploying

Database on Supabase, backend on Railway (root directory `server`, start command `npm start`, env vars from your .env plus CORS_ORIGIN set to the frontend URL). Frontend on Netlify (base `client`, build `npm run build`, publish `client/dist`, env var VITE_API_URL pointing at the Railway URL). Run db:push and db:seed once against the prod database from your machine. After both are live, update CORS_ORIGIN on Railway to the real Netlify URL.

## Layout

```
server/
  prisma/schema.prisma      models + audit log table
  prisma/seed.js            fake users and patients
  src/lib/crypto.js         the AES-256-GCM stuff
  src/lib/permissions.js    the role matrix
  src/lib/audit.js          audit write helper
  src/middleware/auth.js    JWT check + role guard
  src/config/passport.js    login, lockout
  src/routes/
client/
  src/pages/                the five screens
```
