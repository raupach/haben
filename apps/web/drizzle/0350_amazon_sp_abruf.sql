CREATE TABLE "amazon_settlement_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" text,
	"settlement_id" text,
	"marketplace" text,
	"currency" text,
	"period_from" date,
	"period_to" date,
	"ergebnis" text NOT NULL,
	"meldung" text,
	"bank_account_id" uuid,
	"bank_import_id" uuid,
	"quelle" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amazon_settlement_reports_ergebnis" CHECK ("amazon_settlement_reports"."ergebnis" in ('uebernommen', 'fremdwaehrung', 'kein_konto', 'mehrdeutig', 'fehler')),
	CONSTRAINT "amazon_settlement_reports_quelle" CHECK ("amazon_settlement_reports"."quelle" in ('api', 'datei')),
	CONSTRAINT "amazon_settlement_reports_api" CHECK (("amazon_settlement_reports"."quelle" = 'api') = ("amazon_settlement_reports"."report_id" is not null)),
	CONSTRAINT "amazon_settlement_reports_import" CHECK (("amazon_settlement_reports"."ergebnis" = 'uebernommen') = ("amazon_settlement_reports"."bank_import_id" is not null and "amazon_settlement_reports"."bank_account_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "amazon_sp_connections" (
	"id" text PRIMARY KEY DEFAULT 'amazon' NOT NULL,
	"key_hint" text DEFAULT '' NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amazon_sp_connections_id" CHECK ("amazon_sp_connections"."id" = 'amazon')
);
--> statement-breakpoint
ALTER TABLE "amazon_settlement_reports" ADD CONSTRAINT "amazon_settlement_reports_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_settlement_reports" ADD CONSTRAINT "amazon_settlement_reports_bank_import_id_bank_imports_id_fk" FOREIGN KEY ("bank_import_id") REFERENCES "public"."bank_imports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "amazon_settlement_reports_abgeschlossen" ON "amazon_settlement_reports" USING btree ("report_id") WHERE "amazon_settlement_reports"."ergebnis" in ('uebernommen', 'fremdwaehrung');