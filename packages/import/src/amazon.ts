import type { Cents } from "@haben/core";
import { finish, indexed, requireAmount, type Tx } from "./common.ts";
import { isBlankRow, parseCsv } from "./csv.ts";
import { decodeText } from "./decode.ts";
import { StatementParseError } from "./errors.ts";
import { pspDate } from "./psp.ts";
import { Columns, findHeaderRow } from "./table.ts";
import { parseDotAmount, parseGermanAmount } from "./text.ts";
import type { ParsedStatement } from "./types.ts";

/*
 * Settlement-Report (Abrechnung) von Amazon: die Abrechnung eines Marktplatzes über einen Zeitraum (Seller Central ›
 * Berichte › Zahlungen, „Settlement Report“, Format GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2, Tab-getrennt). Die erste
 * Datenzeile ist die Zusammenfassung (settlement-id, Zeitraum, deposit-date, total-amount, currency); darunter steht jede
 * Position mit ihrem Betrag (amount), unterschieden in transaction-type, amount-type und amount-description. Der Aufbau
 * stammt aus echten Reports (deutsche Formate: Komma-Beträge, TT.MM.JJJJ; englische: Punkt-Beträge, ISO-/US-Daten),
 * deshalb liest der Parser beides.
 *
 * Haben fasst die Positionen einer Bestellung wie bei den übrigen Zahlungsdienstleistern zu zwei Umsätzen zusammen: dem
 * Erlös brutto (ItemPrice und Promotion, also Principal + Tax − Rabatt) und der einbehaltenen Gebühr (ItemFees). So lässt
 * sich der Erlös der Rechnung zuordnen (voller Erlös, Bruttoprinzip) und die Gebühr einer Gebührenrechnung. Sonderzeilen
 * (Abo-Gebühr, Lagergebühr, Erstattung, Rückstellung, Kontenausgleich) werden eigene Umsätze; die Auszahlung (total-amount
 * am deposit-date) ist ein negativer Umsatz und wird im Bankabgleich als Geldtransit mit dem Eingang verbunden.
 * Nur Euro: die Abrechnungswährung steht in der Kopfline, andere Marktplätze (GBP, PLN, SEK) lehnt Haben ab.
 */

/** Erkennt den Settlement-Report an seiner Kopfzeile */
export function isAmazonSettlementHeader(c: Columns): boolean {
  return c.has("settlementid") && c.has("transactiontype") && c.has("amounttype") && c.has("amountdescription") && c.has("totalamount");
}

/** Sonderzeilen (nicht zu einer Bestellung): Beschreibungen → Bezeichnung des Umsatzes */
const SPECIAL: [RegExp, string][] = [
  [/reimbursement|warehouse[_ ]?lost/i, "Erstattung"],
  [/fee|subscription|commission|fulfil|storage|ads/i, "Gebühr"],
];
const specialLabel = (amountType: string, description: string): string =>
  SPECIAL.find(([pattern]) => pattern.test(`${amountType} ${description}`))?.[1] ?? "Sonstiges";

/** Amazon schreibt deutsche („6,49“) und englische („6.49“) Beträge */
const amazonAmount = (raw: string): Cents | null => parseGermanAmount(raw) ?? parseDotAmount(raw);

/** „10.11.2026“ oder „10.11.2026 17:21:37 UTC“ → 2026-11-10 */
const amazonDay = (raw: string, where: string) => pspDate(raw.trim().replace(/\s+\d{1,2}:\d{2}(?::\d{2})?.*$/, ""), where);

/** Betrag lesbar melden */
const euros = (cents: Cents) => `${(cents / 100).toFixed(2).replace(".", ",")} €`;

/** Bestellung mit ihrem Erlös (brutto) und ihrer Gebühr */
interface OrderTotal {
  refund: boolean;
  date: string;
  revenue: Cents;
  fee: Cents;
}

/** Zeile mit ihrer Nummer in der Datei */
interface Position {
  row: string[];
  line: number;
}

/** Zusammenfassung der Abrechnung aus der Kopfline */
interface AmazonHead {
  row: string[];
  settlementId: string;
  periodFrom: string | undefined;
  periodTo: string | undefined;
  payoutTotal: Cents | null;
  payoutDate: string | undefined;
}

/** Zugriff auf die Spalten des Reports */
function amazonColumns(c: Columns) {
  return {
    settlement: c.getter("settlementid"),
    start: c.getter("settlementstartdate"),
    end: c.getter("settlementenddate"),
    deposit: c.getter("depositdate"),
    total: c.getter("totalamount"),
    currency: c.getter("currency"),
    type: c.getter("transactiontype"),
    order: c.getter("orderid"),
    amountType: c.getter("amounttype"),
    description: c.getter("amountdescription"),
    amount: c.getter("amount"),
    marketplaceName: c.getter("marketplacename"),
    posted: c.getter("posteddate"),
  };
}
type AmazonColumns = ReturnType<typeof amazonColumns>;

/** Zeilen unter der Kopfzeile mit ihrer Nummer in der Datei, ohne leere */
function dataRows(rows: string[][], headerRow: number): Position[] {
  return rows
    .slice(headerRow + 1)
    .map((row, i) => ({ row, line: headerRow + i + 2 }))
    .filter(({ row }) => !isBlankRow(row));
}

/** Die Zusammenfassung: total-amount gesetzt, aber keine Zeilenart */
const headLine = (get: AmazonColumns, data: Position[]) => data.find(({ row }) => get.total(row) !== "" && get.type(row) === "");

/** Kopf einer Abrechnung, wie ihn der Abruf vor der Übernahme braucht (#1947) */
export interface AmazonSettlementHead {
  settlementId: string;
  currency: string;
  /** Alle Werte von marketplace-name, sortiert; leer, wenn die Datei keinen nennt */
  marketplaces: string[];
  periodFrom: string | undefined;
  periodTo: string | undefined;
}

/**
 * Liest nur den Kopf eines Settlement-Reports, ohne Währung oder Summen zu prüfen: Der Abruf muss Marktplatz und
 * Währung kennen, bevor er ein Konto wählt, und eine Abrechnung in GBP abschließen, statt sie bei jedem Klick neu zu
 * laden. null, wenn die Datei kein Settlement-Report ist.
 */
export function readAmazonSettlementHead(bytes: Uint8Array): AmazonSettlementHead | null {
  const rows = parseCsv(decodeText(bytes).replace(/^\uFEFF/, ""), "\t");
  const headerRow = findHeaderRow(rows, isAmazonSettlementHeader);
  if (headerRow < 0) return null;
  const get = amazonColumns(new Columns(rows[headerRow]!));
  const data = dataRows(rows, headerRow);
  const head = headLine(get, data);
  if (!head) return null;
  const marketplaces = [...new Set(data.map(({ row }) => get.marketplaceName(row)).filter((m) => m !== ""))].sort();
  return {
    settlementId: get.settlement(head.row),
    currency: get.currency(head.row).toUpperCase() || "EUR",
    marketplaces,
    periodFrom: get.start(head.row) ? amazonDay(get.start(head.row), "Kopfline") : undefined,
    periodTo: get.end(head.row) ? amazonDay(get.end(head.row), "Kopfline") : undefined,
  };
}

/** Kopfline lesen: settlement-id und total-amount, aber keine Zeilenart; nur Euro */
function amazonHead(get: AmazonColumns, data: Position[]): AmazonHead {
  const head = headLine(get, data);
  if (!head) throw new StatementParseError("Der Amazon-Settlement-Report nennt keinen Auszahlungsbetrag (Spalte total-amount fehlt).");
  const headCurrency = get.currency(head.row).toUpperCase() || "EUR";
  if (headCurrency !== "EUR") {
    throw new StatementParseError(
      `Der Amazon-Settlement-Report ist in ${headCurrency}. Haben übernimmt Abrechnungen nur in Euro (Marktplätze DE, FR, IT, ES, NL, BE, IE).`,
    );
  }
  const periodFrom = get.start(head.row) ? amazonDay(get.start(head.row), "Kopfline") : undefined;
  const periodTo = get.end(head.row) ? amazonDay(get.end(head.row), "Kopfline") : undefined;
  return {
    row: head.row,
    settlementId: get.settlement(head.row),
    periodFrom,
    periodTo,
    payoutTotal: get.total(head.row) ? requireAmount(amazonAmount(get.total(head.row)), get.total(head.row), "Kopfline") : null,
    payoutDate: (get.deposit(head.row) ? amazonDay(get.deposit(head.row), "Kopfline") : periodTo) ?? periodTo,
  };
}

/** Eine Sonderzeile als Umsatz; der Zweck nennt die Position, transaction-type entfällt, wenn er nur „other-transaction“ ist */
function amazonSpecial(get: AmazonColumns, row: string[], kind: string, cents: Cents, settlementId: string, where: string): Tx {
  const at = get.amountType(row);
  const names = [at, get.description(row)].filter((n) => n !== "" && n !== kind);
  const label = specialLabel(at, get.description(row));
  return {
    bookingDate: amazonDay(get.posted(row), where),
    amount: cents,
    currency: "EUR",
    counterpartyName: "Amazon",
    purpose: [label, ...names].filter(Boolean).join(" · "),
    type: label,
    bankReference: [settlementId, kind, at, get.description(row)].filter(Boolean).join("|"),
  };
}

/** Alle Positionen in Bestellungen (Erlös und Gebühr) und Sonderzeilen aufteilen */
function amazonPositions(get: AmazonColumns, data: Position[], head: AmazonHead) {
  const orders = new Map<string, OrderTotal>();
  const marketplaces = new Set<string>();
  const list: Tx[] = [];
  let positionSum = 0;
  for (const { row, line } of data) {
    if (row === head.row || get.type(row) === "") continue;
    const raw = get.amount(row);
    if (!raw) continue;
    const where = `Zeile ${line}`;
    const cents = requireAmount(amazonAmount(raw), raw, where);
    positionSum += cents;
    const kind = get.type(row);
    const orderId = get.order(row);
    if (get.marketplaceName(row)) marketplaces.add(get.marketplaceName(row));
    if ((kind === "Order" || kind === "Refund") && orderId) {
      const key = `${kind}|${orderId}`;
      const entry = orders.get(key) ?? { refund: kind === "Refund", date: amazonDay(get.posted(row), where), revenue: 0, fee: 0 };
      entry.date = amazonDay(get.posted(row), where);
      if (get.amountType(row) === "ItemFees") entry.fee += cents;
      else entry.revenue += cents; // ItemPrice, Promotion, ShippingCharge, GiftWrap …
      orders.set(key, entry);
      continue;
    }
    list.push(amazonSpecial(get, row, kind, cents, head.settlementId, where));
  }
  return { list, orders, positionSum, marketplaces };
}

/** Je Bestellung den Erlös und die Gebühr als eigene Umsätze anhängen */
function amazonOrderTransactions(list: Tx[], orders: Map<string, OrderTotal>, settlementId: string) {
  for (const [key, entry] of orders) {
    const value = key.slice(key.indexOf("|") + 1);
    const label = entry.refund ? "Erstattung" : "Verkauf";
    const ref = [settlementId, entry.refund ? "Refund" : "Order", value].join("|");
    if (entry.revenue !== 0) {
      list.push({
        bookingDate: entry.date,
        amount: entry.revenue,
        currency: "EUR",
        counterpartyName: "Amazon",
        purpose: `${label} · Bestellung ${value}`,
        type: label,
        bankReference: ref,
      });
    }
    if (entry.fee !== 0) {
      list.push({
        bookingDate: entry.date,
        amount: entry.fee,
        currency: "EUR",
        counterpartyName: "Amazon",
        purpose: `Gebühr · Bestellung ${value}`,
        type: "Gebühr",
        bankReference: `${ref}|gebuehr`,
      });
    }
  }
}

/** Abweichung der Positionssumme vom Auszahlungsbetrag und mehrere Marktplätze melden */
function amazonWarnings(positionSum: Cents, payoutTotal: Cents | null, marketplaces: Set<string>): string[] {
  const warnings: string[] = [];
  if (payoutTotal !== null && positionSum !== payoutTotal) {
    warnings.push(`Die Summe der Positionen (${euros(positionSum)}) weicht vom Auszahlungsbetrag (${euros(payoutTotal)}) ab; bitte den Report prüfen.`);
  }
  if (marketplaces.size > 1) {
    warnings.push(`Die Abrechnung nennt mehrere Marktplätze (${[...marketplaces].join(", ")}); der Marktplatz wird nicht geprüft.`);
  }
  return warnings;
}

/** Settlement-Report von Amazon (Tab-getrennt), nur Abrechnungen in Euro */
export function parseAmazonSettlement(rows: string[][], headerRow: number): ParsedStatement {
  const get = amazonColumns(new Columns(rows[headerRow]!));
  const data = dataRows(rows, headerRow);
  const head = amazonHead(get, data);
  const { list, orders, positionSum, marketplaces } = amazonPositions(get, data, head);
  amazonOrderTransactions(list, orders, head.settlementId);

  if (head.payoutTotal !== null && head.payoutTotal !== 0 && head.payoutDate) {
    list.push({
      bookingDate: head.payoutDate,
      amount: -head.payoutTotal,
      currency: "EUR",
      counterpartyName: "Amazon",
      purpose: `Auszahlung · Abrechnung ${head.settlementId}`,
      type: "Auszahlung",
      bankReference: ["amazon-payout", head.settlementId].join("|"),
    });
  }

  list.sort((a, b) => a.bookingDate.localeCompare(b.bookingDate));
  return finish({
    format: "amazon-settlement",
    currency: "EUR",
    marketplace: marketplaces.size === 1 ? [...marketplaces][0] : undefined,
    settlementId: head.settlementId,
    periodFrom: head.periodFrom,
    periodTo: head.periodTo,
    transactions: indexed(list),
    warnings: amazonWarnings(positionSum, head.payoutTotal, marketplaces),
  });
}
