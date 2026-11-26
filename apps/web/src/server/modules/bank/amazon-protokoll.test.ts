import { parseStatement } from "@haben/import";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, testDatabaseUrl } from "../../test-db.ts";
import { amazonReport } from "./test-amazon-report.ts";

/* Protokoll der Amazon-Abrechnungen (#1947): Der Dateiimport schreibt immer, der Abruf schließt eine Report-ID einmal ab. */

describe.skipIf(!testDatabaseUrl)("Protokoll der Amazon-Abrechnungen (Postgres)", () => {
  let bank: typeof import("./index.ts");
  let withActor: typeof import("../../db/actor.ts").withActor;
  let sql: postgres.Sql;
  const actor = "test-user";
  let konto: string;

  beforeAll(async () => {
    sql = await setupTestDb();
    ({ withActor } = await import("../../db/actor.ts"));
    bank = await import("./index.ts");
    konto = (await bank.createProviderAccount(actor, { name: "Amazon.de", provider: "amazon", marketplace: "Amazon.de" })).id;
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
  });

  const zeilen = () =>
    sql`select report_id, settlement_id, marketplace, currency, ergebnis, quelle, bank_account_id, (bank_import_id is not null) as mit_import from amazon_settlement_reports order by created_at`;
  const datei = (settlementId: string) => ({ bytes: amazonReport({ settlementId }), filename: "amazon-settlement.txt" });

  it("der Dateiimport schreibt eine Zeile, auch beim zweiten Mal derselben Datei", async () => {
    expect(await bank.importStatement(actor, datei("S-DATEI"), konto)).toMatchObject({ added: 3 });
    expect(await bank.importStatement(actor, datei("S-DATEI"), konto)).toMatchObject({ added: 0 });
    expect(await zeilen()).toEqual([
      {
        report_id: null,
        settlement_id: "S-DATEI",
        marketplace: "Amazon.de",
        currency: "EUR",
        ergebnis: "uebernommen",
        quelle: "datei",
        bank_account_id: konto,
        mit_import: true,
      },
      {
        report_id: null,
        settlement_id: "S-DATEI",
        marketplace: "Amazon.de",
        currency: "EUR",
        ergebnis: "uebernommen",
        quelle: "datei",
        bank_account_id: konto,
        mit_import: true,
      },
    ]);
  });

  it("der Abruf schreibt die Report-ID mit Quelle api und schließt sie genau einmal ab", async () => {
    const bytes = amazonReport({ settlementId: "S-API" });
    const speichern = () =>
      withActor(actor, (tx) => bank.storeStatement(tx, parseStatement(bytes, "a.txt"), { filename: "a.txt", sha256: "x", amazonReportId: "R-API" }, konto));
    await speichern();
    await expect(speichern()).rejects.toMatchObject({ cause: { constraint_name: "amazon_settlement_reports_abgeschlossen" } });
    const [zeile] = await sql`select report_id, quelle, ergebnis from amazon_settlement_reports where report_id = 'R-API'`;
    expect(zeile).toEqual({ report_id: "R-API", quelle: "api", ergebnis: "uebernommen" });
  });

  it("nur übernommene und fremdwährige Reports gelten als abgeschlossen; Versuche bleiben offen", async () => {
    await withActor(actor, async (tx) => {
      await bank.protokolliereAmazonVersuch(tx, { reportId: "R-GBP", ergebnis: "fremdwaehrung", currency: "GBP", marketplace: "Amazon.co.uk" });
      await bank.protokolliereAmazonVersuch(tx, { reportId: "R-NL", ergebnis: "kein_konto", marketplace: "Amazon.nl", meldung: "Kein Konto" });
      await bank.protokolliereAmazonVersuch(tx, { reportId: "R-KAPUTT", ergebnis: "fehler", meldung: "kaputt" });
    });
    const { db } = await import("../../db/index.ts");
    expect([...(await bank.abgeschlosseneAmazonReports(db))].sort()).toEqual(["R-API", "R-GBP"]);
    expect(await withActor(actor, (tx) => bank.amazonReportAbgeschlossen(tx, "R-NL"))).toBe(false);
    expect(await withActor(actor, (tx) => bank.amazonReportAbgeschlossen(tx, "R-GBP"))).toBe(true);
  });

  it("das Protokoll lässt sich weder ändern noch löschen", async () => {
    await expect(sql`update amazon_settlement_reports set meldung = 'x'`).rejects.toThrow();
    await expect(sql`delete from amazon_settlement_reports`).rejects.toThrow();
  });
});
