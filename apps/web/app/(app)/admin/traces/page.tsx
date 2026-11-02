import Link from "next/link";
import { api } from "@/lib/api/server";
import { handleApiError } from "@/lib/api/guard";

export const metadata = { title: "Archival Deeper Trace Requests", robots: { index: false } };

interface Queue {
  items: {
    id: string;
    reference: string;
    status: string;
    scope: string;
    createdAt: string;
    /** PENDING_CALL_VERIFICATION when the request came in without a sign-in code. */
    contactVerification?: string;
  }[];
  total: number;
  page: number;
}

function statusBadge(status: string) {
  const norm = status.toUpperCase();
  if (norm === "PENDING_AUDIT" || norm === "OPEN") {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-semibold text-amber-700 border border-amber-500/30">
        Pending Audit
      </span>
    );
  }
  if (norm === "RTA_ARCHIVE_SEARCHED" || norm === "IN_PROGRESS") {
    return (
      <span className="inline-flex items-center rounded-full bg-blue-500/15 px-2.5 py-0.5 text-xs font-semibold text-blue-700 border border-blue-500/30">
        RTA Archive Searched
      </span>
    );
  }
  if (norm === "MATCH_FOUND" || norm === "CLOSED_FOUND") {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 border border-emerald-500/30">
        Match Found
      </span>
    );
  }
  if (norm === "CLOSED" || norm === "CLOSED_NOT_FOUND" || norm === "WITHDRAWN") {
    return (
      <span className="inline-flex items-center rounded-full bg-zinc-500/15 px-2.5 py-0.5 text-xs font-semibold text-zinc-700 border border-zinc-500/30">
        {norm === "WITHDRAWN" ? "Withdrawn" : "Closed"}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground">
      {status.replaceAll("_", " ")}
    </span>
  );
}

export default async function TraceQueue({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const raw = Number((await searchParams).page ?? 1);
  const page = Number.isInteger(raw) && raw >= 1 && raw <= 100000 ? raw : 1;
  let data: Queue = { items: [], total: 0, page: 1 };
  try {
    data = await api<Queue>(`admin/traces?page=${page}`, { session: true });
  } catch (e) {
    handleApiError(e, "/admin/traces");
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            Archival Deeper Trace Requests
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Staff CRM audit queue for zero-match searches requiring manual RTA microfilm and
            physical certificate trace.
          </p>
        </div>
        <div className="rounded-lg bg-card border border-border px-4 py-2 text-right">
          <div className="text-2xl font-bold text-foreground">{data.total}</div>
          <div className="text-xs text-muted-foreground uppercase font-semibold">
            Active Inquiries
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <ul className="divide-y divide-border">
          {data.items.map((item) => (
            <li key={item.id} className="p-4 sm:px-6 hover:bg-muted/50 transition-colors">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div>
                  <div className="flex items-center gap-3">
                    <Link
                      className="font-mono text-base font-bold text-primary hover:underline"
                      href={`/admin/traces/${item.id}`}
                    >
                      {item.reference}
                    </Link>
                    {statusBadge(item.status)}
                    {item.contactVerification === "PENDING_CALL_VERIFICATION" && (
                      <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-xs font-semibold text-amber-700">
                        Verify number by call
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Scope:{" "}
                    <span className="font-medium text-foreground">
                      {item.scope.replaceAll("_", " ")}
                    </span>{" "}
                    · Submitted:{" "}
                    {new Date(item.createdAt).toLocaleDateString("en-IN", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <Link
                    href={`/admin/traces/${item.id}`}
                    className="inline-flex items-center justify-center rounded-md text-xs font-medium border border-border bg-background px-3 py-1.5 hover:bg-muted transition-colors"
                  >
                    Review Audit →
                  </Link>
                </div>
              </div>
            </li>
          ))}
        </ul>

        {!data.items.length && (
          <div className="p-8 text-center text-muted-foreground">
            No trace requests found on this page.
          </div>
        )}
      </div>

      <nav aria-label="Request pages" className="flex items-center justify-between gap-6 mt-6">
        <div>
          {page > 1 && (
            <Link
              className="text-sm font-medium text-primary hover:underline"
              href={`/admin/traces?page=${page - 1}`}
            >
              ← Previous page
            </Link>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          Page {page} of {Math.max(1, Math.ceil(data.total / 50))}
        </div>
        <div>
          {page * 50 < data.total && (
            <Link
              className="text-sm font-medium text-primary hover:underline"
              href={`/admin/traces?page=${page + 1}`}
            >
              Next page →
            </Link>
          )}
        </div>
      </nav>
    </div>
  );
}
