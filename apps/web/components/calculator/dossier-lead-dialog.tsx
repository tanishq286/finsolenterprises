"use client";

import * as React from "react";
import { DownloadIcon, FileTextIcon, LoaderCircleIcon } from "lucide-react";

import {
  ConsentBox,
  ContactFields,
  contactProblem,
  EMPTY_CONTACT,
  trimmed,
  useIntakeStatus,
  type Contact,
} from "@/components/auth/contact-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

/**
 * The Valuation Dossier without a sign-in code: name, mobile and email, which
 * the team confirms by phone. Signing in stays available when codes can be texted.
 */
export function DossierLeadDialog({
  open,
  onOpenChange,
  busy,
  message,
  onSubmit,
  onSignIn,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  /** The last download message, shown when a request fails. */
  message: string | null;
  onSubmit: (contact: Contact) => Promise<void>;
  onSignIn: () => void;
}) {
  const [contact, setContact] = React.useState<Contact>(EMPTY_CONTACT);
  const [consent, setConsent] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [tried, setTried] = React.useState(false);
  const intake = useIntakeStatus();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const p = contactProblem(contact);
    setProblem(p);
    if (p) return;
    setTried(true);
    await onSubmit(trimmed(contact));
  }

  const error = problem ?? (tried && !busy ? message : null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle className="flex items-center gap-2">
          <FileTextIcon className="size-5 text-signal" aria-hidden="true" />
          Get your Valuation Dossier
        </DialogTitle>
        <DialogDescription>
          Tell us where to reach you and the PDF downloads straight away. No code needed: a Finsol
          analyst confirms your number by phone before any work starts.
        </DialogDescription>
        <form onSubmit={submit} className="mt-5 grid gap-4" noValidate>
          {error && (
            <Alert variant="blocker" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <ContactFields value={contact} onChange={setContact} idPrefix="dl" />
          <ConsentBox checked={consent} onChange={setConsent}>
            Finsol Enterprises may call and email me about this report and my holdings.
          </ConsentBox>
          <Button type="submit" size="lg" disabled={busy || !consent}>
            {busy ? (
              <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
            ) : (
              <DownloadIcon aria-hidden="true" />
            )}
            Download Valuation Dossier
          </Button>
          {intake?.smsSignIn && (
            <button
              type="button"
              className="link justify-self-start text-sm text-fg-2"
              onClick={onSignIn}
            >
              I have an account: sign in instead
            </button>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
