import { createServer, type Server } from "node:http";
import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { AMAZON_PORT, databaseUrlFuer } from "./durchlaeufe.ts";
import { durchlaufSeite, einrichten, gehe } from "./einrichtung.ts";

/**
 * Amazon Datenabruf (#1947) in eigener, leerer Datenbank (Projekt „amazon-abruf“): Zugang prüfen und speichern, Knopf
 * nur mit Zugang und Amazon-Konto, Abruf mit gesperrtem Knopf, zweiter Abruf ohne Dubletten, Zugang entfernen. Die
 * nachgebaute SP-API kennt nur das Refresh-Token unten und liefert einen Report für Amazon.de. Werte erfunden.
 */

test.describe.configure({ mode: "serial" });

const CLIENT_ID = "amzn1.application-oa2-client.e2eAB12";
const SECRET = "e2e-amazon-geheimnis";
const TOKEN = "Atzr|e2e-refresh-token";

let page: Page;
let pageErrors: string[] = [];
let amazon: Server;
/** Antwortet die Report-Datei erst nach einer Pause, damit der gesperrte Knopf sichtbar ist */
let pause = 0;

const HEADER =
  "settlement-id\tsettlement-start-date\tsettlement-end-date\tdeposit-date\ttotal-amount\tcurrency\ttransaction-type\torder-id\tmerchant-order-id\tadjustment-id\tshipment-id\tmarketplace-name\tamount-type\tamount-description\tamount\tfulfillment-id\tposted-date\tposted-date-time\torder-item-code\tmerchant-order-item-id\tmerchant-adjustment-item-id\tsku\tquantity-purchased\tpromotion-id";
const zeile = (werte: Record<number, string>) => {
  const c: string[] = Array(24).fill("");
  c[0] = "10000000077";
  for (const [i, v] of Object.entries(werte)) c[Number(i)] = v;
  return c.join("\t");
};
const REPORT = [
  HEADER,
  zeile({ 1: "01.11.2026 21:09:34 UTC", 2: "15.11.2026 21:09:34 UTC", 3: "17.11.2026 21:09:34 UTC", 4: "104,73", 5: "EUR" }),
  zeile({ 6: "Order", 7: "302-1", 8: "302-1", 11: "Amazon.de", 12: "ItemPrice", 13: "Principal", 14: "119,00", 16: "03.11.2026" }),
  zeile({ 6: "Order", 7: "302-1", 8: "302-1", 11: "Amazon.de", 12: "ItemFees", 13: "Commission", 14: "-14,27", 16: "03.11.2026" }),
].join("\n");

async function amazonAttrappe(): Promise<Server> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const json = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (url.pathname === "/auth/o2/token") {
        if (new URLSearchParams(body).get("refresh_token") !== TOKEN)
          return json(400, { error: "invalid_grant", error_description: "The request has an invalid grant parameter" });
        return json(200, { access_token: "Atza|e2e", expires_in: 3600 });
      }
      if (request.headers["x-amz-access-token"] !== "Atza|e2e" && url.pathname.startsWith("/reports/"))
        return json(403, { errors: [{ code: "Unauthorized" }] });
      if (url.pathname === "/reports/2021-06-30/reports") {
        return json(200, { reports: [{ reportId: "R-E2E", reportDocumentId: "DOC-E2E", createdTime: "2026-11-17T21:16:17+00:00", processingStatus: "DONE" }] });
      }
      if (url.pathname === "/reports/2021-06-30/documents/DOC-E2E") return json(200, { url: `http://127.0.0.1:${AMAZON_PORT}/s3/DOC-E2E` });
      if (url.pathname === "/s3/DOC-E2E") {
        setTimeout(() => {
          response.writeHead(200, { "content-type": "text/plain; charset=UTF-8" });
          response.end(REPORT);
        }, pause);
        return;
      }
      json(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(AMAZON_PORT, "127.0.0.1", resolve));
  return server;
}

test.beforeAll(async ({ browser }) => {
  ({ page, pageErrors } = await durchlaufSeite(browser));
  amazon = await amazonAttrappe();
});

test.afterAll(async () => {
  await page.context().close();
  await new Promise((resolve) => amazon?.close(resolve));
});

test.afterEach(() => {
  expect(pageErrors).toEqual([]);
});

const karte = () => page.getByRole("region", { name: "Amazon SP-API" });
const knopf = () => page.getByRole("button", { name: /Amazon Datenabruf|Ruft ab …/ });

async function mitDatenbank<T>(arbeit: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(databaseUrlFuer("amazon-abruf"), { max: 1, onnotice: () => {} });
  try {
    return await arbeit(sql);
  } finally {
    await sql.end();
  }
}

test("Einrichtung", async () => {
  await einrichten(page);
});

test("Falsches Refresh-Token: Amazon lehnt ab, nichts wird gespeichert", async () => {
  await gehe(page, "/einstellungen?bereich=bank");
  await expect(karte().getByText("Nicht eingerichtet.")).toBeVisible();
  await karte().getByLabel("Client-ID", { exact: true }).fill(CLIENT_ID);
  await karte().getByLabel("Client-Secret", { exact: true }).fill(SECRET);
  await karte().getByLabel("Refresh-Token", { exact: true }).fill("Atzr|falsch");
  await karte().getByRole("button", { name: "Speichern" }).click();
  const meldung = karte().getByText(/Amazon nimmt den Zugang nicht an/);
  await expect(meldung).toBeVisible();
  await expect(meldung).not.toContainText(SECRET);
  expect(await mitDatenbank((sql) => sql`select count(*)::int as n from amazon_sp_connections`)).toEqual([{ n: 0 }]);
});

test("Zugang speichern: geprüft, verschlüsselt, nur die letzten Zeichen sichtbar", async () => {
  await karte().getByLabel("Client-ID", { exact: true }).fill(CLIENT_ID);
  await karte().getByLabel("Client-Secret", { exact: true }).fill(SECRET);
  await karte().getByLabel("Refresh-Token", { exact: true }).fill(TOKEN);
  await karte().getByRole("button", { name: "Speichern" }).click();
  await expect(karte().getByText("Zugang geprüft und gespeichert.")).toBeVisible();
  await expect(karte().getByText("Eingerichtet (Client-ID …AB12).")).toBeVisible();
  const [zeile_] = await mitDatenbank((sql) => sql`select position(${SECRET} in encode(ciphertext, 'escape')) as secret from amazon_sp_connections`);
  expect(zeile_).toEqual({ secret: 0 });
});

test("Ohne Amazon-Konto kein Knopf; mit Konto holt der Abruf die Abrechnung, gesperrt solange er läuft", async () => {
  await gehe(page, "/bank");
  await expect(knopf()).toHaveCount(0);
  await mitDatenbank(
    (sql) =>
      sql`insert into bank_accounts (name, purpose, provider, ledger_index, marketplace) values ('Amazon.de', 'zahlungsdienstleister', 'amazon', 1, 'Amazon.de')`,
  );
  await gehe(page, "/bank");
  pause = 1500;
  await knopf().click();
  await expect(page.getByRole("button", { name: "Ruft ab …" })).toBeDisabled();
  await expect(page.getByText("Amazon.de: 1 Abrechnung, 3 neue Umsätze")).toBeVisible();
  pause = 0;
  expect(await mitDatenbank((sql) => sql`select count(*)::int as n from bank_transactions`)).toEqual([{ n: 3 }]);

  await knopf().click();
  await expect(page.getByText("Keine neuen Abrechnungen bei Amazon (1 schon abgerufen).")).toBeVisible();
  expect(await mitDatenbank((sql) => sql`select count(*)::int as n from bank_transactions`)).toEqual([{ n: 3 }]);
});

test("Zugang entfernen: Knopf verschwindet, Umsätze bleiben", async () => {
  await gehe(page, "/einstellungen?bereich=bank");
  await karte().getByRole("button", { name: "Zugang entfernen" }).click();
  await page.getByRole("dialog", { name: "Amazon-Zugang entfernen?" }).getByRole("button", { name: "Entfernen" }).click();
  await expect(karte().getByText("Nicht eingerichtet.")).toBeVisible();
  await gehe(page, "/bank");
  await expect(knopf()).toHaveCount(0);
  expect(await mitDatenbank((sql) => sql`select count(*)::int as n from bank_transactions`)).toEqual([{ n: 3 }]);
});
