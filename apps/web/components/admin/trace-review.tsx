"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { callApi } from "@/lib/api/client";
export function TraceReview({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>, kind: "check" | "status") {
    e.preventDefault();
    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await callApi(`admin/traces/${id}${kind === "check" ? "/checks" : ""}`, {
        method: kind === "check" ? "POST" : "PATCH",
        body: data,
      });
      setMessage("Saved.");
      if (kind === "check") form.reset();
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (status === "WITHDRAWN")
    return <p>Consent withdrawn. Do not carry out further source checks.</p>;
  return (
    <div className="grid gap-6 mt-6">
      {error && (
        <p role="alert" className="text-blocker">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {!status.startsWith("CLOSED") && (
        <form onSubmit={(e) => submit(e, "check")} className="panel p-5 grid gap-4">
          <h2 className="text-xl font-semibold">Record a source check</h2>
          <p>
            Record the authority for this check. Do not put personal identifiers in the source URL
            or authorisation field; use the encrypted note.
          </p>
          <label className="grid gap-1">
            Source page URL
            <Input name="source" type="url" required maxLength={1000} />
          </label>
          <label className="grid gap-1">
            Authorisation or access basis
            <Input name="authorisation" required minLength={10} maxLength={500} />
          </label>
          <label className="grid gap-1">
            Outcome
            <Select name="outcome">
              <option value="NO_MATCH">No match in this source</option>
              <option value="MATCH_FOUND">Possible match found</option>
              <option value="NEEDS_MORE_DETAILS">More details needed</option>
              <option value="NOT_AVAILABLE">Source unavailable</option>
            </Select>
          </label>
          <label className="grid gap-1">
            Encrypted review note
            <Input name="note" maxLength={2000} />
          </label>
          <Button disabled={busy} type="submit">
            Save source check
          </Button>
        </form>
      )}
      <form onSubmit={(e) => submit(e, "status")} className="flex flex-wrap gap-3 items-end">
        <label className="grid gap-1">
          Request status
          <Select key={status} name="status" defaultValue={status}>
            <option value="PENDING_AUDIT">Pending Audit</option>
            <option value="RTA_ARCHIVE_SEARCHED">RTA Archive Searched</option>
            <option value="MATCH_FOUND">Match Found</option>
            <option value="CLOSED">Closed</option>
            <option value="OPEN">Open</option>
            <option value="NEEDS_DETAILS">Needs details</option>
            <option value="IN_PROGRESS">In progress</option>
            <option value="CLOSED_FOUND">Closed: possible match found</option>
            <option value="CLOSED_NOT_FOUND">Closed: no match in checked sources</option>
          </Select>
        </label>
        <Button disabled={busy} type="submit">
          Update status
        </Button>
      </form>
    </div>
  );
}
