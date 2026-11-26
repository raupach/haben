import { AmazonSpClient, type AmazonSpClientOptions } from "@haben/import";

/*
 * Nachgebaute SP-API für die Postgres-Tests des Amazon-Abrufs (#1947): Anmeldung, getReports (eine Seite),
 * getReportDocument und Download. Reports und Dateien setzt der Test; `drossel` lässt Downloads ab dem n-ten mit 429
 * scheitern, `status` beantwortet jede Anfrage an die API mit diesem Status. Kennungen erfunden.
 */

export interface NachgebauterReport {
  reportId: string;
  bytes: Uint8Array<ArrayBuffer>;
  createdTime: string;
}

export function amazonApi() {
  const stand = {
    reports: [] as NachgebauterReport[],
    downloads: [] as string[],
    /** Ab diesem Download (1-basiert) antwortet getReportDocument mit 429 */
    drossel: Infinity,
    /** Status für Anmeldung und API, etwa 400 (invalid_grant) oder 403 */
    status: 200,
  };
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/auth/o2/token") {
      if (stand.status === 400)
        return Response.json({ error: "invalid_grant", error_description: "The request has an invalid grant parameter" }, { status: 400 });
      return Response.json({ access_token: "Atza|zugang", expires_in: 3600 });
    }
    if (stand.status === 403) return Response.json({ errors: [{ code: "Unauthorized", message: "Access to requested resource is denied." }] }, { status: 403 });
    if (url.pathname === "/reports/2021-06-30/reports") {
      return Response.json({
        reports: stand.reports.map((r) => ({
          reportId: r.reportId,
          reportDocumentId: `DOC-${r.reportId}`,
          createdTime: r.createdTime,
          processingStatus: "DONE",
        })),
      });
    }
    const doc = /^\/reports\/2021-06-30\/documents\/DOC-(.+)$/.exec(url.pathname);
    if (doc) {
      if (stand.downloads.length + 1 >= stand.drossel) return Response.json({ errors: [{ code: "QuotaExceeded" }] }, { status: 429 });
      return Response.json({ url: `https://s3.example/${doc[1]}` });
    }
    if (url.origin === "https://s3.example") {
      const report = stand.reports.find((r) => r.reportId === url.pathname.slice(1));
      if (!report) return new Response("", { status: 404 });
      stand.downloads.push(report.reportId);
      return new Response(report.bytes);
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const factory = (options: AmazonSpClientOptions) =>
    new AmazonSpClient({ ...options, baseUrl: "https://sp.example", tokenUrl: "https://sp.example/auth/o2/token", fetch: fetchFn, sleep: async () => {} });
  return { stand, factory };
}
