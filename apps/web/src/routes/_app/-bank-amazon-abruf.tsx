import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import type { ImportMessage } from "../../components/BankImportMeldungen.tsx";
import { restMinuten } from "../../lib/amazon-restzeit.ts";
import { errorMessage } from "../../lib/format.ts";
import { amazonDatenabrufAbbrechenFn, amazonDatenabrufStandFn, amazonDatenabrufStartenFn } from "../../server/functions/amazon.ts";

type Stand = NonNullable<Awaited<ReturnType<typeof amazonDatenabrufStandFn>>>;

const uhrzeit = (iso: string) => new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Statuszeile eines laufenden Abrufs: die Phase für die Live-Region, „zuletzt“ daneben */
export function laufText(s: Stand, jetzt = Date.now()): { phase: string; zuletzt: string | null } {
  if (s.abbrechenAngefragt) return { phase: "Wird nach dem laufenden Report beendet …", zuletzt: null };
  if (s.phase === "liste") return { phase: "Fragt Amazon nach den Abrechnungen …", zuletzt: null };
  const nr = `Report ${s.nummer} von ${s.gesamt}`;
  if (s.phase === "warten" && s.wartenBis) {
    const min = restMinuten({ nummer: s.nummer, gesamt: s.gesamt, wartenBis: s.wartenBis }, jetzt);
    return {
      phase: `Amazon drosselt die Abrufe: ${nr}, nächster Versuch um ${uhrzeit(s.wartenBis)} Uhr · noch etwa ${min === 1 ? "1 Minute" : `${min} Minuten`}`,
      zuletzt: null,
    };
  }
  return { phase: `${nr} …`, zuletzt: s.zuletzt };
}

export type LaufText = ReturnType<typeof laufText>;

const NICHT_VERFUEGBAR =
  "Der Stand des Abrufs ist nicht mehr verfügbar, etwa nach einem Neustart des Servers. Erneut „Amazon Datenabruf“ macht dort weiter, wo er war.";
const NICHT_ABFRAGBAR = "Der Stand des Abrufs lässt sich nicht abfragen. Lade die Seite neu; erneut „Amazon Datenabruf“ macht dort weiter, wo er war.";

/**
 * „Amazon Datenabruf“ (#1947): startet den Abruf im Hintergrund und zeigt seinen Fortschritt; der Stand wird alle 2 s
 * abgefragt, auch nach Neuladen der Seite. Die Statuszeile zeigt die Bankseite unter den Knöpfen (`onStatus`), am Ende
 * stehen die Meldungen wie die des Dateiimports darunter.
 */
export function AmazonDatenabrufKnopf({
  disabled,
  onMessages,
  onStatus,
}: {
  disabled: boolean;
  onMessages: (messages: ImportMessage[]) => void;
  onStatus: (text: LaufText | null) => void;
}) {
  const router = useRouter();
  const starten = useServerFn(amazonDatenabrufStartenFn);
  const abfragen = useServerFn(amazonDatenabrufStandFn);
  const abbrechen = useServerFn(amazonDatenabrufAbbrechenFn);
  const [stand, setStand] = useState<Stand | null>(null);
  const laeuft = stand?.laeuft ?? false;

  useEffect(() => {
    void abfragen()
      .then((s) => {
        if (s?.laeuft) setStand(s);
      })
      .catch(() => {});
  }, [abfragen]);

  useEffect(() => {
    onStatus(laeuft && stand ? laufText(stand) : null);
  }, [laeuft, stand, onStatus]);

  useEffect(() => () => onStatus(null), [onStatus]);

  useEffect(() => {
    if (!laeuft) return;
    let gestoppt = false;
    let timer: ReturnType<typeof setTimeout>;
    let fehlversuche = 0;
    const beenden = (message: ImportMessage) => {
      setStand(null);
      onMessages([message]);
    };
    const abfrage = async () => {
      let s: Awaited<ReturnType<typeof abfragen>> | undefined;
      try {
        s = await abfragen();
        fehlversuche = 0;
      } catch {
        fehlversuche++;
      }
      if (gestoppt) return;
      if (s === undefined) {
        if (fehlversuche >= 3) return beenden({ tone: "danger", text: NICHT_ABFRAGBAR });
      } else if (!s) {
        return beenden({ tone: "info", text: NICHT_VERFUEGBAR });
      } else {
        setStand(s);
        if (!s.laeuft) {
          onMessages(s.meldungen);
          void router.invalidate();
          return;
        }
      }
      timer = setTimeout(() => void abfrage(), 2000);
    };
    timer = setTimeout(() => void abfrage(), 2000);
    return () => {
      gestoppt = true;
      clearTimeout(timer);
    };
  }, [laeuft, abfragen, onMessages, router]);

  async function onStart() {
    onMessages([]);
    try {
      setStand(await starten());
    } catch (error) {
      onMessages([{ tone: "danger", text: errorMessage(error) }]);
    }
  }

  return (
    <>
      <button type="button" className="btn" disabled={disabled || laeuft} onClick={() => void onStart()}>
        {laeuft ? "Amazon Datenabruf läuft …" : "Amazon Datenabruf"}
      </button>
      {laeuft && (
        <button
          type="button"
          className="btn"
          disabled={stand?.abbrechenAngefragt}
          onClick={() =>
            void abbrechen()
              .then((s) => s && setStand(s))
              .catch((e) => onMessages([{ tone: "danger", text: errorMessage(e) }]))
          }
        >
          Abbrechen
        </button>
      )}
    </>
  );
}
