import { reportInternalError, userClientError } from "../../errors.ts";
import { type AbrufFortschritt, type AbrufOptionen, amazonDatenabruf } from "./abruf.ts";
import { type AbrufMeldung, abrufMeldungen } from "./meldungen.ts";

/*
 * Amazon Datenabruf im Hintergrund (#1947): Ein Abruf dauert bei Amazons Drosselung Minuten, länger als eine Anfrage
 * darf. Der Lauf startet ohne Warten auf das Ende; die Seite fragt seinen Stand ab. Höchstens ein Lauf je Prozess, der
 * Stand liegt nur im Speicher: Nach einem Neustart fehlt nur die Anzeige, das Protokoll sichert, dass der nächste Lauf
 * weitermacht.
 */

export interface AmazonLaufStand {
  laeuft: boolean;
  gestartet: string;
  phase: AbrufFortschritt["phase"] | "fertig";
  nummer: number;
  gesamt: number;
  wartenBis: string | null;
  zuletzt: string | null;
  abbrechenAngefragt: boolean;
  meldungen: AbrufMeldung[];
}

let aktuell: { stand: AmazonLaufStand; abbruch: AbortController; ende: Promise<void> } | null = null;

const kopie = (s: AmazonLaufStand): AmazonLaufStand => ({ ...s, meldungen: [...s.meldungen] });

export function amazonLaufStarten(actor: string, optionen: Omit<AbrufOptionen, "fortschritt" | "signal"> = {}): AmazonLaufStand {
  if (aktuell?.stand.laeuft) return kopie(aktuell.stand);
  const abbruch = new AbortController();
  const stand: AmazonLaufStand = {
    laeuft: true,
    gestartet: new Date().toISOString(),
    phase: "liste",
    nummer: 0,
    gesamt: 0,
    wartenBis: null,
    zuletzt: null,
    abbrechenAngefragt: false,
    meldungen: [],
  };
  const ende = amazonDatenabruf(actor, {
    ...optionen,
    signal: abbruch.signal,
    fortschritt: (f) => {
      stand.phase = f.phase;
      if (f.phase === "laden") Object.assign(stand, { nummer: f.nummer, gesamt: f.gesamt, zuletzt: f.zuletzt, wartenBis: null });
      if (f.phase === "warten") Object.assign(stand, { nummer: f.nummer, gesamt: f.gesamt, wartenBis: new Date(f.bis).toISOString() });
    },
  })
    .then((ergebnis) => {
      stand.meldungen = abrufMeldungen(ergebnis);
    })
    .catch((error: unknown) => {
      stand.meldungen = [{ tone: "danger", text: userClientError(error)?.message ?? reportInternalError("Amazon Datenabruf im Hintergrund", error) }];
    })
    .finally(() => {
      Object.assign(stand, { laeuft: false, phase: "fertig", wartenBis: null });
    });
  aktuell = { stand, abbruch, ende };
  return kopie(stand);
}

export function amazonLaufStand(): AmazonLaufStand | null {
  return aktuell ? kopie(aktuell.stand) : null;
}

export function amazonLaufAbbrechen(): void {
  if (!aktuell?.stand.laeuft) return;
  aktuell.stand.abbrechenAngefragt = true;
  aktuell.abbruch.abort();
}

/** Für Tests: wartet, bis der aktuelle Lauf zu Ende ist */
export async function amazonLaufBeendet(): Promise<void> {
  await aktuell?.ende;
}
