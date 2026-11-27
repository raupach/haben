import { AMAZON_MARKETPLACES } from "@haben/core";
import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { type FormEvent, useId, useState } from "react";
import { type ImportMessage, ImportMeldungen } from "../../components/BankImportMeldungen.tsx";
import { DateiAnleitung } from "../../components/DateiAnleitung.tsx";
import { Field } from "../../components/Field.tsx";
import { UploadButton } from "../../components/UploadButton.tsx";
import type { PspDaten } from "../../components/ZahlungsdienstleisterFormular.tsx";
import { errorMessage } from "../../lib/format.ts";
import { bereichHinweis, dateiWeg, istStore, type PspWeg } from "../../lib/psp-wege.ts";
import { addProviderAccount, importStatements } from "../../server/functions/bank.ts";
import { hatMarktplatzKonto } from "./-bank-daten.ts";
import { SchrittKarte } from "./-bank-einrichtung.tsx";
import { importErgebnisse } from "./-bank-konto.tsx";
import { MarktplatzRueckfrage } from "./-bank-konto-neu.tsx";
import { type KontoWahl, kontoWaehlen, vorhandeneKonten } from "./-bank-einrichtung-konto.ts";

export type { KontoWahl };

/*
 * Einrichtung eines Zahlungsdienstleisters mit Exportdatei oder nur als Konto (#2008): Weg wählen (wenn es mehrere gibt),
 * Konto, Datei mit der Anleitung des Formats, Ergebnis. Den Rahmen und die Schrittleiste stellt die Route
 * (bank_.verbinden.$anbieter.tsx); den Weg über die API die Schritte in -bank-einrichtung.tsx.
 */

const WEG_LABEL: Record<PspWeg, string> = {
  api: "Über die API",
  datei: "Mit Exportdatei",
  bereich: "Unter Verbindungen",
  konto: "Nur Konto",
};

/** Was ein Weg tut, unter seinem Namen */
function wegHinweis(weg: PspWeg, provider: string, name: string): string {
  if (weg === "api") return `Haben holt neue Umsätze selbst, täglich oder stündlich. Du brauchst einen Zugang mit Leserecht bei ${name}.`;
  if (weg === "datei")
    return `Du lädst den Export (${dateiWeg(provider)?.datei}) bei ${name} herunter und importierst ihn. Gut für Zeiträume vor dem ersten Abruf.`;
  if (weg === "bereich") return bereichHinweis(provider, name);
  return "Ein Konto mit eigenem Verrechnungskonto; die Umsätze erfasst du per Hand.";
}

/** Schritt „Weg“: über die API, mit Datei oder unter Verbindungen */
export function WegSchritt({
  provider,
  name,
  wege,
  von,
  onWeiter,
}: {
  provider: string;
  name: string;
  wege: readonly PspWeg[];
  von: number;
  onWeiter: (weg: PspWeg) => void;
}) {
  const id = useId();
  const [weg, setWeg] = useState<PspWeg>(wege[0]!);
  return (
    <SchrittKarte nummer={1} von={von} titel="Wie sollen die Umsätze kommen?">
      <form
        className="stack"
        aria-label="Weg"
        onSubmit={(e) => {
          e.preventDefault();
          onWeiter(weg);
        }}
      >
        <fieldset className="choice-group verbinden-wahl">
          <legend className="visually-hidden">Weg</legend>
          {wege.map((w, i) => (
            <div key={w} className="checkbox-hinted">
              <label className="checkbox">
                <input type="radio" name={id} value={w} checked={weg === w} onChange={() => setWeg(w)} aria-describedby={`${id}-${w}`} />
                <span>
                  {WEG_LABEL[w]}
                  {i === 0 && wege.length > 1 && w === "api" ? " (empfohlen)" : ""}
                </span>
              </label>
              <span id={`${id}-${w}`} className="field-hint">
                {wegHinweis(w, provider, name)}
              </span>
            </div>
          ))}
        </fieldset>
        {wege.includes("api") && wege.includes("datei") && (
          <p className="small muted" style={{ margin: 0 }}>
            Beides geht nacheinander: die Datei für die Zeit davor, den Abruf ab dem Tag nach dem letzten Tag der Datei. Überschneiden sich beide, kann eine
            Zahlung doppelt ankommen.
          </p>
        )}
        <div className="actions" style={{ justifyContent: "flex-start" }}>
          <Link to="/bank/verbindungen" className="btn">
            Abbrechen
          </Link>
          <button type="submit" className="btn btn-primary">
            Weiter
          </button>
        </div>
      </form>
    </SchrittKarte>
  );
}

/**
 * Schritt „Konto“: Marktplatz (Amazon), Name und Konto in Haben. Mit Datei geht es weiter, ohne legt „Konto anlegen“ es an.
 * Für einen Marktplatz, für den es schon ein Konto gibt, fragt es vorher nach (wie „Konto hinzufügen“).
 */
export function KontoSchritt({
  provider,
  name,
  daten,
  nummer,
  von,
  nurKonto,
  wahl,
  onZurueck,
  onWeiter,
}: {
  provider: string;
  name: string;
  daten: Pick<PspDaten, "alleKonten" | "verbindungen" | "abgerufeneKonten">;
  nummer: number;
  von: number;
  /** Ohne Datei: der Schritt legt das Konto an und führt zu ihm */
  nurKonto: boolean;
  wahl: KontoWahl | null;
  onZurueck: (() => void) | null;
  onWeiter: (wahl: KontoWahl) => void;
}) {
  const vorhanden = vorhandeneKonten(daten, provider);
  const [werte, setWerte] = useState<KontoWahl>(wahl ?? { name, marketplace: "", kontoId: null });
  const [rueckfrage, setRueckfrage] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const anlegen = useKontoAnlegen(provider);
  const neu = werte.kontoId === null;

  async function weiter() {
    if (!nurKonto) return onWeiter(werte);
    setBusy(true);
    setFehler(null);
    try {
      onWeiter({ ...werte, kontoId: await anlegen(werte) });
    } catch (error) {
      setFehler(errorMessage(error));
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (neu && !werte.name.trim()) return setFehler("Gib dem Konto einen Namen.");
    if (neu && provider === "amazon" && !werte.marketplace) return setFehler("Wähle den Marktplatz.");
    if (neu && hatMarktplatzKonto(daten.alleKonten, provider, werte.marketplace)) return setRueckfrage(true);
    void weiter();
  }

  return (
    <SchrittKarte nummer={nummer} von={von} titel="Konto">
      <form className="stack" aria-label="Konto" onSubmit={onSubmit} noValidate>
        {nurKonto && (
          <div className="banner banner-info">
            {istStore(provider)
              ? `Haben holt die Finanzberichte von ${name} über den Zugang unter Geld › Verbindungen und schreibt sie in dieses Konto. Danach geht es dorthin.`
              : `Für ${name} liest Haben keine Datei und ruft nichts ab. Das Konto bekommt sein Verrechnungskonto; die Umsätze erfasst du per Hand, und Auszahlungen findet der Bankabgleich als Geldtransit.`}
          </div>
        )}
        {vorhanden.length > 0 && (!nurKonto || istStore(provider)) && (
          <Field label="Konto in Haben" hint="Hast du schon ein Konto für diesen Anbieter, nimmt Haben es.">
            {(control) => (
              <select {...control} value={werte.kontoId ?? ""} onChange={(e) => setWerte(kontoWaehlen(werte, vorhanden, e.target.value, name))}>
                <option value="">Neues Konto anlegen</option>
                {vorhanden.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                    {k.marketplace ? ` (${k.marketplace})` : ""}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        {neu && provider === "amazon" && (
          <Field label="Marktplatz" hint="Ein Amazon-Konto gehört zu genau einem Marktplatz; Haben lehnt Abrechnungen eines anderen ab.">
            {(control) => (
              <select
                {...control}
                value={werte.marketplace}
                onChange={(e) => setWerte({ ...werte, marketplace: e.target.value, name: werte.name === name || !werte.name ? e.target.value : werte.name })}
              >
                <option value="" disabled>
                  Marktplatz wählen
                </option>
                {AMAZON_MARKETPLACES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        {neu && (
          <Field label="Name" hint="So heißt das Konto in Haben. Es bekommt ein eigenes Verrechnungskonto (SKR03 1361 …, SKR04 1461 …).">
            {(control) => <input {...control} value={werte.name} onChange={(e) => setWerte({ ...werte, name: e.target.value })} />}
          </Field>
        )}
        {fehler && (
          <div className="banner banner-danger" role="alert">
            {fehler}
          </div>
        )}
        <div className="actions" style={{ justifyContent: "flex-start" }}>
          {onZurueck ? (
            <button type="button" className="btn" onClick={onZurueck} disabled={busy}>
              Zurück
            </button>
          ) : (
            <Link to="/bank/verbindungen" className="btn">
              Abbrechen
            </Link>
          )}
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {nurKonto && neu ? "Konto anlegen" : "Weiter"}
          </button>
        </div>
      </form>
      <MarktplatzRueckfrage
        marketplace={rueckfrage ? werte.marketplace : undefined}
        onConfirm={() => {
          setRueckfrage(false);
          void weiter();
        }}
        onClose={() => setRueckfrage(false)}
      />
    </SchrittKarte>
  );
}

/** Legt das Konto aus der Wahl an; ein gewähltes bestehendes bleibt */
function useKontoAnlegen(provider: string) {
  const add = useServerFn(addProviderAccount);
  return async (wahl: KontoWahl): Promise<string> => {
    if (wahl.kontoId) return wahl.kontoId;
    const { id } = await add({
      data: { name: wahl.name.trim(), provider: provider as "amazon", marketplace: provider === "amazon" ? wahl.marketplace : undefined },
    });
    return id;
  };
}

/** Importiert Dateien in ein Konto und gibt die Meldungen je Datei zurück */
export function useDateienImportieren() {
  const router = useRouter();
  const importFiles = useServerFn(importStatements);
  return async (files: File[], accountId: string): Promise<ImportMessage[]> => {
    const form = new FormData();
    for (const file of files) form.append("files", file);
    form.append("accountId", accountId);
    try {
      return importErgebnisse(await importFiles({ data: form }), files);
    } catch (error) {
      return [{ tone: "danger", text: errorMessage(error) }];
    } finally {
      await router.invalidate();
    }
  };
}

/** Schritt „Datei“: Anleitung des Formats, Dateien wählen; legt das Konto erst hier an, auch ohne Datei („Nur Konto anlegen“) */
export function DateiSchritt({
  provider,
  nummer,
  von,
  wahl,
  onZurueck,
  onFertig,
}: {
  provider: string;
  nummer: number;
  von: number;
  wahl: KontoWahl;
  onZurueck: () => void;
  onFertig: (kontoId: string, meldungen: ImportMessage[]) => void;
}) {
  const weg = dateiWeg(provider)!;
  const anlegen = useKontoAnlegen(provider);
  const importieren = useDateienImportieren();
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  async function los(files: File[]) {
    setBusy(true);
    setFehler(null);
    try {
      const kontoId = await anlegen(wahl);
      onFertig(kontoId, files.length > 0 ? await importieren(files, kontoId) : []);
    } catch (error) {
      setFehler(errorMessage(error));
      setBusy(false);
    }
  }

  return (
    <SchrittKarte nummer={nummer} von={von} titel={`${weg.datei} importieren`}>
      <div className="einrichtung-datei">
        <div className="stack" style={{ gap: 8 }}>
          <strong>So bekommst du die Datei</strong>
          <DateiAnleitung weg={weg} />
        </div>
        <div className="einrichtung-datei-wahl">
          <UploadButton
            multiple
            accept={weg.accept}
            disabled={busy}
            className="btn btn-primary"
            inputLabel={`${weg.datei} für ${wahl.name}`}
            onFiles={(f) => los(f)}
          >
            {busy ? "Importiere …" : "Dateien wählen und importieren"}
          </UploadButton>
          <span className="small muted">Mehrere Dateien auf einmal gehen.</span>
        </div>
      </div>
      {fehler && (
        <div className="banner banner-danger" role="alert">
          {fehler}
        </div>
      )}
      <div className="actions" style={{ justifyContent: "flex-start" }}>
        <button type="button" className="btn" onClick={onZurueck} disabled={busy}>
          Zurück
        </button>
        <button type="button" className="link-button" style={{ marginLeft: "auto" }} onClick={() => void los([])} disabled={busy}>
          Nur Konto anlegen, Datei später
        </button>
      </div>
    </SchrittKarte>
  );
}

/** Schritt „Ergebnis“: Meldungen je Datei, wo es weitergeht, weitere Dateien, zum Konto */
export function ErgebnisSchritt({
  provider,
  nummer,
  von,
  wahl,
  kontoId,
  meldungen,
  setMeldungen,
}: {
  provider: string;
  nummer: number;
  von: number;
  wahl: KontoWahl;
  kontoId: string;
  meldungen: ImportMessage[];
  setMeldungen: (m: ImportMessage[]) => void;
}) {
  const weg = dateiWeg(provider)!;
  const importieren = useDateienImportieren();
  const [busy, setBusy] = useState(false);
  return (
    <SchrittKarte nummer={nummer} von={von} titel="Ergebnis">
      <p style={{ margin: 0 }}>{wahl.kontoId ? `Konto „${wahl.name}“` : `Konto „${wahl.name}“ angelegt`}.</p>
      {meldungen.length === 0 ? (
        <p className="small muted" style={{ margin: 0 }}>
          Noch keine Datei importiert.
        </p>
      ) : (
        <ImportMeldungen messages={meldungen} accounts={[]} accountId={kontoId} onImported={() => undefined} />
      )}
      <div className="banner banner-info">
        <span>
          Neue Dateien importierst du unter <strong>Geld › Verbindungen</strong> an der Zeile des Kontos oder auf der Bankseite über{" "}
          <strong>⋯ › Datei importieren</strong> seiner Karte.
        </span>
      </div>
      <div className="actions" style={{ justifyContent: "flex-start" }}>
        <UploadButton
          multiple
          accept={weg.accept}
          disabled={busy}
          inputLabel={`Weitere Dateien für ${wahl.name}`}
          onFiles={async (files) => {
            setBusy(true);
            setMeldungen(await importieren(files, kontoId));
            setBusy(false);
          }}
        >
          {busy ? "Importiere …" : "Weitere Datei importieren"}
        </UploadButton>
        <Link to="/bank" search={{ konto: kontoId }} className="btn btn-primary">
          Zum Konto
        </Link>
      </div>
    </SchrittKarte>
  );
}
