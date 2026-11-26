import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AMAZON_MARKETPLACES } from "@haben/core";
import {
  detectStatementFormat,
  PSP_FORMATS,
  parseStatement,
  readAmazonSettlementHead,
  StatementParseError,
  transactionHash,
  withDedupHashes,
} from "./index.ts";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../test-fixtures/${name}`, import.meta.url)));
const bytes = (text: string) => new TextEncoder().encode(text);
const sum = (total: number, t: { amount: number }) => total + t.amount;
const brief = (s: ReturnType<typeof parseStatement>) => s.transactions.map((t) => [t.bookingDate, t.amount, t.purpose]);

const HEADER = [
  "settlement-id",
  "settlement-start-date",
  "settlement-end-date",
  "deposit-date",
  "total-amount",
  "currency",
  "transaction-type",
  "order-id",
  "merchant-order-id",
  "adjustment-id",
  "shipment-id",
  "marketplace-name",
  "amount-type",
  "amount-description",
  "amount",
  "fulfillment-id",
  "posted-date",
  "posted-date-time",
  "order-item-code",
  "merchant-order-item-id",
  "merchant-adjustment-item-id",
  "sku",
  "quantity-purchased",
  "promotion-id",
].join("\t");

interface Row {
  type?: string;
  order?: string;
  marketplace?: string;
  amountType?: string;
  description?: string;
  amount?: string;
  date?: string;
  sku?: string;
}

function row(r: Row): string {
  const c = Array(24).fill("");
  c[0] = "10000000001";
  if (r.type) c[6] = r.type;
  if (r.order) {
    c[7] = r.order;
    c[8] = r.order;
  }
  if (r.marketplace) c[11] = r.marketplace;
  if (r.amountType) c[12] = r.amountType;
  if (r.description) c[13] = r.description;
  if (r.amount !== undefined) c[14] = r.amount;
  if (r.date) {
    c[16] = r.date;
    c[17] = `${r.date} 12:00:00 UTC`;
  }
  if (r.sku) c[21] = r.sku;
  return c.join("\t");
}

interface Head {
  total?: string;
  currency?: string;
  start?: string;
  end?: string;
  deposit?: string;
}

function file(rows: Row[], head: Head = {}): Uint8Array {
  const c = Array(24).fill("");
  c[0] = "10000000001";
  c[1] = `${head.start ?? "01.11.2026"} 00:00:00 UTC`;
  c[2] = `${head.end ?? "15.11.2026"} 00:00:00 UTC`;
  c[3] = `${head.deposit ?? "17.11.2026"} 00:00:00 UTC`;
  c[4] = head.total ?? "0,00";
  c[5] = head.currency ?? "EUR";
  return bytes([HEADER, c.join("\t"), ...rows.map(row)].join("\n"));
}

/*
 * Settlement-Report von Amazon (Seller Central › Berichte › Zahlungen, „Settlement Report“ V2, Tab-getrennt). Die erste
 * Datenzeile ist die Zusammenfassung der Abrechnung (Zeitraum, Auszahlungsbetrag, Währung); darunter steht jede Position
 * einzeln (amount mit amount-type und amount-description). Die Fixture ist aus einem echten amazon.de-Report anonymisiert
 * (Bestellnummern, SKUs, Settlement-ID ersetzt); die Beträge stimmen auf den Cent zum Auszahlungsbetrag.
 */
describe("Amazon-Settlement-Report", () => {
  it("erkennt die Datei und liest die Abrechnung", () => {
    const f = fixture("amazon-settlement.txt");
    expect(detectStatementFormat(f)).toBe("amazon-settlement");
    const s = parseStatement(f, "amazon-settlement.txt");
    expect(s.format).toBe("amazon-settlement");
    expect(s.currency).toBe("EUR");
    expect(s.marketplace).toBe("Amazon.de");
    expect([s.periodFrom, s.periodTo]).toEqual(["2026-11-03", "2026-11-17"]);
    // 15 Bestellungen zu je Erlös und Gebühr, 6 Sonderzeilen, die Auszahlung
    expect(s.transactions).toHaveLength(37);
    expect(s.transactions.reduce(sum, 0)).toBe(0);
    expect(s.warnings).toEqual([]);
  });

  it("liest die belgische Abrechnung (Amazon.com.be): Versand und Steuer im Erlös, Rücksendekosten als Gebühr", () => {
    const f = fixture("amazon-settlement-be.txt");
    expect(detectStatementFormat(f)).toBe("amazon-settlement");
    const s = parseStatement(f, "amazon-settlement-be.txt");
    expect(s.marketplace).toBe("Amazon.com.be");
    expect([s.periodFrom, s.periodTo]).toEqual(["2026-10-16", "2026-11-13"]);
    expect(s.transactions).toHaveLength(7);
    expect(s.transactions.reduce(sum, 0)).toBe(0);
    expect(s.transactions.filter((t) => t.type === "Auszahlung").map((t) => [t.bookingDate, t.amount])).toEqual([["2026-11-15", -767]]);
    expect(s.warnings).toEqual([]);
    // Principal 4,73 + Shipping 1,24 = Erlös; FBAPerUnitFulfillmentFee −2,11, Commission −0,45 und ShippingChargeback −1,23 als Gebühr
    expect(brief(s).filter(([, , p]) => String(p).includes("Bestellung 203-0000000-0000003"))).toEqual([
      ["2026-10-31", 597, "Verkauf · Bestellung 203-0000000-0000003"],
      ["2026-10-31", -379, "Gebühr · Bestellung 203-0000000-0000003"],
    ]);
  });

  it("liest die irische Abrechnung (Amazon.ie): Versandsteuer im Erlös, Rückvergütung als Erstattung", () => {
    const s = parseStatement(fixture("amazon-settlement-ie.txt"), "amazon-settlement-ie.txt");
    expect(s.marketplace).toBe("Amazon.ie");
    expect([s.periodFrom, s.periodTo]).toEqual(["2026-08-23", "2026-10-04"]);
    expect(s.transactions).toHaveLength(5);
    expect(s.transactions.reduce(sum, 0)).toBe(0);
    expect(brief(s)).toEqual([
      ["2026-08-23", -366, "Sonstiges · Payable to Amazon"],
      ["2026-09-28", 190, "Erstattung · FBA Inventory Reimbursement · REVERSAL_REIMBURSEMENT"],
      // Principal 5,00 + Tax 1,15 + Shipping 1,08 + ShippingTax 0,25 − Rabatte = 6,15; Gebühr −2,52
      ["2026-10-01", 615, "Verkauf · Bestellung 301-0000000-0000001"],
      ["2026-10-01", -252, "Gebühr · Bestellung 301-0000000-0000001"],
      ["2026-10-06", -187, "Auszahlung · Abrechnung 10000000003"],
    ]);
  });

  it("liest die niederländische Abrechnung (Amazon.nl)", () => {
    const s = parseStatement(fixture("amazon-settlement-nl.txt"), "amazon-settlement-nl.txt");
    expect(s.marketplace).toBe("Amazon.nl");
    expect(s.transactions).toHaveLength(3);
    expect(s.transactions.reduce(sum, 0)).toBe(0);
    expect(brief(s)).toEqual([
      ["2026-10-28", 546, "Verkauf · Bestellung 401-0000000-0000001"],
      ["2026-10-28", -284, "Gebühr · Bestellung 401-0000000-0000001"],
      ["2026-11-06", -262, "Auszahlung · Abrechnung 10000000004"],
    ]);
  });

  it.each([
    ["amazon-settlement-fr.txt", "Amazon.fr", 25],
    ["amazon-settlement-it.txt", "Amazon.it", 5],
    ["amazon-settlement-es.txt", "Amazon.es", 7],
  ])("liest %s (Marktplatz %s, %i Umsätze, Summe null)", (name, marketplace, count) => {
    const s = parseStatement(fixture(name), name);
    expect(s.marketplace).toBe(marketplace);
    expect(s.transactions).toHaveLength(count);
    expect(s.transactions.reduce(sum, 0)).toBe(0);
    expect(s.warnings).toEqual([]);
  });

  it("negative Abrechnung (Amazon.it): Amazon belastet, der Ausgleich im Konto ist positiv", () => {
    const s = parseStatement(fixture("amazon-settlement-it.txt"), "amazon-settlement-it.txt");
    expect(s.transactions.filter((t) => t.type === "Auszahlung").map((t) => [t.bookingDate, t.amount])).toEqual([["2026-11-17", 10]]);
  });

  it("jeder Marktplatzname der Amazon-Vorlagen steht in der Auswahlliste der Konten", () => {
    const files = readdirSync(new URL("../test-fixtures/", import.meta.url)).filter((name) => /^amazon-settlement.*\.txt$/.test(name));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const name of files) {
      const marketplace = parseStatement(fixture(name)).marketplace;
      expect(marketplace).toBeDefined();
      expect(AMAZON_MARKETPLACES).toContain(marketplace);
    }
  });

  it("verbucht die Auszahlung als negativen Umsatz am Auszahlungstag (Geldtransit)", () => {
    const s = parseStatement(fixture("amazon-settlement.txt"));
    expect(s.transactions.filter((t) => t.type === "Auszahlung").map((t) => [t.bookingDate, t.amount, t.purpose])).toEqual([
      ["2026-11-19", -993, "Auszahlung · Abrechnung 24681357900"],
    ]);
  });

  it("gruppiert jede Bestellung zu Erlös und Gebühr", () => {
    const s = parseStatement(fixture("amazon-settlement.txt"));
    const order = s.transactions.filter((t) => t.purpose.includes("Bestellung 101-0000000-0000001"));
    expect(order.map((t) => [t.type, t.amount, t.purpose])).toEqual([
      ["Verkauf", 649, "Verkauf · Bestellung 101-0000000-0000001"],
      ["Gebühr", -257, "Gebühr · Bestellung 101-0000000-0000001"],
    ]);
    // Erlöse und Gebühren getrennt summiert; die Sonderzeilen kommen als eigene Umsätze dazu
    expect(s.transactions.filter((t) => t.type === "Verkauf").reduce(sum, 0)).toBe(10350);
    expect(s.transactions.filter((t) => t.type === "Gebühr" && t.purpose.includes("Bestellung")).reduce(sum, 0)).toBe(-4689);
  });

  it("nimmt Erlös und Steuer zusammen (brutto) und zieht den Rabatt ab", () => {
    const s = parseStatement(
      file(
        [
          { type: "Order", order: "1-1", amountType: "ItemPrice", description: "Principal", amount: "4,87", date: "05.11.2026" },
          { type: "Order", order: "1-1", amountType: "ItemPrice", description: "Tax", amount: "0,92", date: "05.11.2026" },
          { type: "Order", order: "1-1", amountType: "Promotion", description: "Principal", amount: "-1,00", date: "05.11.2026" },
          { type: "Order", order: "1-1", amountType: "ItemFees", description: "Commission", amount: "-0,55", date: "05.11.2026" },
        ],
        { total: "4,24" },
      ),
    );
    expect(brief(s).filter(([, , purpose]) => !String(purpose).startsWith("Auszahlung"))).toEqual([
      ["2026-11-05", 479, "Verkauf · Bestellung 1-1"],
      ["2026-11-05", -55, "Gebühr · Bestellung 1-1"],
    ]);
    expect(s.transactions.map((t) => t.type)).toEqual(["Verkauf", "Gebühr", "Auszahlung"]);
  });

  it("liest eine Erstattung als Erstattung, ihre Gebührengutschrift bleibt eine Gebühr", () => {
    const s = parseStatement(
      file(
        [
          { type: "Refund", order: "2-2", amountType: "ItemPrice", description: "Principal", amount: "-8,00", date: "06.11.2026" },
          { type: "Refund", order: "2-2", amountType: "ItemFees", description: "Commission", amount: "0,68", date: "06.11.2026" },
        ],
        { total: "-7,32" },
      ),
    );
    expect(brief(s).filter(([, , purpose]) => !String(purpose).startsWith("Auszahlung"))).toEqual([
      ["2026-11-06", -800, "Erstattung · Bestellung 2-2"],
      ["2026-11-06", 68, "Gebühr · Bestellung 2-2"],
    ]);
    expect(s.transactions.map((t) => t.type)).toEqual(["Erstattung", "Gebühr", "Auszahlung"]);
  });

  it("ordnet die Sonderzeilen zu: Gebühr, Erstattung, Sonstiges", () => {
    const s = parseStatement(fixture("amazon-settlement.txt"));
    const special = s.transactions.filter((t) => !t.purpose.includes("Bestellung") && t.type !== "Auszahlung");
    expect(special.map((t) => [t.bookingDate, t.amount, t.type, t.purpose])).toEqual([
      ["2026-11-03", -119, "Sonstiges", "Sonstiges · Payable to Amazon"],
      ["2026-11-03", 119, "Sonstiges", "Sonstiges · Cross-Account Debt Adjustment against FR"],
      ["2026-11-07", -102, "Gebühr", "Gebühr · FBA Inventory Storage Fee · Base fee"],
      ["2026-11-07", -19, "Gebühr", "Gebühr · FBA Inventory Storage Fee · Tax on fee"],
      ["2026-11-09", -4641, "Gebühr", "Gebühr · Subscription Fee"],
      ["2026-11-17", 94, "Erstattung", "Erstattung · FBA Inventory Reimbursement · WAREHOUSE_LOST"],
    ]);
  });

  it("gibt den Marktplatz der Abrechnung mit", () => {
    const s = parseStatement(
      file(
        [{ type: "Order", order: "1-1", marketplace: "Amazon.fr", amountType: "ItemPrice", description: "Principal", amount: "10,00", date: "05.11.2026" }],
        {
          total: "10,00",
        },
      ),
    );
    expect(s.marketplace).toBe("Amazon.fr");
  });

  it("nennt die Abrechnung mehrere Marktplätze, wird der Marktplatz nicht geprüft", () => {
    const s = parseStatement(
      file(
        [
          { type: "Order", order: "1-1", marketplace: "Amazon.de", amountType: "ItemPrice", description: "Principal", amount: "10,00", date: "05.11.2026" },
          { type: "Order", order: "2-2", marketplace: "Amazon.fr", amountType: "ItemPrice", description: "Principal", amount: "5,00", date: "05.11.2026" },
        ],
        { total: "15,00" },
      ),
    );
    expect(s.marketplace).toBeUndefined();
    expect(s.warnings).toEqual(["Die Abrechnung nennt mehrere Marktplätze (Amazon.de, Amazon.fr); der Marktplatz wird nicht geprüft."]);
  });

  it("lehnt eine Abrechnung in fremder Währung ab (nur die EUR-Marktplätze)", () => {
    const f = file([{ type: "Order", order: "1-1", amountType: "ItemPrice", description: "Principal", amount: "10.00", date: "05.11.2026" }], {
      total: "10.00",
      currency: "GBP",
    });
    expect(() => parseStatement(f, "amazon-settlement.txt")).toThrow(StatementParseError);
    expect(() => parseStatement(f, "amazon-settlement.txt")).toThrow(/in GBP\. .*nur in Euro/);
  });

  it("warnt, wenn die Summe der Positionen vom Auszahlungsbetrag abweicht", () => {
    const s = parseStatement(
      file([{ type: "Order", order: "1-1", amountType: "ItemPrice", description: "Principal", amount: "10,00", date: "05.11.2026" }], { total: "9,00" }),
    );
    expect(s.transactions.reduce(sum, 0)).toBe(1000 - 900);
    expect(s.warnings).toEqual(["Die Summe der Positionen (10,00 €) weicht vom Auszahlungsbetrag (9,00 €) ab; bitte den Report prüfen."]);
  });

  it("bricht bei ungültigem Datum oder Betrag mit Zeilenangabe ab", () => {
    const bad = file([{ type: "Order", order: "1-1", amountType: "ItemPrice", description: "Principal", amount: "€abc", date: "05.11.2026" }], {
      total: "0,00",
    });
    expect(() => parseStatement(bad, "amazon.txt")).toThrow(/Ungültiger Betrag „€abc“ \(Zeile 3\)/);
    const badDate = file([{ type: "Order", order: "1-1", amountType: "ItemPrice", description: "Principal", amount: "1,00", date: "Sunday 99" }], {
      total: "0,00",
    });
    expect(() => parseStatement(badDate, "amazon.txt")).toThrow(/Ungültiges Datum „Sunday 99“ \(Zeile 3\)/);
  });

  it("gilt als Zahlungsdienstleister: nur in ein Konto mit diesem Zweck importierbar", () => {
    expect(PSP_FORMATS).toContain("amazon-settlement");
  });

  it("legt beim erneuten Import dieselben Dubletten-Hashes an, gleiche Zeilen bekommen verschiedene", () => {
    const s = parseStatement(fixture("amazon-settlement.txt"));
    const first = withDedupHashes(s.transactions).map((t) => t.dedupHash);
    const again = withDedupHashes(parseStatement(fixture("amazon-settlement.txt")).transactions).map((t) => t.dedupHash);
    expect(again).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
    expect(first[0]).toBe(transactionHash(s.transactions[0]!, 0));
  });

  it("liest das Datum auch als ISO und die Beträge mit Dezimalpunkt (englischer Export)", () => {
    const s = parseStatement(
      file([{ type: "Order", order: "1-1", amountType: "ItemPrice", description: "Principal", amount: "10.00", date: "05.11.2026" }], { total: "10.00" }),
    );
    expect(brief(s)[0]).toEqual(["2026-11-05", 1000, "Verkauf · Bestellung 1-1"]);
  });
});

describe("Kopf eines Amazon-Settlement-Reports (für den Abruf, #1947)", () => {
  const order = (marketplace: string) => [
    { type: "Order", order: "302-1", marketplace, amountType: "ItemPrice", description: "Principal", amount: "10,00", date: "03.11.2026" },
  ];

  it("nennt Settlement-ID, Währung, Marktplätze und Zeitraum", () => {
    expect(readAmazonSettlementHead(file(order("Amazon.de"), { total: "10,00" }))).toEqual({
      settlementId: "10000000001",
      currency: "EUR",
      marketplaces: ["Amazon.de"],
      periodFrom: "2026-11-01",
      periodTo: "2026-11-15",
    });
  });

  it("liest auch eine Abrechnung in GBP, ohne abzulehnen", () => {
    expect(readAmazonSettlementHead(file(order("Amazon.co.uk"), { currency: "GBP" }))).toMatchObject({ currency: "GBP", marketplaces: ["Amazon.co.uk"] });
  });

  it("nennt alle Marktplätze, wenn eine Abrechnung mehrere hat, und keinen bei nur Sonderzeilen", () => {
    const mehrere = file([...order("Amazon.fr"), ...order("Amazon.de")]);
    expect(readAmazonSettlementHead(mehrere)?.marketplaces).toEqual(["Amazon.de", "Amazon.fr"]);
    const sonder = file([
      { type: "other-transaction", amountType: "other-transaction", description: "Payable to Amazon", amount: "-1,00", date: "03.11.2026" },
    ]);
    expect(readAmazonSettlementHead(sonder)?.marketplaces).toEqual([]);
  });

  it("gibt null für eine andere Datei", () => {
    expect(readAmazonSettlementHead(bytes("Buchungsdatum;Betrag\n01.11.2026;1,00\n"))).toBeNull();
    expect(readAmazonSettlementHead(bytes(""))).toBeNull();
  });

  it("gibt die Settlement-ID auch im Ergebnis des Parsers zurück", () => {
    expect(parseStatement(file(order("Amazon.de"), { total: "10,00" }), "a.txt").settlementId).toBe("10000000001");
  });
});
