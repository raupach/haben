import type { AmazonAbrufErgebnis } from "./abruf.ts";

export type AbrufMeldung = { tone: "ok" | "info" | "danger"; text: string };

const anzahl = (n: number, eins: string, mehr: string) => `${n} ${n === 1 ? eins : mehr}`;

/** Meldungen für die Seite Bank, in derselben Form wie die des Dateiimports */
export function abrufMeldungen(e: AmazonAbrufErgebnis): AbrufMeldung[] {
  const meldungen: AbrufMeldung[] = [];
  const nichts = e.uebernommen.length + e.fremdwaehrung.length + e.ohneKonto.length + e.mehrdeutig.length + e.fehler.length + e.nichtGeprueft === 0;
  if (nichts) {
    return [{ tone: "ok", text: `Keine neuen Abrechnungen bei Amazon${e.schonAbgerufen ? ` (${e.schonAbgerufen} schon abgerufen)` : ""}.` }];
  }
  const jeKonto = new Map<string, { abrechnungen: number; umsaetze: number }>();
  for (const u of e.uebernommen) {
    const s = jeKonto.get(u.accountName) ?? { abrechnungen: 0, umsaetze: 0 };
    jeKonto.set(u.accountName, { abrechnungen: s.abrechnungen + 1, umsaetze: s.umsaetze + u.added });
  }
  if (jeKonto.size > 0) {
    const teile = [...jeKonto].map(
      ([name, s]) => `${name}: ${anzahl(s.abrechnungen, "Abrechnung", "Abrechnungen")}, ${anzahl(s.umsaetze, "neuer Umsatz", "neue Umsätze")}`,
    );
    meldungen.push({ tone: "ok", text: teile.join(" · ") });
  }
  for (const u of e.uebernommen) for (const w of u.warnings) meldungen.push({ tone: "info", text: `${u.accountName}, Abrechnung ${u.settlementId}: ${w}` });
  if (e.fremdwaehrung.length > 0) {
    const liste = e.fremdwaehrung.map((f) => `${f.marketplace} in ${f.currency}`).join(", ");
    meldungen.push({
      tone: "info",
      text: `${anzahl(e.fremdwaehrung.length, "Abrechnung", "Abrechnungen")} in Fremdwährung nicht übernommen (${liste}); Haben übernimmt nur Euro.`,
    });
  }
  for (const m of new Set(e.ohneKonto)) {
    meldungen.push({ tone: "danger", text: `Kein Amazon-Konto für ${m}: unter „Konto hinzufügen“ anlegen, dann holt der nächste Abruf die Abrechnung.` });
  }
  for (const m of new Set(e.mehrdeutig)) {
    meldungen.push({ tone: "danger", text: `Mehrere Amazon-Konten für ${m}: die Abrechnung bitte von Hand in das richtige Konto importieren.` });
  }
  for (const f of e.fehler) meldungen.push({ tone: "danger", text: f });
  if (e.nichtGeprueft > 0) {
    meldungen.push({
      tone: "info",
      text: `${anzahl(e.nichtGeprueft, "Report", "Reports")} noch nicht geprüft: Amazon erlaubt etwa einen Download je Minute. Später erneut „Amazon Datenabruf“.`,
    });
  }
  return meldungen;
}
