import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import type { ImportMessage } from "../../components/BankImportMeldungen.tsx";
import { errorMessage } from "../../lib/format.ts";
import { amazonDatenabrufAbbrechenFn, amazonDatenabrufStandFn, amazonDatenabrufStartenFn } from "../../server/functions/amazon.ts";

type Stand = NonNullable<Awaited<ReturnType<typeof amazonDatenabrufStandFn>>>;

const uhrzeit = (iso: string) => new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Statuszeile eines laufenden Abrufs */
export function laufText(s: Stand): string {
  if (s.abbrechenAngefragt) return "Wird nach dem laufenden Report beendet …";
  if (s.phase === "liste") return "Fragt Amazon nach den Abrechnungen …";
  const nr = `Report ${s.nummer} von ${s.gesamt}`;
  if (s.phase === "warten" && s.wartenBis) return `Amazon drosselt die Abrufe: ${nr}, nächster Versuch um ${uhrzeit(s.wartenBis)} Uhr`;
  return s.zuletzt ? `${nr} … · zuletzt: ${s.zuletzt}` : `${nr} …`;
}

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
  onStatus: (text: string | null) => void;
}) {
  const router = useRouter();
  const starten = useServerFn(amazonDatenabrufStartenFn);
  const abfragen = useServerFn(amazonDatenabrufStandFn);
  const abbrechen = useServerFn(amazonDatenabrufAbbrechenFn);
  const [stand, setStand] = useState<Stand | null>(null);
  const laeuft = stand?.laeuft ?? false;

  useEffect(() => {
    void abfragen().then((s) => {
      if (s?.laeuft) setStand(s);
    });
  }, [abfragen]);

  useEffect(() => {
    onStatus(laeuft && stand ? laufText(stand) : null);
  }, [laeuft, stand, onStatus]);

  useEffect(() => () => onStatus(null), [onStatus]);

  useEffect(() => {
    if (!laeuft) return;
    let gestoppt = false;
    const timer = setInterval(async () => {
      const s = await abfragen().catch(() => null);
      if (gestoppt || !s) return;
      setStand(s);
      if (!s.laeuft) {
        onMessages(s.meldungen);
        void router.invalidate();
      }
    }, 2000);
    return () => {
      gestoppt = true;
      clearInterval(timer);
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
        {laeuft ? "Ruft ab …" : "Amazon Datenabruf"}
      </button>
      {laeuft && (
        <button type="button" className="btn" disabled={stand?.abbrechenAngefragt} onClick={() => void abbrechen().then((s) => s && setStand(s))}>
          Abbrechen
        </button>
      )}
    </>
  );
}
