import { PAYMENT_PROVIDERS } from "@haben/core";
import { describe, expect, it } from "vitest";
import { bereichHinweis, DATEI_WEGE, bereichAnker, istStore, wegText, wegeVon } from "./psp-wege.ts";

describe("Wege eines Zahlungsdienstleisters (#2008)", () => {
  it("API zuerst, dann eigener Bereich, dann Datei; ohne alles nur das Konto, auch bei den Stores", () => {
    expect(wegeVon("stripe", true)).toEqual(["api", "datei"]);
    expect(wegeVon("etsy", false)).toEqual(["bereich", "datei"]);
    expect(wegeVon("amazon", false)).toEqual(["bereich", "datei"]);
    expect(wegeVon("googleplay", false)).toEqual(["konto"]);
    expect(wegeVon("sumup", false)).toEqual(["konto"]);
    expect(wegeVon("sonstige", false)).toEqual(["konto"]);
  });

  it("Etsy und Amazon haben ihren Abschnitt unter Verbindungen; die Stores brauchen erst ein Konto", () => {
    expect(bereichAnker("etsy")).toBe("etsy");
    expect(bereichAnker("amazon")).toBe("amazon");
    expect(bereichAnker("appstore")).toBeNull();
    expect(istStore("appstore")).toBe(true);
    expect(istStore("amazon")).toBe(false);
  });

  it("Amazon sagt im Weg „bereich“, dass der Zugang unter Verbindungen steht (#1947)", () => {
    expect(bereichHinweis("amazon", "Amazon")).toMatch(/Selling Partner API.*Amazon-Abrechnungen/);
    expect(bereichHinweis("etsy", "Etsy Payments")).toBe(
      "Haben ruft Etsy Payments über die Verbindung unter Geld › Verbindungen ab und legt das Konto dabei selbst an.",
    );
  });

  it("der Weg „bereich“ nennt den Anbieter beim Namen (#1947)", () => {
    expect(wegText("etsy", ["bereich"], null)).toBe("Abruf über Etsy unter Verbindungen");
    expect(wegText("amazon", ["bereich", "datei"], null)).toBe("Abruf über Amazon unter Verbindungen oder Settlement Report (Flatfile V2) als Datei");
  });

  it("jede Anleitung gehört zu einem bekannten Anbieter, mit Link über https und mindestens einem Schritt", () => {
    for (const [provider, weg] of Object.entries(DATEI_WEGE)) {
      expect(Object.keys(PAYMENT_PROVIDERS)).toContain(provider);
      expect(weg.link.url).toMatch(/^https:\/\//);
      expect(weg.anleitung.length).toBeGreaterThan(0);
    }
  });
});
