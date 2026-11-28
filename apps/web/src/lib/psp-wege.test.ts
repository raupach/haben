import { PAYMENT_PROVIDERS } from "@haben/core";
import { describe, expect, it } from "vitest";
import { DATEI_WEGE, bereichAnker, istStore, wegHinweis, wegLabel, wegText, wegeVon } from "./psp-wege.ts";

describe("Wege eines Zahlungsdienstleisters (#2008)", () => {
  it("API zuerst, dann eigener Bereich, dann Datei; Amazon ohne Adapter mit Datei und SP-API; sonst nur das Konto", () => {
    expect(wegeVon("stripe", true)).toEqual(["api", "datei"]);
    expect(wegeVon("etsy", false)).toEqual(["bereich", "datei"]);
    expect(wegeVon("amazon", false)).toEqual(["datei", "api"]);
    expect(wegeVon("googleplay", false)).toEqual(["konto"]);
    expect(wegeVon("sumup", false)).toEqual(["konto"]);
    expect(wegeVon("sonstige", false)).toEqual(["konto"]);
  });

  it("nur Etsy hat einen Abschnitt unter Verbindungen; die Stores brauchen erst ein Konto", () => {
    expect(bereichAnker("etsy")).toBe("etsy");
    expect(bereichAnker("amazon")).toBeNull();
    expect(bereichAnker("appstore")).toBeNull();
    expect(istStore("appstore")).toBe(true);
    expect(istStore("amazon")).toBe(false);
  });

  it("Amazon fragt nach dem Weg, nennt die SP-API beim Namen und legt das Konto zuerst an (#1947)", () => {
    expect(wegText("amazon", ["datei", "api"], null)).toBe("Settlement Report (Flatfile V2) als Datei oder Abruf über die SP-API");
    expect(wegLabel("api", "amazon")).toBe("Über die SP-API");
    expect(wegLabel("api", "stripe")).toBe("Über die API");
    expect(wegHinweis("api", "amazon", "Amazon")).toMatch(/Selling Partner API.*Konto.*Verbindungen/);
  });

  it("der Weg „bereich“ nennt den Anbieter beim Namen, Etsy Payments heißt dort Etsy", () => {
    expect(wegText("etsy", ["bereich"], null)).toBe("Abruf über Etsy unter Verbindungen");
    expect(wegHinweis("bereich", "etsy", "Etsy Payments")).toBe(
      "Haben ruft Etsy Payments über die Verbindung unter Geld › Verbindungen ab und legt das Konto dabei selbst an.",
    );
  });

  it("jede Anleitung gehört zu einem bekannten Anbieter, mit Link über https und mindestens einem Schritt", () => {
    for (const [provider, weg] of Object.entries(DATEI_WEGE)) {
      expect(Object.keys(PAYMENT_PROVIDERS)).toContain(provider);
      expect(weg.link.url).toMatch(/^https:\/\//);
      expect(weg.anleitung.length).toBeGreaterThan(0);
    }
  });
});
