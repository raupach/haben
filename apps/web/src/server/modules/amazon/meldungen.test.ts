import { describe, expect, it } from "vitest";
import type { AmazonAbrufErgebnis } from "./abruf.ts";
import { abrufMeldungen } from "./meldungen.ts";

const leer: AmazonAbrufErgebnis = {
  uebernommen: [],
  fremdwaehrung: [],
  ohneKonto: [],
  mehrdeutig: [],
  fehler: [],
  schonAbgerufen: 0,
  nichtGeprueft: 0,
  abbruch: null,
};

describe("Meldungen des Amazon-Datenabrufs", () => {
  it("ohne neue Reports", () => {
    expect(abrufMeldungen({ ...leer, schonAbgerufen: 4 })).toEqual([{ tone: "ok", text: "Keine neuen Abrechnungen bei Amazon (4 schon abgerufen)." }]);
    expect(abrufMeldungen(leer)).toEqual([{ tone: "ok", text: "Keine neuen Abrechnungen bei Amazon." }]);
  });

  it("fasst je Marktplatz zusammen und nennt Hinweise, Fremdwährung, fehlende Konten, Fehler und Offenes", () => {
    const meldungen = abrufMeldungen({
      uebernommen: [
        { marketplace: "Amazon.de", accountName: "Amazon DE", settlementId: "S1", added: 20, warnings: [] },
        { marketplace: "Amazon.de", accountName: "Amazon DE", settlementId: "S2", added: 3, warnings: ["Die Summe der Positionen weicht ab."] },
        { marketplace: "Amazon.fr", accountName: "Amazon FR", settlementId: "S3", added: 1, warnings: [] },
      ],
      fremdwaehrung: [{ marketplace: "Amazon.co.uk", currency: "GBP" }],
      ohneKonto: ["Amazon.nl"],
      mehrdeutig: ["Amazon.it"],
      fehler: ["Report R9: kaputt"],
      schonAbgerufen: 0,
      nichtGeprueft: 19,
      abbruch: null,
    });
    expect(meldungen).toEqual([
      { tone: "ok", text: "Amazon DE: 2 Abrechnungen, 23 neue Umsätze · Amazon FR: 1 Abrechnung, 1 neuer Umsatz" },
      { tone: "info", text: "Amazon DE, Abrechnung S2: Die Summe der Positionen weicht ab." },
      { tone: "info", text: "1 Abrechnung in Fremdwährung nicht übernommen (Amazon.co.uk in GBP); Haben übernimmt nur Euro." },
      {
        tone: "info",
        text: "Kein Amazon-Konto für Amazon.nl: 1 Abrechnung nicht übernommen. Lege unter „Konto hinzufügen“ ein Konto an, wenn du sie übernehmen willst; dann holt der nächste Abruf sie.",
      },
      { tone: "danger", text: "Mehrere Amazon-Konten für Amazon.it: 1 Abrechnung nicht übernommen; bitte von Hand in das richtige Konto importieren." },
      { tone: "danger", text: "Report R9: kaputt" },
      { tone: "info", text: "19 Reports noch nicht geprüft." },
    ]);
  });

  it("nennt bei Abbruch und Zeitlimit den Grund des Offenen", () => {
    expect(abrufMeldungen({ ...leer, nichtGeprueft: 1, abbruch: "abgebrochen" })).toEqual([
      { tone: "info", text: "Abruf abgebrochen: 1 Report noch nicht geprüft. Erneut „Amazon Datenabruf“ macht dort weiter." },
    ]);
    expect(abrufMeldungen({ ...leer, nichtGeprueft: 3, abbruch: "zeitlimit" })).toEqual([
      { tone: "info", text: "Abruf nach 30 Minuten beendet: 3 Reports noch nicht geprüft. Erneut „Amazon Datenabruf“ macht dort weiter." },
    ]);
  });
});
