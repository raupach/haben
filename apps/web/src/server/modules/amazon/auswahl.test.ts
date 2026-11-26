import { describe, expect, it } from "vitest";
import { type LetzterVersuch, waehleReports } from "./auswahl.ts";

const r = (reportId: string, createdTime: string) => ({ reportId, reportDocumentId: `DOC-${reportId}`, createdTime });
const konten = (m: string) => ({ "Amazon.de": 1, "Amazon.fr": 2 })[m] ?? 0;
const wahl = (reports: ReturnType<typeof r>[], offen: [string, LetzterVersuch][] = [], abgeschlossen: string[] = [], settlements: string[] = []) =>
  waehleReports(reports, new Set(abgeschlossen), new Map(offen), new Set(settlements), konten);
const ids = (reports: { reportId: string }[]) => reports.map((x) => x.reportId);

describe("Auswahl der Amazon-Reports vor dem Download", () => {
  it("lädt zuerst nie versuchte, dann Reports mit Fehler, je ältester zuerst", () => {
    const a = wahl(
      [r("A", "2026-11-01T00:00:00Z"), r("B", "2026-11-02T00:00:00Z"), r("C", "2026-11-03T00:00:00Z"), r("D", "2026-11-04T00:00:00Z")],
      [
        ["A", { ergebnis: "fehler", marketplace: null, settlementId: null }],
        ["C", { ergebnis: "fehler", marketplace: null, settlementId: null }],
      ],
    );
    expect(ids(a.zuLaden)).toEqual(["B", "D", "A", "C"]);
  });

  it("lädt kein_konto nicht, solange es kein Konto gibt, danach wieder", () => {
    const offen: [string, LetzterVersuch][] = [
      ["X", { ergebnis: "kein_konto", marketplace: "Amazon.nl", settlementId: "S1" }],
      ["Y", { ergebnis: "kein_konto", marketplace: "Amazon.de", settlementId: "S2" }],
    ];
    const a = wahl([r("X", "2026-11-01T00:00:00Z"), r("Y", "2026-11-02T00:00:00Z")], offen);
    expect(ids(a.zuLaden)).toEqual(["Y"]);
    expect(a.ohneKonto).toEqual(["Amazon.nl"]);
  });

  it("lädt mehrdeutig nicht, solange es mehr als ein Konto gibt", () => {
    const offen: [string, LetzterVersuch][] = [
      ["X", { ergebnis: "mehrdeutig", marketplace: "Amazon.fr", settlementId: "S1" }],
      ["Y", { ergebnis: "mehrdeutig", marketplace: "Amazon.de", settlementId: "S2" }],
    ];
    const a = wahl([r("X", "2026-11-01T00:00:00Z"), r("Y", "2026-11-02T00:00:00Z")], offen);
    expect(ids(a.zuLaden)).toEqual(["Y"]);
    expect(a.mehrdeutig).toEqual(["Amazon.fr"]);
  });

  it("zählt abgeschlossene und von Hand übernommene Settlements als schon abgerufen", () => {
    const offen: [string, LetzterVersuch][] = [["X", { ergebnis: "mehrdeutig", marketplace: "Amazon.fr", settlementId: "S-HAND" }]];
    const a = wahl([r("X", "2026-11-01T00:00:00Z"), r("Z", "2026-11-02T00:00:00Z")], offen, ["Z"], ["S-HAND"]);
    expect(a).toEqual({ zuLaden: [], schonAbgerufen: 2, ohneKonto: [], mehrdeutig: [] });
  });
});
