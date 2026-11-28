import { createServer, type Server } from "node:http";
import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { AMAZON_PORT, databaseUrlFuer } from "./durchlaeufe.ts";
import { durchlaufSeite, einrichten, gehe } from "./einrichtung.ts";

/**
 * Amazon Datenabruf (#1947) in eigener, leerer Datenbank (Projekt „amazon-abruf“): Zugang unter Verbindungen prüfen und
 * speichern, Knopf auf der Bank nur mit Zugang und Amazon-Konto, Abruf mit gesperrtem Knopf, zweiter Abruf ohne
 * Dubletten, Zugang entfernen. Die nachgebaute SP-API kennt nur das Refresh-Token unten und liefert einen Report für
 * Amazon.de. Werte erfunden.
 */

test.describe.configure({ mode: "serial" });

const CLIENT_ID = "amzn1.application-oa2-client.e2eAB12";
const SECRET = "e2e-amazon-geheimnis";
const TOKEN = "Atzr|e2e-refresh-token";

let page: Page;
let pageErrors: string[] = [];
let amazon: Server;
/** Hält die Report-Datei zurück, bis der Test sie freigibt, damit der gesperrte Knopf sichtbar ist */
let tor: Promise<void> = Promise.resolve();
let freigeben: (() => void) | null = null;

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
        void tor.then(() => {
          response.writeHead(200, { "content-type": "text/plain; charset=UTF-8" });
          response.end(REPORT);
        });
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

/** Der eingeklappte Abschnitt „Amazon-Abrechnungen“ in Stores und Marktplätze (EinklappAbschnitt, id „amazon“) */
const karte = () => page.locator('section[aria-labelledby="amazon"]');
/** „Amazon Datenabruf“ steht im Abschnitt und im ⋯ der Amazon-Karte auf der Bankseite (#1947) */
const knopf = () => karte().getByRole("button", { name: /^Amazon Datenabruf( läuft …)?$/ });
/** Klappt den Abschnitt auf; nach dem Speichern bleibt er offen, weil ihn die Seite hält */
async function karteOeffnen() {
  const details = karte().locator("details");
  if (!(await details.evaluate((element: HTMLDetailsElement) => element.open))) await karte().locator("summary").click();
  await expect(details).toHaveAttribute("open", "");
}

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

test("Die Einrichtung fragt bei Amazon nach dem Weg; Konto zuerst, der Zugang steht unter Verbindungen", async () => {
  await gehe(page, "/bank/verbinden/amazon");
  const weg = page.getByRole("form", { name: "Weg" });
  await expect(weg.getByRole("radio", { name: "Mit Exportdatei" })).toBeVisible();
  await expect(weg.getByRole("radio", { name: "Über die SP-API" })).toBeVisible();
  await weg.getByRole("radio", { name: "Über die SP-API" }).check();
  await weg.getByRole("button", { name: "Weiter" }).click();
  await expect(page.getByText("Schritt 2 von 2")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Konto", level: 2 })).toBeVisible();
  await expect(page.getByLabel("Marktplatz", { exact: true })).toBeVisible();
});

test("Falsches Refresh-Token: Amazon lehnt ab, nichts wird gespeichert", async () => {
  await gehe(page, "/bank/verbindungen");
  await expect(karte()).toContainText("nicht verbunden");
  await karteOeffnen();
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
  await karteOeffnen();
  await karte().getByLabel("Client-ID", { exact: true }).fill(CLIENT_ID);
  await karte().getByLabel("Client-Secret", { exact: true }).fill(SECRET);
  await karte().getByLabel("Refresh-Token", { exact: true }).fill(TOKEN);
  await karte().getByRole("button", { name: "Speichern" }).click();
  await expect(karte().getByText("Zugang geprüft und gespeichert.")).toBeVisible();
  await expect(karte()).toContainText("verbunden (Client-ID …AB12)");
  const [zeile_] = await mitDatenbank((sql) => sql`select position(${SECRET} in encode(ciphertext, 'escape')) as secret from amazon_sp_connections`);
  expect(zeile_).toEqual({ secret: 0 });
});

test("Ohne Amazon-Konto kein Knopf; mit Konto holt der Abruf die Abrechnung, gesperrt solange er läuft", async () => {
  await gehe(page, "/bank/verbindungen");
  await karteOeffnen();
  await expect(page.getByText(/Lege je Marktplatz ein Amazon-Konto an/)).toBeVisible();
  await expect(knopf()).toHaveCount(0);
  await mitDatenbank(
    (sql) =>
      sql`insert into bank_accounts (name, purpose, provider, ledger_index, marketplace) values ('Amazon.de', 'zahlungsdienstleister', 'amazon', 1, 'Amazon.de')`,
  );
  await gehe(page, "/bank/verbindungen");
  await karteOeffnen();
  tor = new Promise<void>((resolve) => (freigeben = resolve));
  try {
    await knopf().click();
    await expect(karte().getByRole("button", { name: "Amazon Datenabruf läuft …" })).toBeDisabled();
    await expect(karte().getByRole("button", { name: "Abbrechen" })).toBeVisible();
    await expect(karte().getByText(/Report 1 von 1/)).toBeVisible();
    await page.reload();
    await karteOeffnen();
    await expect(karte().getByRole("button", { name: "Amazon Datenabruf läuft …" })).toBeDisabled();
    await expect(karte().getByText(/Report 1 von 1/)).toBeVisible();
    freigeben?.();
    const meldung = karte().getByText("Amazon.de: 1 Abrechnung, 3 neue Umsätze");
    await expect(meldung).toBeVisible();
    await karte().getByRole("button", { name: "Meldungen schließen" }).click();
    await expect(meldung).toHaveCount(0);
  } finally {
    freigeben?.();
  }
  expect(await mitDatenbank((sql) => sql`select count(*)::int as n from bank_transactions`)).toEqual([{ n: 3 }]);

  await knopf().click();
  await expect(karte().getByText("Keine neuen Abrechnungen bei Amazon (1 schon abgerufen).")).toBeVisible();
  expect(await mitDatenbank((sql) => sql`select count(*)::int as n from bank_transactions`)).toEqual([{ n: 3 }]);
});

test("Dateiimport ohne Kontoangabe: der Marktplatz der Abrechnung wählt das Amazon-Konto (#1947)", async () => {
  await gehe(page, "/bank");
  await page.getByLabel("Kontoauszugsdateien").setInputFiles({ name: "amazon-settlement.txt", mimeType: "text/plain", buffer: Buffer.from(REPORT, "utf8") });
  // Keine Nachfrage nach dem Konto: die Datei nennt Amazon.de, das Konto steht fest. Die Abrechnung ist schon abgerufen.
  await expect(page.getByText(/amazon-settlement\.txt: 0 neue Umsätze für Amazon\.de/)).toBeVisible();
  await expect(page.getByLabel("Konto", { exact: true })).toHaveCount(0);
});

test("Zugang entfernen: Knopf verschwindet, Umsätze bleiben", async () => {
  await gehe(page, "/bank/verbindungen");
  await karteOeffnen();
  await karte().getByRole("button", { name: "Zugang entfernen" }).click();
  await page.getByRole("dialog", { name: "Amazon-Zugang entfernen?" }).getByRole("button", { name: "Entfernen" }).click();
  await expect(karte()).toContainText("nicht verbunden");
  await expect(knopf()).toHaveCount(0);
  expect(await mitDatenbank((sql) => sql`select count(*)::int as n from bank_transactions`)).toEqual([{ n: 3 }]);
});
