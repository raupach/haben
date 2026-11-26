import { readFileSync } from "node:fs";
import { gzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { AMAZON_SETTLEMENT_REPORT_TYPE, AmazonSpApiError, AmazonSpClient, type AmazonSpClientOptions } from "./client.ts";

/*
 * Nachgebaute SP-API: Anmeldung bei LWA, getReports (Seiten über nextToken), getReportDocument und die vorsignierte
 * URL. Kennungen und Werte sind erfunden. Wie am echten Konto nennt jeder Report alle Marktplätze in marketplaceIds.
 */

const ID = "amzn1.application-oa2-client.beispiel1234";
const SECRET = "amzn1.oa2-cs.v1.geheimeswert5678";
const TOKEN = "Atzr|IwEBIbeispielrefreshtoken9012";
const NOW = Date.parse("2026-11-25T10:00:00Z");
const TOKEN_URL = "https://lwa.example/auth/o2/token";

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | undefined;
}
type Bericht = { reportId: string; doc: string; created: string };
type Datei = { bytes: Uint8Array<ArrayBuffer>; gzip?: boolean };

function api(o: { seiten?: Bericht[][]; dateien?: Record<string, Datei>; respond?: (call: Call) => Response | undefined } = {}) {
  const calls: Call[] = [];
  const seiten = o.seiten ?? [[{ reportId: "R1", doc: "D1", created: "2026-11-17T21:16:17+00:00" }]];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? String(init.body) : undefined,
    };
    calls.push(call);
    const custom = o.respond?.(call);
    if (custom) return custom;
    if (url.href === TOKEN_URL) return Response.json({ access_token: "Atza|zugang", token_type: "bearer", expires_in: 3600, refresh_token: TOKEN });
    if (url.pathname === "/reports/2021-06-30/reports") {
      const index = Number(url.searchParams.get("nextToken") ?? 0);
      const reports = seiten[index]!.map((r) => ({
        reportType: AMAZON_SETTLEMENT_REPORT_TYPE,
        processingStatus: "DONE",
        marketplaceIds: ["A1PA6795UKMFR9", "A13V1IB3VIYZZH"],
        reportId: r.reportId,
        reportDocumentId: r.doc,
        createdTime: r.created,
      }));
      return Response.json({ reports, ...(index + 1 < seiten.length ? { nextToken: String(index + 1) } : {}) });
    }
    const doc = /^\/reports\/2021-06-30\/documents\/(.+)$/.exec(url.pathname);
    if (doc) {
      const datei = o.dateien?.[doc[1]!];
      return Response.json({ reportDocumentId: doc[1], url: `https://s3.example/${doc[1]}`, ...(datei?.gzip ? { compressionAlgorithm: "GZIP" } : {}) });
    }
    if (url.origin === "https://s3.example") {
      const datei = o.dateien?.[url.pathname.slice(1)];
      return datei ? new Response(datei.gzip ? gzipSync(datei.bytes) : datei.bytes) : new Response("", { status: 404 });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const client = (extra: Partial<AmazonSpClientOptions> = {}) =>
    new AmazonSpClient({
      clientId: ID,
      clientSecret: SECRET,
      refreshToken: TOKEN,
      tokenUrl: TOKEN_URL,
      fetch: fetchFn,
      now: () => NOW,
      sleep: async () => {},
      ...extra,
    });
  return { calls, client };
}

const text = (s: string) => new TextEncoder().encode(s);
const echt = (name: string) => readFileSync(new URL(`../../test-fixtures/amazon-sp/${name}`, import.meta.url), "utf8");

async function fehlerVon(p: Promise<unknown>): Promise<AmazonSpApiError> {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AmazonSpApiError);
  return error as AmazonSpApiError;
}

describe("AmazonSpClient", () => {
  it("tauscht das Refresh-Token bei LWA, nutzt das Zugangstoken weiter und fragt die EU-Adresse", async () => {
    const { calls, client } = api();
    const c = client();
    await c.pruefen();
    await c.settlementReports();
    const anmeldungen = calls.filter((x) => x.url.href === TOKEN_URL);
    expect(anmeldungen).toHaveLength(1);
    expect(anmeldungen[0]!.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(anmeldungen[0]!.body))).toEqual({
      grant_type: "refresh_token",
      refresh_token: TOKEN,
      client_id: ID,
      client_secret: SECRET,
    });
    const api_ = calls.filter((x) => x.url.href !== TOKEN_URL);
    expect(new Set(api_.map((x) => x.url.origin))).toEqual(new Set(["https://sellingpartnerapi-eu.amazon.com"]));
    expect(api_.every((x) => x.headers["x-amz-access-token"] === "Atza|zugang")).toBe(true);
  });

  it("prüft mit einer Seite der Settlement Reports", async () => {
    const { calls, client } = api();
    await client().pruefen();
    const anfrage = calls.find((x) => x.url.pathname === "/reports/2021-06-30/reports")!;
    expect(anfrage.url.searchParams.get("reportTypes")).toBe(AMAZON_SETTLEMENT_REPORT_TYPE);
    expect(anfrage.url.searchParams.get("pageSize")).toBe("1");
  });

  it("listet alle Seiten; Folgeseiten nur mit nextToken, ohne Filter nach Marktplatz", async () => {
    const { calls, client } = api({
      seiten: [[{ reportId: "R1", doc: "D1", created: "2026-11-15T21:00:00+00:00" }], [{ reportId: "R2", doc: "D2", created: "2026-11-17T21:00:00+00:00" }]],
    });
    expect(await client().settlementReports()).toEqual([
      { reportId: "R1", reportDocumentId: "D1", createdTime: "2026-11-15T21:00:00+00:00" },
      { reportId: "R2", reportDocumentId: "D2", createdTime: "2026-11-17T21:00:00+00:00" },
    ]);
    const listen = calls.filter((x) => x.url.pathname === "/reports/2021-06-30/reports");
    expect(Object.fromEntries(listen[0]!.url.searchParams)).toEqual({
      reportTypes: AMAZON_SETTLEMENT_REPORT_TYPE,
      processingStatuses: "DONE",
      pageSize: "100",
    });
    expect(Object.fromEntries(listen[1]!.url.searchParams)).toEqual({ nextToken: "1" });
  });

  it("lädt eine Report-Datei, auch mit GZIP", async () => {
    const { calls, client } = api({ dateien: { D1: { bytes: text("eins") }, D2: { bytes: text("zwei"), gzip: true } } });
    const c = client();
    expect(new TextDecoder().decode(await c.download("D1"))).toBe("eins");
    expect(new TextDecoder().decode(await c.download("D2"))).toBe("zwei");
    // Die vorsignierte URL bekommt kein Zugangstoken
    expect(calls.filter((x) => x.url.origin === "https://s3.example").every((x) => !x.headers["x-amz-access-token"])).toBe(true);
  });

  it("holt eine abgelaufene URL einmal neu", async () => {
    let s3 = 0;
    const { calls, client } = api({
      dateien: { D1: { bytes: text("eins") } },
      respond: (call) =>
        call.url.origin === "https://s3.example" && ++s3 === 1 ? new Response("<Error>Request has expired</Error>", { status: 403 }) : undefined,
    });
    expect(new TextDecoder().decode(await client().download("D1"))).toBe("eins");
    expect(calls.filter((x) => x.url.pathname === "/reports/2021-06-30/documents/D1")).toHaveLength(2);
  });

  it("lehnt eine Datei über der Grenze ab, auch erst nach dem Entpacken", async () => {
    const { client } = api({ dateien: { D1: { bytes: new Uint8Array(50) }, D2: { bytes: new Uint8Array(50), gzip: true } } });
    expect((await fehlerVon(client({ maxBytes: 40 }).download("D1"))).message).toMatch(/größer als 20 MB/);
    expect((await fehlerVon(client({ maxBytes: 40 }).download("D2"))).message).toMatch(/größer als 20 MB/);
  });

  it("meldet einen ungültigen Zugang als Art „zugang“ und nennt keine Geheimnisse", async () => {
    const { client } = api({
      respond: (call) =>
        call.url.href === TOKEN_URL
          ? Response.json({ error: "invalid_grant", error_description: `The request has an invalid grant parameter : ${TOKEN} ${SECRET}` }, { status: 400 })
          : undefined,
    });
    const error = await fehlerVon(client().pruefen());
    expect(error.art).toBe("zugang");
    expect(error.message).toMatch(/Refresh-Token/);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain(SECRET);
  });

  it("meldet 403 nach erneuertem Token als fehlende Rolle", async () => {
    const { calls, client } = api({
      respond: (call) =>
        call.url.pathname === "/reports/2021-06-30/reports"
          ? Response.json({ errors: [{ code: "Unauthorized", message: "Access to requested resource is denied." }] }, { status: 403 })
          : undefined,
    });
    const error = await fehlerVon(client().pruefen());
    expect(error.art).toBe("rolle");
    expect(error.message).toMatch(/Finance and Accounting/);
    expect(calls.filter((x) => x.url.href === TOKEN_URL)).toHaveLength(2);
  });

  it("wiederholt 429 und meldet danach Drosselung", async () => {
    const pausen: number[] = [];
    const { calls, client } = api({
      respond: (call) =>
        call.url.pathname.startsWith("/reports/2021-06-30/documents/") ? Response.json({ errors: [{ code: "QuotaExceeded" }] }, { status: 429 }) : undefined,
    });
    const error = await fehlerVon(client({ sleep: async (ms) => void pausen.push(ms) }).download("D1"));
    expect(error.art).toBe("drosselung");
    expect(calls.filter((x) => x.url.pathname === "/reports/2021-06-30/documents/D1")).toHaveLength(4);
    expect(pausen).toHaveLength(3);
  });

  it("meldet 429 ohne Retry-After als Drosselung ohne Wartezeit", async () => {
    const { client } = api({
      respond: (call) =>
        call.url.pathname.startsWith("/reports/2021-06-30/documents/") ? Response.json({ errors: [{ code: "QuotaExceeded" }] }, { status: 429 }) : undefined,
    });
    const error = await fehlerVon(client({ sleep: async () => {} }).download("D1"));
    expect(error.art).toBe("drosselung");
    expect(error.wartenMs).toBeNull();
  });

  it("wiederholt 429 nicht, wenn Amazon mehr als 10 s Wartezeit verlangt", async () => {
    const pausen: number[] = [];
    const { calls, client } = api({
      respond: (call) =>
        call.url.pathname.startsWith("/reports/2021-06-30/documents/")
          ? Response.json({ errors: [{ code: "QuotaExceeded" }] }, { status: 429, headers: { "retry-after": "120" } })
          : undefined,
    });
    const error = await fehlerVon(client({ sleep: async (ms) => void pausen.push(ms) }).download("D1"));
    expect(error.art).toBe("drosselung");
    expect(error.wartenMs).toBe(120_000);
    expect(pausen).toEqual([]);
    expect(calls.filter((x) => x.url.pathname === "/reports/2021-06-30/documents/D1")).toHaveLength(1);
  });

  it("nimmt mit Basis-URLs (nachgebaute API im E2E-Test) nur diese", async () => {
    const { calls, client } = api();
    await client({ baseUrl: "http://127.0.0.1:3151/" }).pruefen();
    expect(calls.map((x) => x.url.origin)).toEqual(["https://lwa.example", "http://127.0.0.1:3151"]);
  });

  it("liest die echte Antwort von getReports über beide Seiten", async () => {
    const { calls, client } = api({
      respond: (call) =>
        call.url.pathname === "/reports/2021-06-30/reports"
          ? new Response(call.url.searchParams.get("nextToken") === "BEISPIELNEXTTOKEN" ? echt("getreports-seite-2.json") : echt("getreports-seite-1.json"), {
              headers: { "content-type": "application/json" },
            })
          : undefined,
    });
    const reports = await client().settlementReports();
    expect(reports.map((r) => r.reportId)).toEqual(["100000000001", "100000000002", "100000000003", "100000000004"]);
    expect(reports[0]).toEqual({
      reportId: "100000000001",
      reportDocumentId: "amzn1.spdoc.1.4.eu.00000000-0000-4000-8000-000000000001.TBEISPIEL1.1118",
      createdTime: "2026-11-19T21:06:17+00:00",
    });
    expect(calls.filter((x) => x.url.pathname === "/reports/2021-06-30/reports").map((x) => x.url.searchParams.get("nextToken"))).toEqual([
      null,
      "BEISPIELNEXTTOKEN",
    ]);
  });
});
