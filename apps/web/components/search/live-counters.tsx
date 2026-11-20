import { Building2Icon, DatabaseIcon, IndianRupeeIcon, MapPinnedIcon } from "lucide-react";

import { apiOrNull } from "@/lib/api/server";
import type { Stats } from "@/lib/api/types";
import { formatCount, formatPaiseCompact } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Live counters from the API (cached a minute). When the API is down the
 * strip is simply left out rather than showing made-up numbers. The headline
 * is the count of verified records; the value counts only shares with the
 * IEPF, due for transfer or in suspense (once per folio) and the unclaimed
 * amounts listed, never the shares behind an unclaimed dividend.
 */
export async function LiveCounters({ className }: { className?: string }) {
  const stats = await apiOrNull<Stats>("stats", { revalidate: 60 });
  // Before the first statement is imported there is nothing honest to count.
  if (!stats || stats.folios === 0) return null;
  const withRecords = stats.companiesWithRecords ?? null;
  const records = stats.verifiedRecords ?? stats.holderRecords ?? stats.folios;
  const value = stats.recoverableValuePaise ?? stats.estimatedValuePaise;
  const items = [
    {
      Icon: DatabaseIcon,
      value: `${formatCount(records)}+`,
      label: "Verified Records",
      headline: true,
    },
    {
      Icon: Building2Icon,
      value: withRecords === null ? "—" : formatCount(withRecords),
      label: withRecords === 1 ? "Company with records" : "Companies with records",
    },
    {
      Icon: IndianRupeeIcon,
      value: formatPaiseCompact(value),
      label: "IEPF & unclaimed value (est.)",
    },
    { Icon: MapPinnedIcon, value: formatCount(stats.states), label: "States & territories" },
  ];
  return (
    <div className={className}>
      <dl className="vault-glass grid grid-cols-2 gap-x-6 gap-y-4 rounded-[20px] p-4 sm:p-5 lg:grid-cols-4">
        {items.map(({ Icon, value, label, headline }) => (
          <div key={label} className="min-w-0">
            <dt className="sr-only">{label}</dt>
            <dd
              className={cn(
                "flex items-center gap-2 font-semibold text-fg tnum [font-stretch:104%]",
                headline ? "text-2xl" : "text-xl",
              )}
            >
              <Icon className="size-4 shrink-0 text-signal" aria-hidden="true" />
              {value}
            </dd>
            <dd aria-hidden="true" className="mt-0.5 text-sm leading-snug text-balance text-fg-3">
              {label}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 max-w-[90ch] text-sm text-fg-3">
        Records come from statements companies publish; one person can appear in several records,
        and most companies are not covered yet. The value counts shares with the IEPF, due for
        transfer or in a suspense account, once per folio, plus the unclaimed amounts listed, never
        the shares behind an unclaimed dividend.
      </p>
    </div>
  );
}
