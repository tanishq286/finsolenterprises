import { api } from "@/lib/api/server";
import { handleApiError } from "@/lib/api/guard";
import { TraceReview } from "@/components/admin/trace-review";
export const metadata = { title: "Trace review", robots: { index: false } };
interface Trace {
  id: string;
  reference: string;
  status: string;
  holderName: string;
  scope: string;
  details: {
    relationship: string;
    oldCity?: string;
    oldAddress?: string;
    certificateStatus?: "AVAILABLE" | "LOST" | "PARTIAL" | "UNKNOWN";
    companies?: string;
    years?: string;
    contact: { phone: string; email?: string | null; name?: string; phoneVerifiedBy?: string };
  };
  indexSnapshot: unknown;
  checks: {
    id: string;
    source: string;
    authorisation: string;
    outcome: string;
    note?: string;
    checkedAt: string;
  }[];
}
export default async function TraceDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let data: Trace;
  try {
    data = await api<Trace>(`admin/traces/${encodeURIComponent(id)}`, { session: true });
  } catch (e) {
    handleApiError(e, "/admin/traces");
  }
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold break-all">{data.reference}</h1>
      <p className="mt-3">
        {data.holderName} · {data.scope.replaceAll("_", " ")}
      </p>
      <dl className="my-5 grid gap-2">
        <dt>Relationship</dt>
        <dd>{data.details?.relationship ?? "Not specified"}</dd>
        <dt>Claimant Contact</dt>
        <dd>
          {data.details?.contact?.name ? `${data.details.contact.name} · ` : ""}
          {data.details?.contact?.phone ?? "No phone"}
          {data.details?.contact?.phoneVerifiedBy === "LOGIN_OTP"
            ? " (verified by OTP at sign-in)"
            : ""}{" "}
          · {data.details?.contact?.email ?? "No email"}
        </dd>
        <dt>Physical Certificate Status</dt>
        <dd>{data.details?.certificateStatus ?? "UNKNOWN"}</dd>
        <dt>Optional clues</dt>
        <dd>
          {[
            data.details?.oldCity,
            data.details?.oldAddress,
            data.details?.companies,
            data.details?.years,
          ]
            .filter(Boolean)
            .join(" · ") || "None supplied"}
        </dd>
      </dl>
      <details>
        <summary>Index coverage when requested</summary>
        <pre className="overflow-auto text-xs mt-3">
          {JSON.stringify(data.indexSnapshot, null, 2)}
        </pre>
      </details>
      <TraceReview id={id} status={data.status} />
      <h2 className="text-xl font-semibold mt-8">Source checks</h2>
      <ul className="grid gap-3 mt-4">
        {data.checks.map((c) => (
          <li key={c.id} className="panel p-4">
            <p className="break-all">{c.source}</p>
            <p>
              {c.outcome.replaceAll("_", " ")} · {c.checkedAt}
            </p>
            <p>{c.authorisation}</p>
            <p>{c.note}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
