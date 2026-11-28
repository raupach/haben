import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ActionMenuItem } from "./MoreActionsMenu.tsx";
import type { ImportMessage } from "./BankImportMeldungen.tsx";
import { restMinuten } from "../lib/amazon-restzeit.ts";
import { errorMessage } from "../lib/format.ts";
import { amazonDatenabrufAbbrechenFn, amazonDatenabrufStandFn, amazonDatenabrufStartenFn } from "../server/functions/amazon.ts";

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
 * „Amazon Datenabruf“ (#1947): startet den Abruf im Hintergrund und hält seinen Fortschritt; der Stand wird alle 2 s
 * abgefragt, auch nach Neuladen der Seite. Der Abschnitt Amazon-Abrechnungen, die Zeilen unter Verbindungen und das ⋯ der
 * Amazon-Karte auf der Bankseite nutzen denselben Aufruf; die Meldungen am Ende gehen an `onMessages`.
 */
export function useAmazonAbruf(onMessages: (messages: ImportMessage[]) => void) {
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

  // Läuft der Abruf an anderer Stelle (Abschnitt, Karte, andere Seite), soll ihn auch diese Seite zeigen: alle 5 s fragen,
  // solange hier nichts läuft
  useEffect(() => {
    if (laeuft) return;
    const timer = setInterval(() => {
      void abfragen()
        .then((s) => {
          if (s?.laeuft) setStand(s);
        })
        .catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [laeuft, abfragen]);

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

  const start = useCallback(async () => {
    onMessages([]);
    try {
      setStand(await starten());
    } catch (error) {
      onMessages([{ tone: "danger", text: errorMessage(error) }]);
    }
  }, [starten, onMessages]);

  const abbrechenJetzt = useCallback(async () => {
    try {
      const s = await abbrechen();
      if (s) setStand(s);
    } catch (error) {
      onMessages([{ tone: "danger", text: errorMessage(error) }]);
    }
  }, [abbrechen, onMessages]);

  return { laeuft, stand, abbrechenAngefragt: stand?.abbrechenAngefragt ?? false, start, abbrechen: abbrechenJetzt };
}

export type AmazonAbruf = ReturnType<typeof useAmazonAbruf>;

/** Knopf und Abbrechen; der Aufrufer entscheidet, wo der Fortschritt steht */
export function AmazonDatenabrufKnopf({ abruf, disabled = false }: { abruf: AmazonAbruf; disabled?: boolean }) {
  return (
    <>
      <button type="button" className="btn" disabled={disabled || abruf.laeuft} onClick={() => void abruf.start()}>
        {abruf.laeuft ? "Amazon Datenabruf läuft …" : "Amazon Datenabruf"}
      </button>
      {abruf.laeuft && (
        <button type="button" className="btn" disabled={abruf.abbrechenAngefragt} onClick={() => void abruf.abbrechen()}>
          Abbrechen
        </button>
      )}
    </>
  );
}

/** Menüpunkt „Amazon Datenabruf“ für Zeile und Karte; während des Laufs gesperrt und mit „läuft …“ (#1947) */
export function amazonMenuePunkt(amazon: { starten: () => void; laeuft: boolean }): ActionMenuItem {
  return {
    key: "amazon",
    label: amazon.laeuft ? "Amazon Datenabruf läuft …" : "Amazon Datenabruf",
    disabled: amazon.laeuft,
    onSelect: amazon.starten,
  };
}

/** Fortschritt des Abrufs: die Phase für die Live-Region, „zuletzt“ darunter; null, solange nichts läuft */
export function AmazonAbrufStatus({ abruf, ausrichtung }: { abruf: AmazonAbruf; ausrichtung?: "left" | "right" }): ReactNode {
  if (!abruf.laeuft || !abruf.stand) return null;
  const text = laufText(abruf.stand);
  return (
    <>
      <p className="small muted" role="status" style={{ margin: 0, textAlign: ausrichtung ?? "left" }}>
        {text.phase}
      </p>
      {text.zuletzt && (
        <p className="small muted" style={{ margin: 0, textAlign: ausrichtung ?? "left" }}>
          zuletzt: {text.zuletzt}
        </p>
      )}
    </>
  );
}
