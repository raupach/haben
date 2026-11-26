import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "../middleware.ts";
import {
  amazonLaufAbbrechen,
  amazonLaufStand,
  amazonLaufStarten,
  amazonSpEingerichtet,
  amazonSpSettingsSchema,
  amazonSpSummary,
  deleteAmazonSpConnection,
  saveAmazonSpConnection,
} from "../modules/amazon/index.ts";

/** Selling Partner API von Amazon (#1947): Zugang unter Einstellungen › Bank, Datenabruf auf der Seite Bank */

export const getAmazonSpSettings = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async () => amazonSpSummary());

/** Für die Seite Bank: ob „Amazon Datenabruf“ erscheint (eigene Funktion, weil functions/bank.ts schon 400 Zeilen hat) */
export const amazonSpEingerichtetFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async () => amazonSpEingerichtet());

export const saveAmazonSpConnectionFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(amazonSpSettingsSchema)
  .handler(async ({ data, context }) => {
    await saveAmazonSpConnection(context.user.id, data);
    return { ok: true };
  });

export const removeAmazonSpConnectionFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await deleteAmazonSpConnection(context.user.id);
    return { ok: true };
  });

export const amazonDatenabrufStartenFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => amazonLaufStarten(context.user.id));

export const amazonDatenabrufStandFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async () => amazonLaufStand());

export const amazonDatenabrufAbbrechenFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async () => {
    amazonLaufAbbrechen();
    return amazonLaufStand();
  });
