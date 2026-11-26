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
 * nennt nur die Datei. Jeder Report ist eine eigene Transaktion: Bricht der Abruf ab (Abbruch, Zeitlimit, Fehler),
 * bleibt Übernommenes, und der nächste Abruf macht weiter. Bei Drosselung (nach etwa 15 Downloads) wartet der Abruf und
 * lädt denselben Report erneut, höchstens 30 Minuten lang. Eine feste Advisory-Sperre reiht parallele
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
  /** Wegen Abbruch, Zeitlimit oder Zugangsfehler nicht mehr geladen */
  nichtGeprueft: number;
  abbruch: "abgebrochen" | "zeitlimit" | null;
}

export type AbrufFortschritt =
  | { phase: "liste" }
  | { phase: "laden"; nummer: number; gesamt: number; zuletzt: string | null }
  | { phase: "warten"; bis: number; nummer: number; gesamt: number };

export interface AbrufOptionen {
  fortschritt?: (f: AbrufFortschritt) => void;
  signal?: AbortSignal;
  jetzt?: () => number;
  warten?: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxDauerMs?: number;
}

/** Wartezeit bei Drosselung ohne Retry-After: getReportDocument erlaubt etwa einen Aufruf je Minute (0,0167/s) */
const STANDARD_WARTEN_MS = 60_000;
/** Retry-After 0 oder ein Datum in der Vergangenheit dürfen keine Wiederholung ohne Pause auslösen */
const MIN_WARTEN_MS = 1_000;
/** Längste einzelne Wartezeit, auch wenn Amazon mehr verlangt */
const MAX_WARTEN_MS = 300_000;
/** Längste Laufzeit eines Abrufs; danach bleiben die übrigen Reports für den nächsten */
export const MAX_DAUER_MS = 30 * 60_000;

/** Wartet, endet aber sofort, wenn der Abruf abgebrochen wird */
function warteBisOderAbbruch(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
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

export async function amazonDatenabruf(actor: string, optionen: AbrufOptionen = {}): Promise<AmazonAbrufErgebnis> {
  const connection = await loadAmazonSpConnection();
  if (!connection) throw new AmazonSpError("Der Amazon-Zugang ist nicht eingerichtet (Einstellungen › Bank).");
  const client = amazonSpClientFor(connection.credentials);
  let reports: AmazonSettlementReportInfo[];
  optionen.fortschritt?.({ phase: "liste" });
  try {
    reports = await client.settlementReports();
  } catch (error) {
    throw new AmazonSpError(amazonFehlertext(error));
  }
  const ergebnis: AmazonAbrufErgebnis = {
    uebernommen: [],
    fremdwaehrung: [],
    ohneKonto: [],
    mehrdeutig: [],
    fehler: [],
    schonAbgerufen: 0,
    nichtGeprueft: 0,
    abbruch: null,
  };
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
  const jetzt = optionen.jetzt ?? Date.now;
  const warten = optionen.warten ?? warteBisOderAbbruch;
  const maxDauer = optionen.maxDauerMs ?? MAX_DAUER_MS;
  const start = jetzt();
  const gesamt = offen.length;
  let zuletzt: string | null = null;
  for (let i = 0; i < gesamt; ) {
    if (optionen.signal?.aborted) {
      ergebnis.abbruch = "abgebrochen";
      ergebnis.nichtGeprueft = gesamt - i;
      break;
    }
    if (jetzt() - start > maxDauer) {
      ergebnis.abbruch = "zeitlimit";
      ergebnis.nichtGeprueft = gesamt - i;
      break;
    }
    const report = offen[i]!;
    optionen.fortschritt?.({ phase: "laden", nummer: i + 1, gesamt, zuletzt });
    let bytes: Uint8Array;
    try {
      bytes = await client.download(report.reportDocumentId);
    } catch (error) {
      if (error instanceof AmazonSpApiError && error.art === "drosselung") {
        const ms = Math.min(Math.max(error.wartenMs ?? STANDARD_WARTEN_MS, MIN_WARTEN_MS), MAX_WARTEN_MS);
        if (jetzt() + ms - start > maxDauer) {
          ergebnis.abbruch = "zeitlimit";
          ergebnis.nichtGeprueft = gesamt - i;
          break;
        }
        optionen.fortschritt?.({ phase: "warten", bis: jetzt() + ms, nummer: i + 1, gesamt });
        await warten(ms, optionen.signal);
        continue;
      }
      if (error instanceof AmazonSpApiError && error.art !== "sonstig") {
        // Zugang oder Rolle: die übrigen Reports scheitern genauso
        ergebnis.nichtGeprueft = gesamt - i;
        ergebnis.fehler.push(error.message);
        break;
      }
      const meldung = amazonFehlertext(error);
      await versuch(actor, { reportId: report.reportId, ergebnis: "fehler", meldung });
      ergebnis.fehler.push(`Report ${report.reportId}: ${meldung}`);
      zuletzt = `Report ${report.reportId}: Fehler`;
      i++;
      continue;
    }
    zuletzt = await verarbeite(actor, report, bytes, konten, ergebnis);
    i++;
  }
  return ergebnis;
}

async function verarbeite(
  actor: string,
  report: AmazonSettlementReportInfo,
  bytes: Uint8Array,
  konten: Map<string, Konto[]>,
  ergebnis: AmazonAbrufErgebnis,
): Promise<string> {
  const fehler = async (meldung: string, kopf: Partial<AmazonVersuch> = {}) => {
    await versuch(actor, { ...kopf, reportId: report.reportId, ergebnis: "fehler", meldung });
    ergebnis.fehler.push(`Report ${report.reportId}: ${meldung}`);
    return `Report ${report.reportId}: Fehler`;
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
    return `${marketplace}: ${head.currency}, nicht übernommen`;
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
    return art === "kein_konto" ? `${marketplace}: kein Konto` : `${marketplace}: mehrere Konten`;
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
      return `Report ${report.reportId}: schon abgerufen`;
    }
    ergebnis.uebernommen.push({
      marketplace,
      accountName: result.accountName,
      settlementId: head.settlementId,
      added: result.added,
      warnings: result.warnings,
    });
    return `${result.accountName}: Abrechnung ${head.settlementId} übernommen (${result.added} neue Umsätze)`;
  } catch (error) {
    if (!(error instanceof BankError || error instanceof StatementParseError)) throw error;
    return fehler(error.message, { ...kopf, marketplace });
  }
}
