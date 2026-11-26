import { gunzipSync } from "fflate";
import { z } from "zod";
import { networkErrorText } from "@haben/core";
import { backoff, parseRetryAfter, RETRY_STATUSES } from "../retry.ts";

/*
 * Lesender Client für die Settlement Reports der Selling Partner API von Amazon, Region EU (#1947).
 *
 * Zugang: Refresh-Token einer selbst autorisierten privaten App
 * (https://developer-docs.amazon.com/sp-api/docs/self-authorization). Der Client tauscht es bei Login with Amazon
 * (LWA) gegen ein Zugangstoken (eine Stunde) und schickt es als x-amz-access-token; eine AWS-Signatur braucht die
 * SP-API dafür nicht (https://developer-docs.amazon.com/sp-api/docs/connecting-to-the-selling-partner-api).
 *
 * Settlement Reports lassen sich nicht anfordern: Amazon erzeugt sie selbst, getReports listet sie 90 Tage ab
 * Erzeugung (https://developer-docs.amazon.com/sp-api/docs/report-type-values-settlement). marketplaceIds grenzt sie
 * nicht ein; an einem echten Konto nannte jeder Report alle EU-Marktplätze. Den Marktplatz liest der Aufrufer aus der
 * Datei. getReportDocument liefert eine vorsignierte URL, die fünf Minuten gilt, bei compressionAlgorithm GZIP
 * komprimiert. Grenzen laut Doku: getReports 0,0222/s (Burst 10), getReportDocument 0,0167/s (Burst 15).
 */

export const AMAZON_SP_HOST_EU = "https://sellingpartnerapi-eu.amazon.com";
export const AMAZON_LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
export const AMAZON_SETTLEMENT_REPORT_TYPE = "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2";
/** Wie beim Dateiimport (functions/bank.ts) */
export const AMAZON_MAX_REPORT_BYTES = 20 * 1024 * 1024;

/** zugang: Anmeldung abgelehnt; rolle: Rolle fehlt; drosselung: 429; sonstig: alles andere */
export type AmazonSpFehlerArt = "zugang" | "rolle" | "drosselung" | "sonstig";

export class AmazonSpApiError extends Error {
  readonly art: AmazonSpFehlerArt;
  /** HTTP-Status; 0 bei Netzwerkfehlern */
  readonly status: number;
  readonly path: string;
  /** Wartezeit aus Retry-After bei Drosselung in Millisekunden, sonst null */
  readonly wartenMs: number | null;
  constructor(message: string, art: AmazonSpFehlerArt, status: number, path: string, options?: { cause?: unknown; wartenMs?: number | null }) {
    super(message, options);
    this.name = "AmazonSpApiError";
    this.art = art;
    this.status = status;
    this.path = path;
    this.wartenMs = options?.wartenMs ?? null;
  }
}

export interface AmazonSpClientOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Nur für Tests gegen eine nachgebaute API (AMAZON_SP_API_URL) */
  baseUrl?: string;
  /** Nur für Tests (AMAZON_LWA_TOKEN_URL) */
  tokenUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Für Tests kleiner; Standard AMAZON_MAX_REPORT_BYTES */
  maxBytes?: number;
}

export interface AmazonSettlementReportInfo {
  reportId: string;
  reportDocumentId: string;
  /** ISO-Zeitpunkt der Erzeugung; nach ihm arbeitet der Abruf die Reports ab, älteste zuerst */
  createdTime: string;
}

const reportSchema = z.looseObject({
  reportId: z.string().min(1),
  reportDocumentId: z.string().min(1).nullish(),
  createdTime: z.string(),
  processingStatus: z.string(),
});
const listSchema = z.looseObject({ reports: z.array(reportSchema), nextToken: z.string().nullish() });
const documentSchema = z.looseObject({ url: z.string().url(), compressionAlgorithm: z.string().nullish() });
const tokenSchema = z.looseObject({ access_token: z.string().min(1), expires_in: z.number().positive().nullish() });

const REPORTS_PATH = "/reports/2021-06-30/reports";
/** Schutz gegen eine Endlosschleife; 100 Reports je Seite */
const MAX_PAGES = 100;
/** Wiederholungen bei 502/503/504 und Netzwerkfehlern */
const MAX_RETRIES = 3;

export class AmazonSpClient {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #refreshToken: string;
  readonly #baseUrl: string;
  readonly #tokenUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxBytes: number;
  #token: { value: string; expiresAt: number } | null = null;

  constructor(options: AmazonSpClientOptions) {
    if (!options.clientId.trim() || !options.clientSecret.trim() || !options.refreshToken.trim()) {
      throw new Error("Client-ID, Client-Secret und Refresh-Token der Amazon-App fehlen");
    }
    this.#clientId = options.clientId.trim();
    this.#clientSecret = options.clientSecret.trim();
    this.#refreshToken = options.refreshToken.trim();
    this.#baseUrl = (options.baseUrl ?? AMAZON_SP_HOST_EU).replace(/\/$/, "");
    this.#tokenUrl = options.tokenUrl ?? AMAZON_LWA_TOKEN_URL;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#maxBytes = options.maxBytes ?? AMAZON_MAX_REPORT_BYTES;
  }

  /** Prüft Zugang und Rolle mit einer Seite der Settlement Reports */
  async pruefen(): Promise<void> {
    await this.#json(`${REPORTS_PATH}?${new URLSearchParams({ reportTypes: AMAZON_SETTLEMENT_REPORT_TYPE, pageSize: "1" })}`, listSchema);
  }

  /** Alle fertigen Settlement Reports, die Amazon noch bereithält, über alle Seiten */
  async settlementReports(): Promise<AmazonSettlementReportInfo[]> {
    const all: AmazonSettlementReportInfo[] = [];
    let query = new URLSearchParams({ reportTypes: AMAZON_SETTLEMENT_REPORT_TYPE, processingStatuses: "DONE", pageSize: "100" });
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) throw new AmazonSpApiError("Zu viele Seiten in der Liste der Reports", "sonstig", 0, REPORTS_PATH);
      const result = await this.#json(`${REPORTS_PATH}?${query}`, listSchema);
      for (const r of result.reports) {
        if (r.processingStatus === "DONE" && r.reportDocumentId)
          all.push({ reportId: r.reportId, reportDocumentId: r.reportDocumentId, createdTime: r.createdTime });
      }
      if (!result.nextToken) return all;
      // Folgeseiten nur mit nextToken; jeder weitere Parameter lässt die Anfrage scheitern (getReports)
      query = new URLSearchParams({ nextToken: result.nextToken });
    }
  }

  /** Die Datei eines Reports, entpackt; eine abgelaufene URL holt der Client einmal neu */
  async download(reportDocumentId: string): Promise<Uint8Array> {
    const path = `/reports/2021-06-30/documents/${encodeURIComponent(reportDocumentId)}`;
    for (let versuch = 0; ; versuch++) {
      const doc = await this.#json(path, documentSchema);
      let response: Response;
      try {
        response = await this.#fetch(doc.url);
      } catch (cause) {
        throw new AmazonSpApiError(`Report-Datei nicht erreichbar: ${networkErrorText(cause)}`, "sonstig", 0, "report-datei", { cause });
      }
      // S3 antwortet auf eine abgelaufene vorsignierte URL mit 403 (bzw. 400)
      if ((response.status === 403 || response.status === 400) && versuch === 0) {
        await response.body?.cancel();
        continue;
      }
      if (!response.ok) throw new AmazonSpApiError(`Report-Datei nicht ladbar (HTTP ${response.status})`, "sonstig", response.status, "report-datei");
      if (Number(response.headers.get("content-length") ?? 0) > this.#maxBytes) throw this.#zuGross();
      let bytes: Uint8Array = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > this.#maxBytes) throw this.#zuGross();
      if (doc.compressionAlgorithm === "GZIP") bytes = gunzipSync(bytes);
      if (bytes.length > this.#maxBytes) throw this.#zuGross();
      return bytes;
    }
  }

  #zuGross(): AmazonSpApiError {
    return new AmazonSpApiError("Die Report-Datei ist größer als 20 MB.", "sonstig", 0, "report-datei");
  }

  async #accessToken(): Promise<string> {
    if (this.#token && this.#now() < this.#token.expiresAt) return this.#token.value;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.#refreshToken,
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
    });
    const response = await this.#send(this.#tokenUrl, "lwa", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", accept: "application/json" },
      body: body.toString(),
    });
    const token = tokenSchema.safeParse(await response.json().catch(() => null));
    if (!token.success) throw new AmazonSpApiError("Unerwartete Antwort von Amazon beim Anmelden", "sonstig", response.status, "lwa");
    // Eine Minute Reserve, damit ein Token nicht mitten im Abruf abläuft
    this.#token = { value: token.data.access_token, expiresAt: this.#now() + ((token.data.expires_in ?? 3600) - 60) * 1000 };
    return token.data.access_token;
  }

  async #json<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const request = async () =>
      this.#send(
        `${this.#baseUrl}${path}`,
        path,
        { method: "GET", headers: { "x-amz-access-token": await this.#accessToken(), accept: "application/json" } },
        true,
      );
    let response = await request();
    if (response.status === 403) {
      // Ein abgelaufenes oder entzogenes Token antwortet ebenfalls mit 403: einmal neu anmelden, dann gilt es als fehlende Rolle
      await response.body?.cancel();
      this.#token = null;
      response = await request();
      if (response.status === 403)
        throw new AmazonSpApiError(errorText("rolle", 403, await response.text().catch(() => ""), this.#secrets()), "rolle", 403, path);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch (cause) {
      throw new AmazonSpApiError("Antwort von Amazon ist kein JSON", "sonstig", response.status, path, { cause });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success)
      throw new AmazonSpApiError(`Unerwartete Antwort von Amazon: ${parsed.error.issues[0]?.message ?? ""}`, "sonstig", response.status, path);
    return parsed.data;
  }

  /** Eine Anfrage mit Wiederholung; `allow403` gibt ein 403 zurück, damit der Aufrufer das Token erneuern kann */
  async #send(url: string, path: string, init: RequestInit, allow403 = false): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.#fetch(url, init);
      } catch (cause) {
        if (attempt < MAX_RETRIES) {
          await this.#sleep(backoff(attempt));
          continue;
        }
        throw new AmazonSpApiError(`Amazon nicht erreichbar: ${networkErrorText(cause)}`, "sonstig", 0, path, { cause });
      }
      if (response.ok || (allow403 && response.status === 403)) return response;
      const body = await response.text().catch(() => "");
      // 429 wiederholt der Client nicht: Die Wartezeit steuert der Aufrufer (der Abruf wartet und zeigt es an); kurze
      // Wiederholungen helfen bei etwa einem Aufruf je Minute nicht.
      if (response.status !== 429 && RETRY_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
        await this.#sleep(parseRetryAfter(response.headers.get("retry-after"), this.#now()) ?? backoff(attempt));
        continue;
      }
      const art: AmazonSpFehlerArt =
        path === "lwa" && (response.status === 400 || response.status === 401)
          ? "zugang"
          : response.status === 401
            ? "zugang"
            : response.status === 403
              ? "rolle"
              : response.status === 429
                ? "drosselung"
                : "sonstig";
      const wartenMs = art === "drosselung" ? parseRetryAfter(response.headers.get("retry-after"), this.#now()) : null;
      throw new AmazonSpApiError(errorText(art, response.status, body, this.#secrets()), art, response.status, path, { wartenMs });
    }
  }

  /** Alles, was in keiner Meldung stehen darf */
  #secrets(): string[] {
    return [this.#clientSecret, this.#refreshToken, this.#clientId, this.#token?.value ?? ""].filter((s) => s.length >= 4);
  }
}

const PREFIX: Record<AmazonSpFehlerArt, string> = {
  zugang:
    "Amazon nimmt den Zugang nicht an: Client-ID, Client-Secret oder Refresh-Token stimmen nicht, oder die Autorisierung ist abgelaufen (im Solution Provider Portal neu autorisieren)",
  rolle: "Amazon verweigert den Zugriff auf die Settlement Reports: Der App fehlt die Rolle „Finance and Accounting“",
  drosselung: "Amazon drosselt die Abrufe (zu viele Anfragen)",
  sonstig: "",
};

/**
 * Meldung aus der Antwort. LWA liefert {error, error_description}, die SP-API {errors: [{code, message}]}. Geheimnisse
 * werden ersetzt, bevor gekürzt wird, sonst bliebe ein Stück stehen.
 */
function errorText(art: AmazonSpFehlerArt, status: number, body: string, secrets: string[]): string {
  const scrub = (value: string) => secrets.reduce((text, secret) => text.replaceAll(secret, "…"), value);
  let detail = scrub(body).slice(0, 300);
  try {
    const json = JSON.parse(body) as { error?: unknown; error_description?: unknown; errors?: { code?: unknown; message?: unknown }[] };
    const parts = [json.error_description ?? json.errors?.[0]?.message, json.error ?? json.errors?.[0]?.code].filter(
      (p): p is string => typeof p === "string" && p !== "",
    );
    if (parts.length > 0) detail = scrub(parts.join(" ")).slice(0, 300);
  } catch {
    // kein JSON
  }
  const prefix = PREFIX[art] || `HTTP ${status}`;
  return detail ? `${prefix}: ${detail}` : prefix;
}
