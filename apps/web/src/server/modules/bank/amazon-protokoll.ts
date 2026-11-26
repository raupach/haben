import type { ParsedStatement } from "@haben/import";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { type Db, schema, type Tx } from "../../db/index.ts";
import type { AmazonReportErgebnis } from "../../db/schema.ts";

/*
 * Protokoll der Amazon-Abrechnungen (#1947). storeStatement schreibt für jede übernommene Abrechnung eine Zeile, aus
 * der Datei (quelle datei, ohne Report-ID) wie aus dem Abruf (quelle api). Der Abruf schreibt außerdem Versuche ohne
 * Übernahme. Abgeschlossen ist eine Report-ID, wenn sie übernommen ist oder nicht in Euro vorliegt; der Teilindex
 * amazon_settlement_reports_abgeschlossen lässt das je Report-ID nur einmal zu. Der Dateiimport prüft das Protokoll
 * nicht: Er läuft immer, damit sich ein Abruf von Hand korrigieren lässt.
 */

const ABGESCHLOSSEN: AmazonReportErgebnis[] = ["uebernommen", "fremdwaehrung"];

export async function protokolliereAmazonUebernahme(
  tx: Tx,
  statement: ParsedStatement,
  ziel: { accountId: string; importId: string; reportId: string | null },
): Promise<void> {
  await tx.insert(schema.amazonSettlementReports).values({
    reportId: ziel.reportId,
    settlementId: statement.settlementId ?? null,
    marketplace: statement.marketplace ?? null,
    currency: statement.currency,
    periodFrom: statement.periodFrom ?? null,
    periodTo: statement.periodTo ?? null,
    ergebnis: "uebernommen",
    bankAccountId: ziel.accountId,
    bankImportId: ziel.importId,
    quelle: ziel.reportId ? "api" : "datei",
  });
}

export interface AmazonVersuch {
  reportId: string;
  ergebnis: Exclude<AmazonReportErgebnis, "uebernommen">;
  settlementId?: string;
  marketplace?: string;
  currency?: string;
  periodFrom?: string;
  periodTo?: string;
  meldung?: string;
}

/** Ein Report des Abrufs ohne Übernahme */
export async function protokolliereAmazonVersuch(tx: Tx, v: AmazonVersuch): Promise<void> {
  await tx.insert(schema.amazonSettlementReports).values({
    reportId: v.reportId,
    settlementId: v.settlementId ?? null,
    marketplace: v.marketplace ?? null,
    currency: v.currency ?? null,
    periodFrom: v.periodFrom ?? null,
    periodTo: v.periodTo ?? null,
    ergebnis: v.ergebnis,
    meldung: v.meldung?.slice(0, 500) ?? null,
    quelle: "api",
  });
}

const t = schema.amazonSettlementReports;

/** Report-IDs, die der Abruf nicht mehr laden muss */
export async function abgeschlosseneAmazonReports(leser: Tx | Db): Promise<Set<string>> {
  const rows = await leser
    .select({ reportId: t.reportId })
    .from(t)
    .where(and(isNotNull(t.reportId), inArray(t.ergebnis, ABGESCHLOSSEN)));
  return new Set(rows.map((r) => r.reportId!));
}

export async function amazonReportAbgeschlossen(tx: Tx, reportId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.reportId, reportId), inArray(t.ergebnis, ABGESCHLOSSEN)))
    .limit(1);
  return row !== undefined;
}
