-- Read-only database role for the reliability product. Run as the RDS admin via psql with -v rpw=<password>.
-- Grants nothing beyond CONNECT, schema USAGE and SELECT (existing and future tables).
SELECT 'CREATE ROLE reliability_reader LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'reliability_reader') \gexec
ALTER ROLE reliability_reader WITH LOGIN PASSWORD :'rpw';

GRANT CONNECT ON DATABASE fineract_tenants TO reliability_reader;
GRANT CONNECT ON DATABASE fineract_default TO reliability_reader;

\c fineract_tenants
GRANT USAGE ON SCHEMA public TO reliability_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO reliability_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE fineract IN SCHEMA public GRANT SELECT ON TABLES TO reliability_reader;

\c fineract_default
GRANT USAGE ON SCHEMA public TO reliability_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO reliability_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE fineract IN SCHEMA public GRANT SELECT ON TABLES TO reliability_reader;
