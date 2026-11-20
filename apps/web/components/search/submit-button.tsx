"use client";

import { useFormStatus } from "react-dom";
import { LoaderCircleIcon, SearchIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/** The 3-Minute Check button: a spinner and disabled while the results page loads. */
export function SearchSubmitButton({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending} aria-busy={pending} className={className}>
      {pending ? (
        <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
      ) : (
        <SearchIcon aria-hidden="true" />
      )}
      {pending ? "Checking…" : children}
    </Button>
  );
}
