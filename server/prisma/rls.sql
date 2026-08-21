-- Lock the Supabase REST API out of every table.
--
-- Why this is needed even though the app never uses supabase-js: Supabase exposes
-- every `public` schema table over PostgREST at https://<project>.supabase.co/rest/v1/,
-- reachable by anyone holding the anon key. Prisma talks straight to Postgres and
-- never goes through that path, so shutting it costs the app nothing.
--
-- ENABLE (not FORCE) is deliberate. RLS does not apply to a table's owner, and Prisma
-- connects as the owner, so the API keeps working unchanged while anon/authenticated
-- get default-deny (RLS on + zero policies = nothing is visible).
-- Do NOT add FORCE ROW LEVEL SECURITY: that would apply RLS to the owner too and,
-- with no policies defined, lock the application out of its own database.
-- Likewise, if DATABASE_URL is ever pointed at a non-owner role, add policies first.

ALTER TABLE "User"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Patient"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BreakGlassGrant" ENABLE ROW LEVEL SECURITY;

-- Belt and suspenders: RLS alone stops row reads, but revoking the grants means
-- PostgREST will not even build a route for these tables.
REVOKE ALL ON "User", "Patient", "AuditLog", "BreakGlassGrant" FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- Stop future `prisma db push` tables from being exposed by default.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;

-- Verify: every row must read rls_enabled = true, anon_privileges = 0.
-- Reads pg_class.relacl directly rather than information_schema, which only shows
-- grants the current role granted or received and so can miss supabase_admin's.
SELECT c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       COALESCE(SUM((a.grantee::regrole::text IN ('anon', 'authenticated'))::int), 0)
         AS anon_privileges
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN LATERAL aclexplode(c.relacl) a ON true
WHERE n.nspname = 'public' AND c.relkind = 'r'
GROUP BY c.relname, c.relrowsecurity
ORDER BY c.relname;
