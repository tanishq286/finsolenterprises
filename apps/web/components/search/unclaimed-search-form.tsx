import Form from "next/form";
import { LockIcon, PlusIcon } from "lucide-react";
import type { SearchScope } from "@finsol/shared";

import { Input } from "@/components/ui/input";
import { SearchSubmitButton } from "@/components/search/submit-button";
import { Select } from "@/components/ui/select";
import { StateOptions } from "@/components/search/state-options";
import { CHECK_CTA } from "@/components/site/cta";
import { cn } from "@/lib/utils";

export interface SearchDefaults {
  name?: string;
  jointHolder?: string;
  state?: SearchScope | "";
}

/**
 * The 3-Minute Check: a name and a state, nothing else. No folio, PAN or
 * certificate number; people rarely have them. A plain GET form to /search,
 * so it works without JavaScript (the joint holder field is a <details>).
 */
export function UnclaimedSearchForm({
  defaults = {},
  className,
  compact = false,
}: {
  defaults?: SearchDefaults;
  className?: string;
  compact?: boolean;
}) {
  const id = compact ? "s-compact" : "s";
  return (
    <Form
      action="/search"
      aria-label="Start the 3-Minute Check"
      className={cn("vault-glass relative rounded-[20px] p-4 sm:p-5", className)}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-6 top-0 h-px bg-(image:--specular)"
      />
      <div className="@container">
        <div className="grid gap-3 @[34rem]:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div>
            <label htmlFor={`${id}-name`} className="mb-1.5 block text-sm text-fg-2">
              Investor / Family Member Name *
            </label>
            <Input
              id={`${id}-name`}
              name="name"
              required
              minLength={2}
              defaultValue={defaults.name}
              autoComplete="off"
              maxLength={120}
              placeholder="e.g. Ramesh Kumar Agarwal"
            />
          </div>
          <div>
            <label htmlFor={`${id}-state`} className="mb-1.5 block text-sm text-fg-2">
              State *
            </label>
            <Select id={`${id}-state`} name="state" required defaultValue={defaults.state ?? ""}>
              <StateOptions allIndia />
            </Select>
          </div>
        </div>
        <details className="group mt-3" open={!!defaults.jointHolder}>
          <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-md text-sm font-medium text-fg-2 hover:text-fg [&::-webkit-details-marker]:hidden">
            <PlusIcon
              className="size-4 transition-transform group-open:rotate-45"
              aria-hidden="true"
            />
            Add Joint Holder
          </summary>
          <div className="mt-1">
            <label htmlFor={`${id}-joint`} className="mb-1.5 block text-sm text-fg-2">
              Joint holder&apos;s name (optional)
            </label>
            <Input
              id={`${id}-joint`}
              name="joint"
              defaultValue={defaults.jointHolder}
              autoComplete="off"
              maxLength={120}
            />
          </div>
        </details>
        <SearchSubmitButton className="sheen mt-3 min-h-12 w-full @[34rem]:w-auto">
          {CHECK_CTA}
        </SearchSubmitButton>
      </div>
      <p className="mt-3 flex items-start gap-1.5 text-sm text-fg-3">
        <LockIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        No folio number, PAN or certificate needed. Spellings such as Agarwal, Agrawal and Aggarwal
        are matched together.
      </p>
    </Form>
  );
}
