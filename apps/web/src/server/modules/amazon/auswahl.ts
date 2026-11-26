import type { AmazonSettlementReportInfo } from "@haben/import";

/*
 * Auswahl vor dem Download (#1947): Amazon erlaubt nur etwa 15 Downloads am Stück, danach einen je Minute. Reports, deren
 * Ausgang schon feststeht, werden deshalb nicht noch einmal geladen und verdrängen keine neuen.
 */

export interface LetzterVersuch {
  ergebnis: "kein_konto" | "mehrdeutig" | "fehler";
  marketplace: string | null;
  settlementId: string | null;
}

export interface Auswahl {
  /** Zuerst nie versuchte, dann Reports mit früherem Fehler; je ältester zuerst */
  zuLaden: AmazonSettlementReportInfo[];
  schonAbgerufen: number;
  ohneKonto: string[];
  mehrdeutig: string[];
}

export function waehleReports(
  reports: AmazonSettlementReportInfo[],
  abgeschlossen: Set<string>,
  offen: Map<string, LetzterVersuch>,
  uebernommeneSettlements: Set<string>,
  kontenJeMarktplatz: (marketplace: string) => number,
): Auswahl {
  const auswahl: Auswahl = { zuLaden: [], schonAbgerufen: 0, ohneKonto: [], mehrdeutig: [] };
  const neu: AmazonSettlementReportInfo[] = [];
  const mitFehler: AmazonSettlementReportInfo[] = [];
  for (const report of reports) {
    if (abgeschlossen.has(report.reportId)) {
      auswahl.schonAbgerufen++;
      continue;
    }
    const letzter = offen.get(report.reportId);
    if (!letzter) {
      neu.push(report);
      continue;
    }
    if (letzter.settlementId && uebernommeneSettlements.has(letzter.settlementId)) {
      auswahl.schonAbgerufen++;
      continue;
    }
    const konten = letzter.marketplace ? kontenJeMarktplatz(letzter.marketplace) : null;
    if (letzter.ergebnis === "kein_konto" && letzter.marketplace && konten === 0) {
      auswahl.ohneKonto.push(letzter.marketplace);
      continue;
    }
    if (letzter.ergebnis === "mehrdeutig" && letzter.marketplace && konten !== null && konten > 1) {
      auswahl.mehrdeutig.push(letzter.marketplace);
      continue;
    }
    (letzter.ergebnis === "fehler" ? mitFehler : neu).push(report);
  }
  const nachZeit = (a: AmazonSettlementReportInfo, b: AmazonSettlementReportInfo) => a.createdTime.localeCompare(b.createdTime);
  auswahl.zuLaden = [...neu.sort(nachZeit), ...mitFehler.sort(nachZeit)];
  return auswahl;
}
