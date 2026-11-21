CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Audit log is append-only
CREATE OR REPLACE FUNCTION audit_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_no_update
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_no_update();
