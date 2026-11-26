import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupTestDb, testDatabaseUrl } from "../../test-db.ts";
import { amazonReport } from "../bank/test-amazon-report.ts";
import { amazonApi } from "./test-amazon-api.ts";

/*
 * Amazon Datenabruf im Hintergrund (#1947): ein Lauf je Prozess, Stand, Abbrechen, Fehler. Die Tests teilen den
 * Stand des Moduls und laufen deshalb nacheinander.
 */

describe.skipIf(!testDatabaseUrl)("Amazon Lauf im Hintergrund (Postgres)", () => {
  let amazon: typeof import("./index.ts");
  let bank: typeof import("../bank/index.ts");
  let sql: postgres.Sql;
  const actor = "test-user";
  const api = amazonApi();
  let zeit = 0;

  const report = (reportId: string, o: Parameters<typeof amazonReport>[0]) => ({
    reportId,
    bytes: amazonReport(o),
    createdTime: new Date(Date.UTC(2026, 10, 1) + ++zeit * 60_000).toISOString(),
  });

  beforeAll(async () => {
    sql = await setupTestDb();
    amazon = await import("./index.ts");
    bank = await import("../bank/index.ts");
    amazon.setAmazonSpClientFactory(api.factory);
    await amazon.saveAmazonSpConnection(actor, { clientId: "amzn1.application-oa2-client.x1", clientSecret: "geheim", refreshToken: "Atzr|token" });
    await bank.createProviderAccount(actor, { name: "Amazon.de", provider: "amazon", marketplace: "Amazon.de" });
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
  });

  it("startet einen Lauf, ein zweiter Start gibt den laufenden zurück, am Ende stehen die Meldungen", async () => {
    api.stand.reports = [report("R-L1", { settlementId: "S-L1", marketplace: "Amazon.de", order: "302-61" })];
    let freigeben!: () => void;
    api.stand.halten = new Promise<void>((resolve) => (freigeben = resolve));
    const erster = amazon.amazonLaufStarten(actor);
    expect(erster.laeuft).toBe(true);
    const zweiter = amazon.amazonLaufStarten(actor);
    expect(zweiter.gestartet).toBe(erster.gestartet);
    freigeben();
    await amazon.amazonLaufBeendet();
    api.stand.halten = null;
    const stand = amazon.amazonLaufStand()!;
    expect(stand.laeuft).toBe(false);
    expect(stand.phase).toBe("fertig");
    expect(stand.meldungen).toEqual([{ tone: "ok", text: "Amazon.de: 1 Abrechnung, 3 neue Umsätze" }]);
  });

  it("Abbrechen beendet eine Wartezeit sofort", async () => {
    api.stand.reports = [report("R-L2", { settlementId: "S-L2", marketplace: "Amazon.de", order: "302-62" })];
    api.stand.drossel = 1;
    amazon.amazonLaufStarten(actor);
    await vi.waitFor(() => expect(amazon.amazonLaufStand()?.phase).toBe("warten"));
    amazon.amazonLaufAbbrechen();
    expect(amazon.amazonLaufStand()?.abbrechenAngefragt).toBe(true);
    await amazon.amazonLaufBeendet();
    expect(amazon.amazonLaufStand()?.meldungen.map((m) => m.text)).toEqual([expect.stringMatching(/^Abruf abgebrochen: 1 Report noch nicht geprüft/)]);
    api.stand.drossel = Infinity;
  });

  it("ein Fehler im Hintergrund beendet den Lauf mit Meldung", async () => {
    await amazon.deleteAmazonSpConnection(actor);
    amazon.amazonLaufStarten(actor);
    await amazon.amazonLaufBeendet();
    const stand = amazon.amazonLaufStand()!;
    expect(stand.laeuft).toBe(false);
    expect(stand.meldungen).toEqual([{ tone: "danger", text: expect.stringMatching(/nicht eingerichtet/) }]);
  });
});
