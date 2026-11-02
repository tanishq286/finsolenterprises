"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { callApi } from "@/lib/api/client";
export function MyTraces({
  initial,
}: {
  initial: { id: string; reference: string; status: string }[];
}) {
  const [items, setItems] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  async function withdraw(id: string) {
    setBusy(id);
    setError("");
    try {
      await callApi(`traces/${id}/withdraw`, { body: {} });
      setItems(items.map((i) => (i.id === id ? { ...i, status: "WITHDRAWN" } : i)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <p className="my-4">
        A possible match needs identity and entitlement checks. No match means no match in the
        sources checked, not that no holdings exist.
      </p>
      {error && <p role="alert">{error}</p>}
      <ul className="grid gap-3">
        {items.map((i) => (
          <li key={i.id} className="panel p-4">
            <p className="break-all font-mono">{i.reference}</p>
            <p className="my-3" aria-live="polite">
              {i.status.replaceAll("_", " ")}
            </p>
            {i.status !== "WITHDRAWN" && (
              <Button disabled={busy !== null} variant="outline" onClick={() => withdraw(i.id)}>
                Withdraw request
              </Button>
            )}
          </li>
        ))}
      </ul>
      {!items.length && <p>No trace requests yet.</p>}
    </>
  );
}
