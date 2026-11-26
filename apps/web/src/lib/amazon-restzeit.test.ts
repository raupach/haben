import { describe, expect, it } from "vitest";
import { restMinuten } from "./amazon-restzeit.ts";

const JETZT = Date.parse("2026-11-26T10:00:00Z");

describe("restMinuten", () => {
  it("rechnet je übrigem Report etwa eine Minute", () => {
    expect(restMinuten({ nummer: 1, gesamt: 4, wartenBis: new Date(JETZT + 40_000).toISOString() }, JETZT)).toBe(4);
  });
  it("nennt beim letzten Report mindestens eine Minute", () => {
    expect(restMinuten({ nummer: 3, gesamt: 3, wartenBis: new Date(JETZT + 10_000).toISOString() }, JETZT)).toBe(1);
  });
});
