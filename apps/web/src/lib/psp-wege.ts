import type { PaymentProvider } from "@haben/core";

/*
 * Wege eines Zahlungsdienstleisters zu Haben (#2008): Abruf über die API, Exportdatei, eigener Bereich unter Verbindungen
 * oder nur ein Konto. Die Anleitung je Dateiformat steht hier einmal; Einrichtung und Import-Dialog zeigen sie, die Doku
 * (bank-zahlungsdienstleister.md) beschreibt dieselben Schritte. Ohne Serverfunktionen, damit Tests sie laden können.
 */

export type PspWeg = "api" | "datei" | "bereich" | "konto";

/** Wie man den Export beim Anbieter bekommt */
export type DateiWeg = {
  /** Name der Datei beim Anbieter, etwa „Settlement Report (Flatfile V2)“ */
  datei: string;
  /** Dateiauswahl im Browser */
  accept: string;
  link: { url: string; text: string };
  /** Schritte beim Anbieter, als Sätze; `**…**` steht für Menüpfade und erscheint fett */
  anleitung: readonly string[];
  hinweis?: string;
};

export const DATEI_WEGE: Partial<Record<PaymentProvider, DateiWeg>> = {
  paypal: {
    datei: "Aktivitäten (CSV)",
    accept: ".csv,text/csv",
    link: { url: "https://www.paypal.com/reports/dlog", text: "PayPal: Aktivitäten herunterladen" },
    anleitung: ["Bei PayPal unter **Berichte › Aktivitäten herunterladen** den Zeitraum wählen.", "Als CSV herunterladen und hier ablegen."],
  },
  stripe: {
    datei: "Saldenverlauf (CSV)",
    accept: ".csv,text/csv",
    link: { url: "https://dashboard.stripe.com/reports/balance", text: "Stripe-Dashboard: Berichte" },
    anleitung: [
      "Im Stripe-Dashboard unter **Berichte › Saldo** den Saldenverlauf (Balance history) für den Zeitraum herunterladen.",
      "In den Spalten zusätzlich `customer_name` und `customer_email` wählen; sonst haben Zahlungen ohne Beschreibung keinen Namen.",
    ],
  },
  shopify: {
    datei: "Transaktionen (CSV)",
    accept: ".csv,text/csv",
    link: { url: "https://admin.shopify.com", text: "Shopify-Admin" },
    anleitung: ["Im Shopify-Admin unter **Finanzen › Auszahlungen › Transaktionen** exportieren.", "Die CSV hier ablegen."],
    hinweis: "Nimm auch den Vormonat dazu, wenn eine Auszahlung über die Monatsgrenze reicht.",
  },
  ebay: {
    datei: "Transaktionsbericht (CSV)",
    accept: ".csv,text/csv",
    link: { url: "https://www.ebay.de/sh/fin/reports", text: "eBay: Berichte im Verkäufer-Cockpit Pro" },
    anleitung: ["Im Verkäufer-Cockpit Pro unter **Zahlungen › Berichte** den Transaktionsbericht erstellen und herunterladen.", "Die CSV hier ablegen."],
    hinweis: "eBay hält die Daten nur 90 Tage vor: lade den Bericht mindestens jedes Quartal herunter.",
  },
  etsy: {
    datei: "Monatsabrechnung (CSV)",
    accept: ".csv,text/csv",
    link: { url: "https://www.etsy.com/your/shops/me/dashboard", text: "Etsy: Shop-Manager" },
    anleitung: [
      "Im Shop-Manager unter **Finanzen › Monatliche Abrechnungen** den Monat wählen und die CSV herunterladen.",
      "Je Monat eine Datei hier ablegen.",
    ],
  },
  amazon: {
    datei: "Settlement Report (Flatfile V2)",
    accept: ".txt,.tsv,text/plain,text/tab-separated-values",
    link: { url: "https://sellercentral.amazon.de", text: "Amazon Seller Central" },
    anleitung: [
      "Im Seller Central unter **Berichte › Zahlungen** die Abrechnungen öffnen.",
      "Je Abrechnungszeitraum (rund zwei Wochen) den Settlement Report im Format V2 herunterladen.",
      "Alle Dateien seit Beginn der Buchhaltung hier ablegen; mehrere auf einmal gehen.",
    ],
    hinweis: "Nur EUR-Marktplätze. Weicht die Summe vom Auszahlungsbetrag ab, sagt Haben es nach dem Import.",
  },
};

/** Anbieter mit eigenem Abschnitt unter „Geld › Verbindungen“, mit dessen Anker; Etsy legt sein Konto dort selbst an */
const BEREICH: Partial<Record<PaymentProvider, "etsy">> = { etsy: "etsy" };

export function bereichAnker(provider: string): "etsy" | null {
  return BEREICH[provider as PaymentProvider] ?? null;
}

/** Google Play und App Store: erst das Konto, dann der Zugang im Abschnitt „Stores“ unter Verbindungen, der hineinschreibt */
export function istStore(provider: string): boolean {
  return provider === "googleplay" || provider === "appstore";
}

/**
 * Hinweis am Feld Marktplatz: ein Konto gehört zu einem Marktplatz, und der Abruf über die SP-API (#1947) steht unter
 * Verbindungen, weil er nicht je Konto eingerichtet wird
 */
export function kontoHinweis(): string {
  return "Ein Amazon-Konto gehört zu genau einem Marktplatz; Haben lehnt Abrechnungen eines anderen ab. Den Abruf über die SP-API richtest du unter Geld › Verbindungen in Amazon-Abrechnungen ein.";
}

export function dateiWeg(provider: string): DateiWeg | null {
  return DATEI_WEGE[provider as PaymentProvider] ?? null;
}

/** Die Wege eines Anbieters, der empfohlene zuerst; `mitAdapter`: Haben ruft ihn über die API ab */
export function wegeVon(provider: string, mitAdapter: boolean): PspWeg[] {
  const wege: PspWeg[] = [];
  if (mitAdapter) wege.push("api");
  if (bereichAnker(provider)) wege.push("bereich");
  if (dateiWeg(provider)) wege.push("datei");
  return wege.length > 0 ? wege : ["konto"];
}

/** Zeile unter dem Anbieter in der Auswahl: wie die Umsätze kommen */
export function wegText(provider: string, wege: readonly PspWeg[], zugang: string | null): string {
  const datei = dateiWeg(provider)?.datei;
  const teile = wege.map((w) => {
    if (w === "api") return zugang ? `Abruf mit ${zugang}` : "Abruf über die API";
    if (w === "datei") return `${datei} als Datei`;
    if (w === "bereich") return "Abruf über Etsy unter Verbindungen";
    return istStore(provider) ? "Konto, dann Finanzberichte über die Verbindung unter Verbindungen" : "nur Konto, Umsätze per Hand";
  });
  return teile.join(" oder ");
}
