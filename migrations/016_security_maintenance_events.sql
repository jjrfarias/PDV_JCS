CREATE TABLE security_maintenance_events (
  id text PRIMARY KEY,
  action text NOT NULL,
  details_json text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TRIGGER security_maintenance_events_immutable
  BEFORE UPDATE OR DELETE ON security_maintenance_events
  FOR EACH ROW EXECUTE FUNCTION public.pdv_block_immutable();

REVOKE ALL ON security_maintenance_events FROM PUBLIC;
REVOKE ALL ON security_maintenance_events FROM pdv_runtime;
