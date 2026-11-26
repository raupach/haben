import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState, type FormEvent } from "react";
import { formatDateTime } from "../lib/format.ts";
import { useAction } from "../lib/use-action.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Field } from "./Field.tsx";
import { NoticeBanner } from "./NoticeBanner.tsx";
import { type getAmazonSpSettings, removeAmazonSpConnectionFn, saveAmazonSpConnectionFn } from "../server/functions/amazon.ts";

type Data = Awaited<ReturnType<typeof getAmazonSpSettings>>;

/**
 * Zugang zur Selling Partner API von Amazon (#1947): Client-ID, Client-Secret und Refresh-Token einer selbst
 * autorisierten privaten App. Steht auf der Seite Verbindungen unter „Stores und Marktplätze“; abgerufen wird auf der
 * Seite Bank mit „Amazon Datenabruf“.
 */
export function AmazonSpApiCard({ data }: { data: Data }) {
  const router = useRouter();
  const save = useServerFn(saveAmazonSpConnectionFn);
  const remove = useServerFn(removeAmazonSpConnectionFn);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const { busy, notice, run } = useAction();
  const behalten = data.configured ? " (leer lassen zum Behalten)" : "";

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const f = new FormData(form);
    const wert = (name: string) => String(f.get(name) ?? "");
    void run(async () => {
      await save({ data: { clientId: wert("clientId"), clientSecret: wert("clientSecret"), refreshToken: wert("refreshToken") } });
      form.reset();
      await router.invalidate();
    }, "Zugang geprüft und gespeichert.");
  }

  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>
        Haben holt die Abrechnungen (Settlement Reports) aller Marktplätze über die Selling Partner API und legt jede im Amazon-Konto ihres Marktplatzes ab, mit
        „Amazon Datenabruf“ auf der Seite Bank. Dafür braucht es im{" "}
        <a href="https://solutionproviderportal.amazon.com" target="_blank" rel="noreferrer">
          Solution Provider Portal
        </a>{" "}
        eine selbst autorisierte private App mit der Rolle „Finance and Accounting“. Amazon hält die Reports 90 Tage bereit; ältere importierst du als Datei.
      </p>
      <p className="small" style={{ margin: "0.5rem 0 0" }}>
        <strong>{data.configured ? `Eingerichtet (Client-ID …${data.keyHint}).` : "Nicht eingerichtet."}</strong>
        {data.updatedAt ? ` Zuletzt geändert: ${formatDateTime(data.updatedAt)}.` : ""}
      </p>
      <form className="stack" onSubmit={onSubmit}>
        <Field label={`Client-ID${behalten}`} hint="Aus der App im Solution Provider Portal; alle drei Werte liegen verschlüsselt in der Datenbank.">
          {(control) => <input {...control} name="clientId" type="text" autoComplete="off" />}
        </Field>
        <Field label={`Client-Secret${behalten}`}>{(control) => <input {...control} name="clientSecret" type="password" autoComplete="off" />}</Field>
        <Field label={`Refresh-Token${behalten}`} hint="Erscheint beim Autorisieren der App; Amazon verlangt die Autorisierung jedes Jahr neu.">
          {(control) => <input {...control} name="refreshToken" type="password" autoComplete="off" />}
        </Field>
        <div className="actions">
          <button type="button" className="btn btn-danger" disabled={busy || !data.configured} onClick={() => setConfirmingRemove(true)}>
            Zugang entfernen
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Prüfe …" : "Speichern"}
          </button>
        </div>
        <NoticeBanner notice={notice} />
        <ConfirmDialog
          open={confirmingRemove}
          title="Amazon-Zugang entfernen?"
          confirmLabel="Entfernen"
          danger
          onConfirm={() => {
            setConfirmingRemove(false);
            void run(async () => {
              await remove();
              await router.invalidate();
            }, "Zugang entfernt. Übernommene Umsätze bleiben in den Konten stehen.");
          }}
          onClose={() => setConfirmingRemove(false)}
        >
          <p>Client-ID, Client-Secret und Refresh-Token werden gelöscht. Übernommene Umsätze und das Protokoll der Abrechnungen bleiben.</p>
        </ConfirmDialog>
      </form>
    </div>
  );
}
