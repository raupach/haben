import { PAYMENT_PROVIDERS } from "@haben/core";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { ImportMessage } from "../../components/BankImportMeldungen.tsx";
import { type Config, type Einstellungen, type PspAnbieter, type PspDaten, standardConfig } from "../../components/ZahlungsdienstleisterFormular.tsx";
import { menueGruppe } from "../../lib/menue-gruppe.ts";
import { bereichAnker, istStore, type PspWeg, wegeVon } from "../../lib/psp-wege.ts";
import { getPspSettings } from "../../server/functions/zahlungsdienstleister.ts";
import bankStyles from "../../styles/bank.css?url";
import { AbrufSchritt, EinstellungenSchritt, type Pruefung, Schrittleiste, useSpeichern, ZugangSchritt } from "./-bank-einrichtung.tsx";
import { DateiSchritt, ErgebnisSchritt, KontoSchritt, type KontoWahl, WegSchritt } from "./-bank-einrichtung-datei.tsx";

/*
 * Geführte Einrichtung eines Zahlungsdienstleisters (#1951, #2008): „Konto verbinden › Zahlungsdienstleister hinzufügen“
 * auf der Bankseite oder der Seite Verbindungen führt hierher, für jeden Anbieter. Hat er mehrere Wege, fragt der erste
 * Schritt danach. Über die API nennt der Adapter (#1729) die Schritte (Stripe und PayPal: Zugang, Name und Zeitraum, erster
 * Abruf); mit Exportdatei sind es Konto, Datei und Ergebnis; ohne Import nur das Konto. Ein Anbieter mit eigenem Bereich
 * führt zu seinem Abschnitt unter Verbindungen. Eingaben bleiben bis zum Speichern im Browser; neu laden beginnt von vorn.
 */

export const Route = createFileRoute("/_app/bank_/verbinden/$anbieter")({
  loader: () => getPspSettings(),
  head: () => ({ meta: [{ title: "Zahlungsdienstleister verbinden · Haben" }], links: [{ rel: "stylesheet", href: bankStyles }] }),
  component: EinrichtungPage,
});

/** Schritte eines Wegs nach der Wahl */
function schritteVon(weg: PspWeg, anbieter: PspAnbieter | undefined): string[] {
  if (weg === "api" && anbieter) return [...anbieter.schritte];
  if (weg === "datei") return ["konto", "datei", "ergebnis"];
  return ["konto"];
}

function EinrichtungPage() {
  const daten = Route.useLoaderData();
  const { anbieter: provider } = Route.useParams();
  const anbieter = daten.anbieter.find((a) => a.provider === provider);
  const name = anbieter?.name ?? PAYMENT_PROVIDERS[provider as keyof typeof PAYMENT_PROVIDERS]?.label;
  const wege = wegeVon(provider, anbieter !== undefined);
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">
            {menueGruppe("/bank/verbindungen")} › <Link to="/bank/verbindungen">Verbindungen</Link>
          </div>
          <h1>
            {name
              ? `${name} ${wege.length === 1 && wege[0] === "konto" && !istStore(provider) ? "hinzufügen" : "verbinden"}`
              : "Zahlungsdienstleister verbinden"}
          </h1>
        </div>
      </div>
      {name ? (
        <Einrichtung key={provider} provider={provider} name={name} anbieter={anbieter} wege={wege} daten={daten} />
      ) : (
        <section className="card">
          <p style={{ margin: 0 }}>
            „{provider}“ kennt Haben nicht. <Link to="/bank/verbindungen">Zu den Verbindungen</Link>
          </p>
        </section>
      )}
    </>
  );
}

function Einrichtung({
  provider,
  name,
  anbieter,
  wege,
  daten,
}: {
  provider: string;
  name: string;
  anbieter: PspAnbieter | undefined;
  wege: PspWeg[];
  daten: PspDaten;
}) {
  const navigate = useNavigate();
  const mitWahl = wege.length > 1;
  const [weg, setWeg] = useState<PspWeg>(wege[0]!);
  const [schritt, setSchritt] = useState(0);
  const schritte = [...(mitWahl ? ["weg"] : []), ...schritteVon(weg, anbieter)];
  const vorher = mitWahl ? 1 : 0;
  const lauf = { schritt: schritt - vorher, vorher, von: schritte.length, setSchritt: (n: number) => setSchritt(n + vorher) };
  return (
    <>
      <Schrittleiste schritte={schritte} aktuell={schritt} />
      {schritte[schritt] === "weg" ? (
        <WegSchritt
          provider={provider}
          name={name}
          wege={wege}
          von={schritte.length}
          onWeiter={(w) => {
            const anker = w === "bereich" ? bereichAnker(provider) : null;
            if (anker) return void navigate({ to: "/bank/verbindungen", hash: anker });
            setWeg(w);
            setSchritt(1);
          }}
        />
      ) : weg === "api" && anbieter ? (
        <ApiWeg anbieter={anbieter} daten={daten} lauf={lauf} />
      ) : (
        <DateiWeg provider={provider} name={name} daten={daten} nurKonto={weg === "konto"} lauf={lauf} zurueckZumWeg={mitWahl ? () => setSchritt(0) : null} />
      )}
    </>
  );
}

/** Stand der Schritte eines Wegs: `schritt` zählt ab dem ersten Schritt des Wegs, `vorher` ist der Schritt „Weg“ */
type Lauf = { schritt: number; vorher: number; von: number; setSchritt: (n: number) => void };

/** Weg über die API: Zugang, Name und Zeitraum, erster Abruf, wie der Adapter sie nennt */
function ApiWeg({ anbieter, daten, lauf }: { anbieter: PspAnbieter; daten: PspDaten; lauf: Lauf }) {
  const [config, setConfig] = useState<Config>(standardConfig(anbieter));
  const [eingabe, setEingabe] = useState<Record<string, string>>({});
  const [pruefung, setPruefung] = useState<Pruefung | null>(null);
  const [gespeichert, setGespeichert] = useState<{ id: string; werte: Einstellungen } | null>(null);
  const speichern = useSpeichern(anbieter, eingabe, config);
  const { schritt, vorher, von, setSchritt } = lauf;
  const art = anbieter.schritte[schritt];
  return (
    <>
      {art === "zugang" && (
        <ZugangSchritt
          anbieter={anbieter}
          von={von}
          vorher={vorher}
          config={config}
          setConfig={setConfig}
          pruefung={pruefung}
          onGeprueft={(p, e) => {
            setPruefung(p);
            setEingabe(e);
          }}
          onWeiter={() => setSchritt(schritt + 1)}
        />
      )}
      {art === "einstellungen" && pruefung && (
        <EinstellungenSchritt
          anbieter={anbieter}
          daten={daten}
          von={von}
          vorher={vorher}
          pruefung={pruefung}
          speichern={speichern}
          onZurueck={() => setSchritt(schritt - 1)}
          onGespeichert={(id, werte) => {
            setGespeichert({ id, werte });
            setSchritt(schritt + 1);
          }}
        />
      )}
      {art === "abruf" && gespeichert && <AbrufSchritt daten={daten} von={von} vorher={vorher} verbindungId={gespeichert.id} werte={gespeichert.werte} />}
    </>
  );
}

/** Weg mit Exportdatei (Konto, Datei, Ergebnis) oder nur ein Konto */
function DateiWeg({
  provider,
  name,
  daten,
  nurKonto,
  lauf,
  zurueckZumWeg,
}: {
  provider: string;
  name: string;
  daten: PspDaten;
  nurKonto: boolean;
  lauf: Lauf;
  zurueckZumWeg: (() => void) | null;
}) {
  const navigate = useNavigate();
  const [wahl, setWahl] = useState<KontoWahl | null>(null);
  const [ergebnis, setErgebnis] = useState<{ kontoId: string; meldungen: ImportMessage[] } | null>(null);
  const { schritt, vorher, von, setSchritt } = lauf;
  const nummer = schritt + vorher + 1;
  if (schritt === 0)
    return (
      <KontoSchritt
        provider={provider}
        name={name}
        daten={daten}
        nummer={nummer}
        von={von}
        nurKonto={nurKonto}
        wahl={wahl}
        onZurueck={zurueckZumWeg}
        onWeiter={(w) => {
          setWahl(w);
          // Ein Store bekommt seinen Zugang unter Verbindungen; sonst geht es zum neuen Konto
          if (nurKonto && w.kontoId && istStore(provider)) void navigate({ to: "/bank/verbindungen", hash: "stores" });
          else if (nurKonto && w.kontoId) void navigate({ to: "/bank", search: { konto: w.kontoId } });
          else setSchritt(1);
        }}
      />
    );
  if (schritt === 1 && wahl)
    return (
      <DateiSchritt
        provider={provider}
        nummer={nummer}
        von={von}
        wahl={wahl}
        onZurueck={() => setSchritt(0)}
        onFertig={(kontoId, meldungen) => {
          setErgebnis({ kontoId, meldungen });
          setSchritt(2);
        }}
      />
    );
  if (schritt === 2 && wahl && ergebnis)
    return (
      <ErgebnisSchritt
        provider={provider}
        nummer={nummer}
        von={von}
        wahl={wahl}
        kontoId={ergebnis.kontoId}
        meldungen={ergebnis.meldungen}
        setMeldungen={(meldungen) => setErgebnis({ ...ergebnis, meldungen })}
      />
    );
  return null;
}
