-- #1947: Zugang zur SP-API von Amazon wie paypal_connections: jede Änderung ins Protokoll (ohne ciphertext), gegen
-- TRUNCATE gesperrt.
CREATE TRIGGER amazon_sp_connections_audit AFTER INSERT OR UPDATE OR DELETE ON amazon_sp_connections
  FOR EACH ROW EXECUTE FUNCTION haben_audit();
--> statement-breakpoint
CREATE TRIGGER amazon_sp_connections_no_truncate BEFORE TRUNCATE ON amazon_sp_connections
  FOR EACH STATEMENT EXECUTE FUNCTION haben_reject_truncate();
--> statement-breakpoint
-- Protokoll der Amazon-Abrechnungen wie postfach_erledigt: nur anhängen, Audit, kein TRUNCATE.
CREATE TRIGGER amazon_settlement_reports_append_only BEFORE UPDATE OR DELETE ON amazon_settlement_reports
  FOR EACH ROW EXECUTE FUNCTION haben_append_only();
--> statement-breakpoint
CREATE TRIGGER amazon_settlement_reports_audit AFTER INSERT ON amazon_settlement_reports
  FOR EACH ROW EXECUTE FUNCTION haben_audit();
--> statement-breakpoint
CREATE TRIGGER amazon_settlement_reports_no_truncate BEFORE TRUNCATE ON amazon_settlement_reports
  FOR EACH STATEMENT EXECUTE FUNCTION haben_reject_truncate();
