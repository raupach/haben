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
--> statement-breakpoint
-- Das Protokoll ist nur anhängbar und ohne Siegel; 0339 gleicht solche Tabellen mit dem Audit-Log ab. Die Liste dort
-- ergänzt diese Migration um die neue Tabelle (integrity-anhaengbar.test.ts prüft den Katalog).
CREATE OR REPLACE FUNCTION haben_audited_append_only_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['amazon_settlement_reports', 'annual_submission_figures', 'annual_submissions', 'app_versions', 'archive_files',
    'bank_duplicate_check', 'bank_duplicate_decisions', 'bank_duplicate_reviews', 'bank_import_transactions', 'bank_imports',
    'bank_neutralizations', 'bank_transactions', 'brm_requests', 'contact_versions', 'datev_bookings', 'datev_personenkonten',
    'dividends', 'document_iban_decisions', 'document_settlements', 'dunnings', 'elster_messages', 'external_import_settlements',
    'external_imports', 'import_batches', 'import_conflicts', 'import_movements', 'import_resolutions', 'import_sources',
    'inbox_messages', 'invoice_settlements', 'journal_umstellung', 'kapest_submissions', 'legacy_dunning_files',
    'legacy_dunnings', 'legacy_file_states', 'legacy_order_documents', 'legacy_order_files', 'legacy_order_pdf_attempts',
    'legacy_vat_report_files', 'legacy_vat_reports', 'legacy_voucher_payments', 'lexoffice_voucher_files',
    'lexoffice_vouchers', 'local_owner_recoveries', 'lsta_submissions', 'lstb_submissions', 'mail_log', 'password_changes',
    'postfach_documents', 'postfach_erledigt', 'postfach_requests', 'sepa_direct_debit_items', 'sepa_direct_debits',
    'sepa_mandate_files', 'sepa_mandate_revocations', 'sepa_mandates', 'sepa_transfer_items', 'sepa_transfers',
    'sevdesk_accounting_type_decisions', 'sevdesk_accounting_types', 'sevdesk_tax_sets', 'sso_issuers', 'sso_takeovers',
    'store_payouts', 'store_reports', 'sv_portal_filings', 'token_events', 'user_logins', 'ustid_bestaetigungen',
    'vast_belege', 'vast_requests', 'vat_extension_submissions', 'vat_items_since', 'vat_return_submissions', 'write_offs',
    'year_closings', 'zm_submissions']
$$;
