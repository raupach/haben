import { AmazonSpApiError, AmazonSpClient, type AmazonSpClientOptions } from "@haben/import";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { decrypt, encrypt } from "../../crypto.ts";
import { withActor } from "../../db/actor.ts";
import { db, schema } from "../../db/index.ts";
import { env } from "../../env.ts";
import { UserError } from "../../errors.ts";

/*
 * Zugang zur Selling Partner API von Amazon (Einstellungen › Bank, #1947).
 *
 * Wer Haben betreibt, registriert sich im Solution Provider Portal als privater Entwickler, legt eine private App mit
 * der Rolle „Finance and Accounting“ an und autorisiert sie selbst; dabei zeigt Amazon das Refresh-Token
 * (https://developer-docs.amazon.com/sp-api/docs/self-authorization). Client-ID, Client-Secret und Refresh-Token liegen
 * zusammen AES-256-GCM-verschlüsselt in ciphertext. Beim Speichern prüft Haben sie mit einer Seite der Settlement
 * Reports. Nur Region EU.
 */

export class AmazonSpError extends UserError {}

/** Für Tests austauschbar: baut den API-Client */
let clientFactory = (options: AmazonSpClientOptions): AmazonSpClient => new AmazonSpClient(options);

export function setAmazonSpClientFactory(factory: (options: AmazonSpClientOptions) => AmazonSpClient) {
  clientFactory = factory;
}

export interface AmazonSpCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export function amazonSpClientFor(credentials: AmazonSpCredentials): AmazonSpClient {
  return clientFactory({ ...credentials, baseUrl: env().AMAZON_SP_API_URL, tokenUrl: env().AMAZON_LWA_TOKEN_URL });
}

async function loadRow() {
  const [row] = await db.select().from(schema.amazonSpConnections).where(eq(schema.amazonSpConnections.id, "amazon"));
  return row ?? null;
}

export async function loadAmazonSpConnection(): Promise<{ credentials: AmazonSpCredentials } | null> {
  const row = await loadRow();
  if (!row) return null;
  return { credentials: JSON.parse(decrypt(row.ciphertext).toString("utf8")) as AmazonSpCredentials };
}

export const amazonSpSettingsSchema = z.object({
  /** leer: den gespeicherten Wert behalten */
  clientId: z.string().trim().max(300).optional(),
  clientSecret: z.string().trim().max(300).optional(),
  refreshToken: z.string().trim().max(2000).optional(),
});

const NAMEN: Record<keyof AmazonSpCredentials, string> = { clientId: "Client-ID", clientSecret: "Client-Secret", refreshToken: "Refresh-Token" };

/** Meldung zu einem Fehler beim Prüfen; die Meldungen des Clients nennen keine Geheimnisse */
export function amazonFehlertext(error: unknown): string {
  return error instanceof AmazonSpApiError ? error.message : `Amazon nicht erreichbar: ${error instanceof Error ? error.message : String(error)}`;
}

/** Speichert den Zugang nach einer Prüfung bei Amazon; leere Felder behalten den gespeicherten Wert */
export async function saveAmazonSpConnection(actor: string, input: z.input<typeof amazonSpSettingsSchema>): Promise<void> {
  const data = amazonSpSettingsSchema.parse(input);
  const existing = await loadAmazonSpConnection();
  const credentials: AmazonSpCredentials = {
    clientId: data.clientId || existing?.credentials.clientId || "",
    clientSecret: data.clientSecret || existing?.credentials.clientSecret || "",
    refreshToken: data.refreshToken || existing?.credentials.refreshToken || "",
  };
  const fehlt = (Object.keys(NAMEN) as (keyof AmazonSpCredentials)[]).filter((k) => !credentials[k]).map((k) => NAMEN[k]);
  if (fehlt.length > 0) throw new AmazonSpError(`${fehlt.join(", ")} fehlt.`);
  try {
    await amazonSpClientFor(credentials).pruefen();
  } catch (error) {
    throw new AmazonSpError(amazonFehlertext(error));
  }
  const values = {
    keyHint: credentials.clientId.slice(-4),
    ciphertext: encrypt(new TextEncoder().encode(JSON.stringify(credentials))),
    updatedAt: new Date(),
  };
  await withActor(actor, (tx) =>
    tx
      .insert(schema.amazonSpConnections)
      .values({ id: "amazon", ...values })
      .onConflictDoUpdate({ target: schema.amazonSpConnections.id, set: values }),
  );
}

/** Entfernt den Zugang; übernommene Umsätze und das Protokoll bleiben */
export async function deleteAmazonSpConnection(actor: string): Promise<void> {
  await withActor(actor, (tx) => tx.delete(schema.amazonSpConnections).where(eq(schema.amazonSpConnections.id, "amazon")));
}

/** Für die Einstellungen: Stand ohne Geheimnisse */
export async function amazonSpSummary() {
  const row = await loadRow();
  return { configured: row !== null, keyHint: row?.keyHint ?? "", updatedAt: row?.updatedAt ?? null };
}

export async function amazonSpEingerichtet(): Promise<boolean> {
  return (await loadRow()) !== null;
}
