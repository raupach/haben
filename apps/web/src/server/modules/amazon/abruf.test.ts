import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDb, testDatabaseUrl } from "../../test-db.ts";
import { amazonReport } from "../bank/test-amazon-report.ts";
import { amazonApi } from "./test-amazon-api.ts";

/*
 * Amazon Datenabruf gegen Postgres (#1947): Reports aller Marktplätze in ihre Konten, abgeschlossene nicht noch einmal,
 * Fremdwährung, fehlendes und doppeltes Konto, Drosselung, kaputte Datei und das Zusammenspiel mit dem Dateiimport.
 */

describe.skipIf(!testDatabaseUrl)("Amazon Datenabruf (Postgres)", () => {
  let amazon: typeof import("./index.ts");
  let bank: typeof import("../bank/index.ts");
  let sql: postgres.Sql;
  const actor = "test-user";
  const api = amazonApi();
  const konten: Record<string, string> = {};
  let zeit = 0;

  /** Report mit fortlaufender Erzeugungszeit, damit die Reihenfolge feststeht */
  const report = (reportId: string, o: Parameters<typeof amazonReport>[0]) => ({
    reportId,
    bytes: amazonReport(o),
    createdTime: new Date(Date.UTC(2026, 10, 1) + ++zeit * 60_000).toISOString(),
  });
  const umsaetze = (konto: string) => sql`select count(*)::int as n from bank_transactions where bank_account_id = ${konto}`.then(([r]) => r!.n);

  beforeAll(async () => {
    sql = await setupTestDb();
    amazon = await import("./index.ts");
    bank = await import("../bank/index.ts");
    amazon.setAmazonSpClientFactory(api.factory);
    await amazon.saveAmazonSpConnection(actor, { clientId: "amzn1.application-oa2-client.x1", clientSecret: "geheim", refreshToken: "Atzr|token" });
    for (const m of ["Amazon.de", "Amazon.fr"]) konten[m] = (await bank.createProviderAccount(actor, { name: m, provider: "amazon", marketplace: m })).id;
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(() => {
    api.stand.downloads = [];
    api.stand.drossel = Infinity;
    api.stand.retryAfter = null;
  });

  it("legt jeden Report im Konto seines Marktplatzes ab; GBP, fehlendes Konto und kaputte Datei werden gemeldet", async () => {
    api.stand.reports = [
      report("R-DE", { settlementId: "S-DE", marketplace: "Amazon.de" }),
      report("R-FR", { settlementId: "S-FR", marketplace: "Amazon.fr", order: "403-1" }),
      report("R-UK", { settlementId: "S-UK", marketplace: "Amazon.co.uk", currency: "GBP" }),
      report("R-NL", { settlementId: "S-NL", marketplace: "Amazon.nl" }),
      { reportId: "R-KAPUTT", bytes: new TextEncoder().encode("kein Report"), createdTime: "2026-11-02T00:00:00Z" },
    ];
    const e = await amazon.amazonDatenabruf(actor);
    expect(e.uebernommen.map((u) => [u.marketplace, u.added])).toEqual([
      ["Amazon.de", 3],
      ["Amazon.fr", 3],
    ]);
    expect(e.fremdwaehrung).toEqual([{ marketplace: "Amazon.co.uk", currency: "GBP" }]);
    expect(e.ohneKonto).toEqual(["Amazon.nl"]);
    expect(e.fehler).toEqual([expect.stringMatching(/^Report R-KAPUTT: /)]);
    expect(await umsaetze(konten["Amazon.de"]!)).toBe(3);
    expect(await umsaetze(konten["Amazon.fr"]!)).toBe(3);
  });

  it("lädt abgeschlossene Reports nicht noch einmal; offene schon, und ein neues Konto bekommt seinen Report", async () => {
    const zweiter = await amazon.amazonDatenabruf(actor);
    // R-NL bleibt liegen, solange es kein Konto für Amazon.nl gibt; nur der kaputte Report wird erneut geladen
    expect(api.stand.downloads).toEqual(["R-KAPUTT"]);
    expect(zweiter.schonAbgerufen).toBe(3);
    expect(zweiter.ohneKonto).toEqual(["Amazon.nl"]);
    const nl = (await bank.createProviderAccount(actor, { name: "Amazon.nl", provider: "amazon", marketplace: "Amazon.nl" })).id;
    expect((await amazon.amazonDatenabruf(actor)).uebernommen.map((u) => u.marketplace)).toEqual(["Amazon.nl"]);
    expect(await umsaetze(nl)).toBe(3);
  });

  it("eine schon von Hand importierte Abrechnung ergibt 0 neue Umsätze; danach läuft auch der Dateiimport noch", async () => {
    const bytes = amazonReport({ settlementId: "S-HAND", marketplace: "Amazon.de", order: "302-9" });
    expect(await bank.importStatement(actor, { bytes, filename: "hand.txt" }, konten["Amazon.de"]!)).toMatchObject({ added: 3 });
    api.stand.reports = [{ reportId: "R-HAND", bytes, createdTime: "2026-11-20T00:00:00Z" }];
    expect((await amazon.amazonDatenabruf(actor)).uebernommen).toEqual([expect.objectContaining({ settlementId: "S-HAND", added: 0 })]);
    expect(await bank.importStatement(actor, { bytes, filename: "hand.txt" }, konten["Amazon.de"]!)).toMatchObject({ added: 0 });
    const quellen = await sql`select quelle from amazon_settlement_reports where settlement_id = 'S-HAND' order by created_at`;
    expect(quellen.map((q) => q.quelle)).toEqual(["datei", "api", "datei"]);
  });

  it("dieselbe Abrechnung unter zwei Report-IDs im selben Abruf: einmal Umsätze, beide abgeschlossen", async () => {
    const bytes = amazonReport({ settlementId: "S-NEU", marketplace: "Amazon.fr", order: "403-7" });
    api.stand.reports = [
      { reportId: "R-NEU-1", bytes, createdTime: "2026-11-21T00:00:00Z" },
      { reportId: "R-NEU-2", bytes, createdTime: "2026-11-22T00:00:00Z" },
    ];
    expect((await amazon.amazonDatenabruf(actor)).uebernommen.map((u) => u.added)).toEqual([3, 0]);
    expect((await amazon.amazonDatenabruf(actor)).schonAbgerufen).toBe(2);
  });

  it("ordnet den Marktplatz ohne Rücksicht auf Groß- und Kleinschreibung zu", async () => {
    api.stand.reports = [report("R-KLEIN", { settlementId: "S-KLEIN", marketplace: "amazon.de", order: "302-11" })];
    expect((await amazon.amazonDatenabruf(actor)).uebernommen).toEqual([expect.objectContaining({ accountName: "Amazon.de", added: 3 })]);
  });

  it("zwei Konten für einen Marktplatz: nichts übernommen", async () => {
    await bank.createProviderAccount(actor, { name: "Amazon.fr 2", provider: "amazon", marketplace: "Amazon.fr" });
    api.stand.reports = [report("R-FR2", { settlementId: "S-FR2", marketplace: "Amazon.fr", order: "403-9" })];
    const e = await amazon.amazonDatenabruf(actor);
    expect(e.mehrdeutig).toEqual(["Amazon.fr"]);
    expect(e.uebernommen).toEqual([]);
  });

  it("ein ausgeschlossenes Konto zählt nicht", async () => {
    const it_ = (await bank.createProviderAccount(actor, { name: "Amazon.it", provider: "amazon", marketplace: "Amazon.it" })).id;
    // Ein Amazon-Konto lässt sich über die Oberfläche nicht ausschließen (Trigger, Check); der Filter des Abrufs gilt trotzdem
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update bank_accounts set excluded_at = now() where id = ${it_}`;
    });
    api.stand.reports = [report("R-IT", { settlementId: "S-IT", marketplace: "Amazon.it", order: "404-1" })];
    expect((await amazon.amazonDatenabruf(actor)).ohneKonto).toEqual(["Amazon.it"]);
    expect(await umsaetze(it_)).toBe(0);
  });

  it("importiert nicht in ein Konto, in das schon ein Dienst über die REST-API liefert (#306)", async () => {
    const be = (await bank.createProviderAccount(actor, { name: "Amazon.com.be", provider: "amazon", marketplace: "Amazon.com.be" })).id;
    await sql`insert into import_sources (bank_account_id, provider, external_account_id, account_kind) values (${be}, 'fremddienst', 'konto-1', 'psp')`;
    api.stand.reports = [report("R-BE", { settlementId: "S-BE", marketplace: "Amazon.com.be", order: "405-1" })];
    const e = await amazon.amazonDatenabruf(actor);
    expect(e.fehler).toEqual([expect.stringMatching(/^Report R-BE: .*nur aus einer Quelle/)]);
    expect(await umsaetze(be)).toBe(0);
  });

  /** Uhr und Warten für den Abruf: Warten rückt die Uhr vor, statt Zeit zu verbrauchen */
  const uhr = () => {
    let t = Date.parse("2026-11-26T20:00:00Z");
    const gewartet: number[] = [];
    return {
      gewartet,
      jetzt: () => t,
      warten: async (ms: number) => {
        gewartet.push(ms);
        t += ms;
      },
    };
  };

  it("wartet bei Drosselung und macht dann mit demselben Report weiter", async () => {
    api.stand.reports = [
      report("R-D1", { settlementId: "S-D1", marketplace: "Amazon.de", order: "302-21" }),
      report("R-D2", { settlementId: "S-D2", marketplace: "Amazon.de", order: "302-22" }),
      report("R-D3", { settlementId: "S-D3", marketplace: "Amazon.de", order: "302-23" }),
    ];
    api.stand.drossel = 2;
    const u = uhr();
    const fortschritt: string[] = [];
    const e = await amazon.amazonDatenabruf(actor, {
      jetzt: u.jetzt,
      warten: async (ms) => {
        await u.warten(ms);
        api.stand.drossel = Infinity;
      },
      fortschritt: (f) => fortschritt.push(f.phase),
    });
    expect(e.uebernommen.map((x) => x.settlementId)).toEqual(["S-D1", "S-D2", "S-D3"]);
    expect(e.nichtGeprueft).toBe(0);
    expect(e.abbruch).toBeNull();
    expect(u.gewartet).toEqual([60_000]);
    expect(fortschritt).toContain("warten");
  });

  it("hört bei dauerhafter Drosselung nach 30 Minuten auf", async () => {
    api.stand.reports = [
      report("R-Z1", { settlementId: "S-Z1", marketplace: "Amazon.de", order: "302-41" }),
      report("R-Z2", { settlementId: "S-Z2", marketplace: "Amazon.de", order: "302-42" }),
    ];
    api.stand.drossel = 1;
    const u = uhr();
    const e = await amazon.amazonDatenabruf(actor, { jetzt: u.jetzt, warten: u.warten });
    expect(e.abbruch).toBe("zeitlimit");
    expect(e.nichtGeprueft).toBe(2);
    expect(u.gewartet.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(30 * 60_000);
    api.stand.drossel = Infinity;
  });

  it("wartet mindestens eine Sekunde, auch bei Retry-After 0", async () => {
    api.stand.reports = [report("R-W1", { settlementId: "S-W1", marketplace: "Amazon.de", order: "302-51" })];
    api.stand.drossel = 1;
    api.stand.retryAfter = "0";
    const u = uhr();
    await amazon.amazonDatenabruf(actor, {
      jetzt: u.jetzt,
      warten: async (ms) => {
        await u.warten(ms);
        api.stand.drossel = Infinity;
      },
    });
    expect(u.gewartet[0]).toBe(1000);
  });

  it("hört auch ohne Drosselung nach 30 Minuten auf", async () => {
    api.stand.reports = [
      report("R-L1", { settlementId: "S-L1", marketplace: "Amazon.de", order: "302-61" }),
      report("R-L2", { settlementId: "S-L2", marketplace: "Amazon.de", order: "302-62" }),
    ];
    let t = Date.parse("2026-11-26T20:00:00Z");
    const e = await amazon.amazonDatenabruf(actor, {
      jetzt: () => t,
      fortschritt: (f) => {
        if (f.phase === "laden" && f.nummer === 1) t += 31 * 60_000;
      },
    });
    expect(e.abbruch).toBe("zeitlimit");
    expect(e.uebernommen.map((x) => x.settlementId)).toEqual(["S-L1"]);
    expect(e.nichtGeprueft).toBe(1);
  });

  it("bricht nach dem laufenden Report ab und beendet eine Wartezeit sofort", async () => {
    api.stand.reports = [
      report("R-A1", { settlementId: "S-A1", marketplace: "Amazon.de", order: "302-51" }),
      report("R-A2", { settlementId: "S-A2", marketplace: "Amazon.de", order: "302-52" }),
    ];
    api.stand.drossel = 2;
    const abbruch = new AbortController();
    const u = uhr();
    const e = await amazon.amazonDatenabruf(actor, {
      jetzt: u.jetzt,
      signal: abbruch.signal,
      // Abbruch während der Wartezeit: das Warten endet, ohne die Uhr vorzurücken
      warten: async () => abbruch.abort(),
    });
    expect(e.uebernommen.map((x) => x.settlementId)).toEqual(["S-A1"]);
    expect(e.abbruch).toBe("abgebrochen");
    expect(e.nichtGeprueft).toBe(1);
    api.stand.drossel = Infinity;
  });

  it("offene Reports ohne Konto verdrängen unter der Drosselung keine neue Abrechnung", async () => {
    api.stand.reports = [
      report("R-V1", { settlementId: "S-V1", marketplace: "Amazon.es", order: "501-1" }),
      report("R-V2", { settlementId: "S-V2", marketplace: "Amazon.es", order: "501-2" }),
      report("R-V3", { settlementId: "S-V3", marketplace: "Amazon.es", order: "501-3" }),
    ];
    expect((await amazon.amazonDatenabruf(actor)).ohneKonto).toEqual(["Amazon.es", "Amazon.es", "Amazon.es"]);
    api.stand.reports.push(report("R-V-NEU", { settlementId: "S-V-NEU", marketplace: "Amazon.de", order: "302-41" }));
    api.stand.downloads = [];
    api.stand.drossel = 2;
    const e = await amazon.amazonDatenabruf(actor);
    expect(api.stand.downloads).toEqual(["R-V-NEU"]);
    expect(e.uebernommen.map((u) => u.settlementId)).toEqual(["S-V-NEU"]);
    expect(e.ohneKonto).toEqual(["Amazon.es", "Amazon.es", "Amazon.es"]);
    expect(e.nichtGeprueft).toBe(0);
  });

  it("eine nach „mehrdeutig“ von Hand importierte Abrechnung erledigt den Report", async () => {
    const bytes = amazonReport({ settlementId: "S-M1", marketplace: "Amazon.fr", order: "403-41" });
    api.stand.reports = [{ reportId: "R-M1", bytes, createdTime: "2026-11-23T00:00:00Z" }];
    const erster = await amazon.amazonDatenabruf(actor);
    expect(erster.mehrdeutig).toEqual(["Amazon.fr"]);
    expect(await bank.importStatement(actor, { bytes, filename: "m1.txt" }, konten["Amazon.fr"]!)).toMatchObject({ added: 3 });
    api.stand.downloads = [];
    const zweiter = await amazon.amazonDatenabruf(actor);
    expect(api.stand.downloads).toEqual([]);
    expect(zweiter).toMatchObject({ schonAbgerufen: 1, mehrdeutig: [], ohneKonto: [], uebernommen: [], fehler: [] });
  });

  it("zwei gleichzeitige Abrufe übernehmen jeden Report einmal", async () => {
    api.stand.reports = [
      report("R-P1", { settlementId: "S-P1", marketplace: "Amazon.de", order: "302-31" }),
      report("R-P2", { settlementId: "S-P2", marketplace: "Amazon.de", order: "302-32" }),
    ];
    await Promise.all([amazon.amazonDatenabruf(actor), amazon.amazonDatenabruf(actor)]);
    const [r] = await sql`select count(*)::int as n from amazon_settlement_reports where report_id in ('R-P1', 'R-P2') and ergebnis = 'uebernommen'`;
    expect(r).toEqual({ n: 2 });
  });

  it("zwei gleichzeitige Abrufe schließen auch eine Abrechnung in Fremdwährung nur einmal ab", async () => {
    api.stand.reports = [report("R-GBP-P", { settlementId: "S-GBP-P", marketplace: "Amazon.co.uk", currency: "GBP" })];
    await expect(Promise.all([amazon.amazonDatenabruf(actor), amazon.amazonDatenabruf(actor)])).resolves.toHaveLength(2);
    const [r] = await sql`select count(*)::int as n from amazon_settlement_reports where report_id = 'R-GBP-P'`;
    expect(r).toEqual({ n: 1 });
  });

  it("ohne Zugang lehnt der Abruf ab", async () => {
    await amazon.deleteAmazonSpConnection(actor);
    await expect(amazon.amazonDatenabruf(actor)).rejects.toThrow(/nicht eingerichtet/);
  });
});
