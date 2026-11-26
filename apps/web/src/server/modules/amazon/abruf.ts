import { AmazonSpApiError, type AmazonSettlementReportInfo, parseStatement, readAmazonSettlementHead, StatementParseError } from "@haben/import";
import { and, eq, isNull, sql } from "drizzle-orm";
import { withActor } from "../../db/actor.ts";
import { db, schema } from "../../db/index.ts";
import { sha256Of } from "../../storage.ts";
import {
  abgeschlosseneAmazonReports,
  amazonReportAbgeschlossen,
  BankError,
  keineExterneQuelle,
  offeneAmazonVersuche,
  protokolliereAmazonVersuch,
  storeStatement,
  uebernommeneAmazonSettlements,
  type AmazonVersuch,
} from "../bank/index.ts";
import { waehleReports } from "./auswahl.ts";
import { amazonFehlertext, amazonSpClientFor, AmazonSpError, loadAmazonSpConnection } from "./connections.ts";

/*
 * Amazon Datenabruf (#1947): holt die Settlement Reports, die Amazon noch bereithält und die nicht abgeschlossen sind,
 * zuerst nie versuchte, ältester zuerst (Auswahl in auswahl.ts; Reports ohne Konto oder mit zwei Konten bleiben liegen,
 * bis sich daran etwas ändert), und übernimmt jeden über storeStatement in das eine Amazon-Konto seines Marktplatzes. Den Marktplatz
 * nennt nur die Datei. Jeder Report ist eine eigene Transaktion: Bricht der Abruf ab (Drosselung nach etwa 15
 * Downloads), bleibt Übernommenes, und der nächste Abruf macht weiter. Eine feste Advisory-Sperre reiht parallele
 * Abrufe hintereinander; danach prüft jeder erneut, ob der Report schon abgeschlossen ist.
 */

export interface AmazonAbrufErgebnis {
  uebernommen: { marketplace: string; accountName: string; settlementId: string; added: number; warnings: string[] }[];
  fremdwaehrung: { marketplace: string; currency: string }[];
  ohneKonto: string[];
  mehrdeutig: string[];
  /** „Report <id>: <Grund>“ */
  fehler: string[];
  schonAbgerufen: number;
  /** Wegen Drosselung nicht mehr geladen */
  nichtGeprueft: number;
}

type Konto = { id: string; name: string };

/** Nicht ausgeschlossene Amazon-Konten je Marktplatz, ohne Rücksicht auf Groß- und Kleinschreibung (wie import-konto.ts) */
async function amazonKonten(): Promise<Map<string, Konto[]>> {
  const rows = await db
    .select({ id: schema.bankAccounts.id, name: schema.bankAccounts.name, marketplace: schema.bankAccounts.marketplace })
    .from(schema.bankAccounts)
    .where(and(eq(schema.bankAccounts.provider, "amazon"), isNull(schema.bankAccounts.excludedAt), eq(schema.bankAccounts.purpose, "zahlungsdienstleister")));
  const konten = new Map<string, Konto[]>();
  for (const r of rows) {
    if (!r.marketplace) continue;
    const key = r.marketplace.toLowerCase();
    konten.set(key, [...(konten.get(key) ?? []), { id: r.id, name: r.name }]);
  }
  return konten;
}

const versuch = (actor: string, v: AmazonVersuch) => withActor(actor, (tx) => protokolliereAmazonVersuch(tx, v));

export async function amazonDatenabruf(actor: string): Promise<AmazonAbrufErgebnis> {
  const connection = await loadAmazonSpConnection();
  if (!connection) throw new AmazonSpError("Der Amazon-Zugang ist nicht eingerichtet (Einstellungen › Bank).");
  const client = amazonSpClientFor(connection.credentials);
  let reports: AmazonSettlementReportInfo[];
  try {
    reports = await client.settlementReports();
  } catch (error) {
    throw new AmazonSpError(amazonFehlertext(error));
  }
  const ergebnis: AmazonAbrufErgebnis = { uebernommen: [], fremdwaehrung: [], ohneKonto: [], mehrdeutig: [], fehler: [], schonAbgerufen: 0, nichtGeprueft: 0 };
  const konten = await amazonKonten();
  const auswahl = waehleReports(
    reports,
    await abgeschlosseneAmazonReports(db),
    await offeneAmazonVersuche(db),
    await uebernommeneAmazonSettlements(db),
    (marketplace) => konten.get(marketplace.toLowerCase())?.length ?? 0,
  );
  const offen = auswahl.zuLaden;
  ergebnis.schonAbgerufen = auswahl.schonAbgerufen;
  ergebnis.ohneKonto.push(...auswahl.ohneKonto);
  ergebnis.mehrdeutig.push(...auswahl.mehrdeutig);
  for (const [i, report] of offen.entries()) {
    let bytes: Uint8Array;
    try {
      bytes = await client.download(report.reportDocumentId);
    } catch (error) {
      if (error instanceof AmazonSpApiError && error.art !== "sonstig") {
        // Drosselung, Zugang oder Rolle: die übrigen Reports scheitern genauso
        ergebnis.nichtGeprueft = offen.length - i;
        if (error.art !== "drosselung") ergebnis.fehler.push(error.message);
        break;
      }
      const meldung = amazonFehlertext(error);
      await versuch(actor, { reportId: report.reportId, ergebnis: "fehler", meldung });
      ergebnis.fehler.push(`Report ${report.reportId}: ${meldung}`);
      continue;
    }
    await verarbeite(actor, report, bytes, konten, ergebnis);
  }
  return ergebnis;
}

async function verarbeite(
  actor: string,
  report: AmazonSettlementReportInfo,
  bytes: Uint8Array,
  konten: Map<string, Konto[]>,
  ergebnis: AmazonAbrufErgebnis,
): Promise<void> {
  const fehler = async (meldung: string, kopf: Partial<AmazonVersuch> = {}) => {
    await versuch(actor, { ...kopf, reportId: report.reportId, ergebnis: "fehler", meldung });
    ergebnis.fehler.push(`Report ${report.reportId}: ${meldung}`);
  };
  let head: ReturnType<typeof readAmazonSettlementHead>;
  try {
    head = readAmazonSettlementHead(bytes);
  } catch (error) {
    return fehler(error instanceof Error ? error.message : String(error));
  }
  if (!head) return fehler("Die Datei ist keine Amazon-Abrechnung (Settlement Report V2).");
  const kopf = { settlementId: head.settlementId, currency: head.currency, periodFrom: head.periodFrom, periodTo: head.periodTo };
  if (head.currency !== "EUR") {
    const marketplace = head.marketplaces.join(", ") || "unbekannter Marktplatz";
    await versuch(actor, { ...kopf, reportId: report.reportId, ergebnis: "fremdwaehrung", marketplace });
    ergebnis.fremdwaehrung.push({ marketplace, currency: head.currency });
    return;
  }
  if (head.marketplaces.length !== 1) {
    return fehler(
      head.marketplaces.length === 0
        ? "Die Abrechnung nennt keinen Marktplatz; bitte von Hand in das passende Amazon-Konto importieren."
        : `Die Abrechnung nennt mehrere Marktplätze (${head.marketplaces.join(", ")}); bitte von Hand importieren.`,
      kopf,
    );
  }
  const marketplace = head.marketplaces[0]!;
  const passend = konten.get(marketplace.toLowerCase()) ?? [];
  if (passend.length !== 1) {
    const art = passend.length === 0 ? "kein_konto" : "mehrdeutig";
    await versuch(actor, {
      ...kopf,
      reportId: report.reportId,
      ergebnis: art,
      marketplace,
      meldung: art === "kein_konto" ? "Kein Amazon-Konto für den Marktplatz" : "Mehrere Amazon-Konten für den Marktplatz",
    });
    (art === "kein_konto" ? ergebnis.ohneKonto : ergebnis.mehrdeutig).push(marketplace);
    return;
  }
  const konto = passend[0]!;
  const filename = `amazon-settlement-${head.settlementId}.txt`;
  try {
    const result = await withActor(actor, async (tx) => {
      // Reiht parallele Abrufe hintereinander (feste Sperre, unabhängig vom Zugang); danach sieht dieser, was der andere abgeschlossen hat
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('haben-amazon-datenabruf', 0))`);
      if (await amazonReportAbgeschlossen(tx, report.reportId)) return null;
      // Ein Konto, eine Quelle (#306): liefert schon ein Dienst über die REST-API in dieses Konto, kein Abruf
      await keineExterneQuelle(tx, [konto.id]);
      return storeStatement(tx, parseStatement(bytes, filename), { filename, sha256: sha256Of(bytes), amazonReportId: report.reportId }, konto.id);
    });
    if (!result) {
      ergebnis.schonAbgerufen++;
      return;
    }
    ergebnis.uebernommen.push({
      marketplace,
      accountName: result.accountName,
      settlementId: head.settlementId,
      added: result.added,
      warnings: result.warnings,
    });
  } catch (error) {
    if (!(error instanceof BankError || error instanceof StatementParseError)) throw error;
    await fehler(error.message, { ...kopf, marketplace });
  }
}
