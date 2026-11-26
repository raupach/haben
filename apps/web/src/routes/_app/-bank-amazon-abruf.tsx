import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import type { ImportMessage } from "../../components/BankImportMeldungen.tsx";
import { errorMessage } from "../../lib/format.ts";
import { amazonDatenabrufFn } from "../../server/functions/amazon.ts";

/**
 * „Amazon Datenabruf“ (#1947): holt alle neuen Settlement Reports und legt jeden im Amazon-Konto seines Marktplatzes
 * ab. Gesperrt, solange er läuft; die Meldungen stehen wie die des Dateiimports darunter.
 */
export function AmazonDatenabrufKnopf({ disabled, onMessages }: { disabled: boolean; onMessages: (messages: ImportMessage[]) => void }) {
  const router = useRouter();
  const abruf = useServerFn(amazonDatenabrufFn);
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    onMessages([]);
    try {
      onMessages(await abruf());
      await router.invalidate();
    } catch (error) {
      onMessages([{ tone: "danger", text: errorMessage(error) }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className="btn" disabled={disabled || busy} onClick={() => void onClick()}>
      {busy ? "Ruft ab …" : "Amazon Datenabruf"}
    </button>
  );
}
