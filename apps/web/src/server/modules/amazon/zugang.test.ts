import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDb, testDatabaseUrl } from "../../test-db.ts";
import { amazonApi } from "./test-amazon-api.ts";

/* Zugang zur SP-API (#1947): prüfen, verschlüsselt speichern, Geheimnisse behalten, entfernen. */

const ID = "amzn1.application-oa2-client.beispielAB12";
const SECRET = "amzn1.oa2-cs.v1.geheimeswert";
const TOKEN = "Atzr|IwEBIbeispielrefreshtoken";

describe.skipIf(!testDatabaseUrl)("Zugang zur SP-API von Amazon (Postgres)", () => {
  let amazon: typeof import("./index.ts");
  let sql: postgres.Sql;
  const actor = "test-user";
  const api = amazonApi();

  beforeAll(async () => {
    sql = await setupTestDb();
    amazon = await import("./index.ts");
    amazon.setAmazonSpClientFactory(api.factory);
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(() => {
    api.stand.status = 200;
  });

  const zeilen = () =>
    sql`select key_hint, position(${SECRET} in encode(ciphertext, 'escape')) as secret, position(${TOKEN} in encode(ciphertext, 'escape')) as token from amazon_sp_connections`;

  it("lehnt einen falschen Zugang ab und speichert nichts", async () => {
    api.stand.status = 400;
    await expect(amazon.saveAmazonSpConnection(actor, { clientId: ID, clientSecret: SECRET, refreshToken: TOKEN })).rejects.toThrow(/Refresh-Token/);
    expect(await zeilen()).toEqual([]);
    expect(await amazon.amazonSpSummary()).toMatchObject({ configured: false });
  });

  it("nennt die fehlende Rolle", async () => {
    api.stand.status = 403;
    await expect(amazon.saveAmazonSpConnection(actor, { clientId: ID, clientSecret: SECRET, refreshToken: TOKEN })).rejects.toThrow(/Finance and Accounting/);
  });

  it("verlangt beim ersten Speichern alle drei Werte", async () => {
    await expect(amazon.saveAmazonSpConnection(actor, { clientId: ID, clientSecret: SECRET })).rejects.toThrow(/Refresh-Token fehlt/);
  });

  it("speichert geprüft und verschlüsselt und zeigt nur die letzten Zeichen der Client-ID", async () => {
    await amazon.saveAmazonSpConnection(actor, { clientId: ID, clientSecret: SECRET, refreshToken: TOKEN });
    expect(await zeilen()).toEqual([{ key_hint: "AB12", secret: 0, token: 0 }]);
    expect(await amazon.amazonSpSummary()).toMatchObject({ configured: true, keyHint: "AB12" });
    expect(await amazon.amazonSpEingerichtet()).toBe(true);
    expect((await amazon.loadAmazonSpConnection())?.credentials).toEqual({ clientId: ID, clientSecret: SECRET, refreshToken: TOKEN });
  });

  it("behält gespeicherte Werte, wenn Felder leer bleiben", async () => {
    await amazon.saveAmazonSpConnection(actor, { refreshToken: "Atzr|neuestoken" });
    expect((await amazon.loadAmazonSpConnection())?.credentials).toEqual({ clientId: ID, clientSecret: SECRET, refreshToken: "Atzr|neuestoken" });
  });

  it("bindet die Amazon-Konten, sobald der Zugang eingerichtet ist (#306)", async () => {
    const bank = await import("../bank/index.ts");
    const konto = (await bank.createProviderAccount(actor, { name: "Amazon.es", provider: "amazon", marketplace: "Amazon.es" })).id;
    expect(await bank.boundAccountIds()).toContain(konto);
  });

  it("das Audit-Log enthält keine Geheimnisse", async () => {
    const [treffer] =
      await sql`select count(*)::int as alle, count(*) filter (where new_value::text like ${`%${SECRET}%`} or new_value ? 'ciphertext')::int as geheim from audit_log where table_name = 'amazon_sp_connections'`;
    expect(treffer).toEqual({ alle: 2, geheim: 0 });
  });

  it("entfernt den Zugang", async () => {
    await amazon.deleteAmazonSpConnection(actor);
    expect(await amazon.amazonSpEingerichtet()).toBe(false);
  });
});
