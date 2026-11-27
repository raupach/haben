import { describe, expect, it, vi } from "vitest";
import { anbieterWahl, bankWege } from "./-bank-verbinden.tsx";

// Die Server-Funktionen brauchen die Umgebung der App; geprüft werden hier nur die Wege und ihre Gründe
vi.mock("../../server/functions/fints.ts", () => ({ cancelFints: {}, connectFints: {}, continueFints: {}, disconnectFints: {}, syncFints: {} }));
vi.mock("@tanstack/react-router", () => ({ Link: () => null, useNavigate: () => () => {}, useRouter: () => ({ invalidate: async () => {} }) }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: () => async () => ({}) }));

type Daten = Parameters<typeof bankWege>[0];
const fints = { id: "a", bankName: "Testbank", status: "aktiv", accounts: [{ iban: "DE02120300000000202051", name: "Girokonto" }] };
const daten = (sync: boolean, fintsEingerichtet: boolean) =>
  ({ sync: { configured: sync }, fints: { configured: fintsEingerichtet, connections: [fints] } }) as unknown as Daten;
const ruhig = { offen: null, busy: null };
const gesperrt = (wege: ReturnType<typeof bankWege>) => Object.fromEntries(wege.map((w) => [w.wert, w.gesperrt !== null]));

describe("„Wie verbinden?“ (#1951)", () => {
  it("drei Wege; die Datei geht immer, Enable Banking und FinTS nur, wenn eingerichtet", () => {
    expect(gesperrt(bankWege(daten(true, true), ruhig))).toEqual({ enablebanking: false, fints: false, datei: false });
    expect(gesperrt(bankWege(daten(false, false), ruhig))).toEqual({ enablebanking: true, fints: true, datei: false });
  });

  it("FinTS wartet wie bisher auf einen offenen Schritt oder Abruf an einer Zeile, mit dem bisherigen Satz (#1647, #1660)", () => {
    const schritt = bankWege(daten(true, true), { offen: { fuer: "a", schritt: {} as never }, busy: null }).find((w) => w.wert === "fints");
    expect(schritt?.gesperrt).toBe("„Über FinTS verbinden“ geht wieder, sobald die Freigabe für Testbank gesendet oder abgebrochen ist.");
    const abruf = bankWege(daten(true, true), { offen: null, busy: "a" }).find((w) => w.wert === "fints");
    expect(abruf?.gesperrt).toBe("„Über FinTS verbinden“ geht wieder, sobald der Abruf für Testbank fertig ist.");
  });
});

describe("„Zahlungsdienstleister hinzufügen“ (#1951, #2008)", () => {
  const stripe = {
    provider: "stripe",
    name: "Stripe",
    felder: [{ name: "apiKey", label: "API-Schlüssel", art: "geheim" }],
    schritte: ["zugang", "einstellungen", "abruf"],
  };
  const wahl = anbieterWahl({
    anbieter: [stripe],
    verbindungen: [{ provider: "stripe", name: "Shop DE", bankAccountId: "k1" }],
    alleKonten: [
      { id: "k1", provider: "stripe", name: "Shop DE" },
      { id: "k2", provider: "amazon", name: "Amazon.de" },
    ],
  } as unknown as Parameters<typeof anbieterWahl>[0]);
  const zu = (wert: string) => wahl.find((w) => w.wert === wert);

  it("Anbieter mit Adapter zuerst, mit Weg und bestehenden Verbindungen, ohne einen Namen doppelt", () => {
    expect(wahl[0]).toEqual({
      wert: "stripe",
      label: "Stripe",
      hint: "Abruf mit API-Schlüssel oder Saldenverlauf (CSV) als Datei · verbunden: „Shop DE“",
      gesperrt: null,
    });
  });

  it("Konten ohne Verbindung heißen bei Anbietern mit Abruf nicht „verbunden“", () => {
    const [mitDatei] = anbieterWahl({
      anbieter: [stripe],
      verbindungen: [{ provider: "stripe", name: "Shop DE", bankAccountId: "k1" }],
      alleKonten: [
        { id: "k1", provider: "stripe", name: "Stripe Konto" },
        { id: "k2", provider: "stripe", name: "Stripe CSV" },
      ],
    } as unknown as Parameters<typeof anbieterWahl>[0]);
    expect(mitDatei?.hint).toBe("Abruf mit API-Schlüssel oder Saldenverlauf (CSV) als Datei · verbunden: „Shop DE“ · Konto: „Stripe CSV“");
  });

  it("jeder Anbieter ist wählbar, auch „Anderer Zahlungsdienstleister“, mit seinem Weg und Konten ohne Verbindung", () => {
    expect(wahl.every((w) => w.gesperrt === null)).toBe(true);
    expect(wahl.at(-1)?.wert).toBe("sonstige");
    expect(zu("amazon")?.hint).toBe("Settlement Report (Flatfile V2) als Datei · Konto: „Amazon.de“");
    expect(zu("etsy")?.hint).toBe("Abruf über Etsy unter Verbindungen oder Monatsabrechnung (CSV) als Datei · noch kein Konto");
    expect(zu("googleplay")?.hint).toBe("Konto, dann Finanzberichte über die Verbindung unter Verbindungen · noch kein Konto");
    expect(zu("sumup")?.hint).toBe("nur Konto, Umsätze per Hand · noch kein Konto");
  });
});
