"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { CheckCircle2Icon, ChevronRightIcon, FileSearchIcon, ShieldCheckIcon } from "lucide-react";
import {
  ContactFields,
  contactProblem,
  EMPTY_CONTACT,
  trimmed,
  useIntakeStatus,
  type Contact,
} from "@/components/auth/contact-fields";
import { LoginForm } from "@/components/auth/login-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { callApi } from "@/lib/api/client";

export function DeeperTrace({
  holderName,
  scope,
  signedIn,
}: {
  holderName: string;
  scope: string;
  signedIn: boolean;
}) {
  const [step, setStep] = useState<1 | 2>(1);

  // Step 1: Investor & Asset Clues
  const [investorName, setInvestorName] = useState(holderName || "");
  const [companies, setCompanies] = useState("");
  const [years, setYears] = useState("");
  const [oldAddress, setOldAddress] = useState("");
  const [oldCity, setOldCity] = useState("");
  const [certificateStatus, setCertificateStatus] = useState<
    "UNKNOWN" | "AVAILABLE" | "LOST" | "PARTIAL"
  >("UNKNOWN");

  // Step 2: the claimant. Contact details are the signed-in account's: its
  // mobile number was verified with a one-time code at sign-in.
  const [relationship, setRelationship] = useState<
    "SELF" | "FAMILY" | "AUTHORISED_REPRESENTATIVE" | "LEGAL_HEIR"
  >("SELF");
  const [isSignedIn, setIsSignedIn] = useState(signedIn);
  const [consent, setConsent] = useState(false);
  // While sign-in codes cannot be texted, a visitor leaves name, mobile and
  // email instead; the request is marked for a verification call.
  const intake = useIntakeStatus();
  const guest = !isSignedIn && intake?.guestTrace === true;
  const [contact, setContact] = useState<Contact>(EMPTY_CONTACT);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{
    id: string;
    reference: string;
    status: string;
    guest?: boolean;
  } | null>(null);

  const requestId = useRef<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!consent) {
      setError("Please provide authorization consent to proceed with archival trace.");
      return;
    }

    if (guest) {
      const problem = contactProblem(contact);
      if (problem) {
        setError(problem);
        return;
      }
    }

    setBusy(true);
    setError("");
    requestId.current ??= crypto.randomUUID();

    try {
      const res = await callApi<{ id: string; reference: string; status: string }>(
        guest ? "traces/guest" : "traces",
        {
          body: {
            ...(guest ? { contact: trimmed(contact) } : {}),
            requestId: requestId.current,
            holderName: investorName || holderName,
            scope: scope || "ALL_INDIA",
            relationship,
            oldCity: oldCity || undefined,
            oldAddress: oldAddress || undefined,
            certificateStatus,
            companies: companies || undefined,
            years: years || undefined,
            consent: true,
          },
        },
      );
      setDone({ ...res, guest });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    if (!done || busy) return;
    setBusy(true);
    setError("");
    try {
      await callApi(`traces/${done.id}/withdraw`, { body: {} });
      setDone({ ...done, status: "WITHDRAWN" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-2xl text-left">
      {error && (
        <div
          role="alert"
          className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive border border-destructive/20"
        >
          {error}
        </div>
      )}

      {done ? (
        <div
          role="status"
          className="rounded-xl border border-primary/20 bg-primary/5 p-6 shadow-sm"
        >
          <div className="flex items-center gap-3 mb-4">
            <span className="flex size-10 items-center justify-center rounded-full bg-primary/20 text-primary">
              <ShieldCheckIcon className="size-6" />
            </span>
            <div>
              <h3 className="text-xl font-bold text-fg">
                {done.status === "WITHDRAWN"
                  ? "Archival Trace Withdrawn"
                  : "Archival RTA Trace Queued"}
              </h3>
              <p className="text-sm text-fg-3">
                Tracking Reference:{" "}
                <span className="font-mono font-bold text-primary">{done.reference}</span>
              </p>
            </div>
          </div>

          <div className="rounded-lg bg-card p-4 border border-border space-y-2 mb-4">
            <div className="flex justify-between items-center text-sm">
              <span className="text-fg-3">Audit Status:</span>
              <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2.5 py-0.5 text-xs font-semibold text-amber-600">
                Pending Audit
              </span>
            </div>
            <div className="flex justify-between items-center text-sm">
              <span className="text-fg-3">Investor Name:</span>
              <span className="font-medium text-fg">{investorName}</span>
            </div>
            {companies && (
              <div className="flex justify-between items-center text-sm">
                <span className="text-fg-3">Suspected Companies:</span>
                <span className="font-medium text-fg">{companies}</span>
              </div>
            )}
          </div>

          {done.guest ? (
            <p className="text-sm text-fg-2 mb-5 leading-relaxed" data-testid="trace-guest-note">
              Keep this reference. A Finsol Enterprises analyst will first call{" "}
              <span className="tnum font-medium text-fg">{contact.phone.trim()}</span> to verify
              your number (status: pending call verification), then check the company and registrar
              records we are authorised to search and record each source against this reference.
            </p>
          ) : (
            <p className="text-sm text-fg-2 mb-5 leading-relaxed">
              A Finsol Enterprises analyst will check the company and registrar records we are
              authorised to search, and record each source checked against this reference. We will
              contact you on your verified mobile number or email with what we find.
            </p>
          )}

          {!done.guest && (
            <div className="flex flex-wrap items-center gap-3">
              <Button asChild variant="default" size="sm">
                <Link href="/traces">View My Trace Requests</Link>
              </Button>
              {done.status !== "WITHDRAWN" && (
                <Button variant="outline" size="sm" disabled={busy} onClick={withdraw}>
                  Withdraw request
                </Button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          {/* Step Indicator Header */}
          <div className="mb-6 flex items-center justify-between border-b border-border pb-4">
            <div className="flex items-center gap-2">
              <FileSearchIcon className="size-5 text-primary" />
              <h3 className="font-semibold text-fg">Deeper Archival Trace Gateway</h3>
            </div>
            <div className="flex items-center gap-1 text-xs font-medium text-fg-3">
              <span
                className={`px-2 py-1 rounded ${step === 1 ? "bg-primary text-primary-foreground font-bold" : "bg-muted"}`}
              >
                Step 1: Clues
              </span>
              <ChevronRightIcon className="size-3" />
              <span
                className={`px-2 py-1 rounded ${step === 2 ? "bg-primary text-primary-foreground font-bold" : "bg-muted"}`}
              >
                Step 2: You
              </span>
            </div>
          </div>

          {step === 1 ? (
            <div className="space-y-4">
              <div>
                <label htmlFor="trace-investor" className="block text-sm font-medium text-fg mb-1">
                  Deceased / Investor Full Name
                </label>
                <Input
                  id="trace-investor"
                  value={investorName}
                  onChange={(e) => setInvestorName(e.target.value)}
                  placeholder="Full name as printed on share certificates"
                  required
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="trace-companies"
                    className="block text-sm font-medium text-fg mb-1"
                  >
                    Suspected Companies
                  </label>
                  <Input
                    id="trace-companies"
                    value={companies}
                    onChange={(e) => setCompanies(e.target.value)}
                    placeholder="e.g. Reliance, Tata Motors, L&T, HUL"
                  />
                </div>
                <div>
                  <label htmlFor="trace-years" className="block text-sm font-medium text-fg mb-1">
                    Approximate Investment Years
                  </label>
                  <Input
                    id="trace-years"
                    value={years}
                    onChange={(e) => setYears(e.target.value)}
                    placeholder="e.g. 1985 - 2005"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="trace-address" className="block text-sm font-medium text-fg mb-1">
                  Known Addresses or Old Cities / States
                </label>
                <Input
                  id="trace-address"
                  value={oldAddress}
                  onChange={(e) => {
                    setOldAddress(e.target.value);
                    if (!oldCity) setOldCity(e.target.value.split(",")[0] ?? "");
                  }}
                  placeholder="e.g. 14 Station Road, Bandra West, Mumbai 400050"
                />
              </div>

              <div>
                <label
                  htmlFor="trace-certificates"
                  className="block text-sm font-medium text-fg mb-1"
                >
                  Physical Share Certificate Status
                </label>
                <Select
                  id="trace-certificates"
                  value={certificateStatus}
                  onChange={(e) => setCertificateStatus(e.target.value as typeof certificateStatus)}
                >
                  <option value="UNKNOWN">Uncertain / Not sure</option>
                  <option value="AVAILABLE">Physical certificates available in hand</option>
                  <option value="LOST">Lost, misplaced, or destroyed</option>
                  <option value="PARTIAL">Partial certificates found</option>
                </Select>
                <p className="mt-1 text-xs text-fg-3">
                  Lost certificates do not rule out a recovery. Tell us what you know.
                </p>
              </div>

              <div className="pt-2 flex justify-end">
                <Button
                  type="button"
                  onClick={() => {
                    if (!investorName.trim()) {
                      setError("Please provide the investor full name.");
                      return;
                    }
                    setError("");
                    setStep(2);
                  }}
                  className="gap-2"
                >
                  Continue
                  <ChevronRightIcon className="size-4" />
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Claimant contact: the Login Gateway (name, mobile verified by OTP, email). Kept outside the trace form. */}
              {guest && (
                <div className="rounded-lg border border-border bg-muted/30 p-4">
                  <p className="mb-3 text-sm text-fg-2">
                    Your contact details. We can&apos;t text sign-in codes right now, so a Finsol
                    analyst will call this number to verify it before any search starts.
                  </p>
                  <ContactFields value={contact} onChange={setContact} idPrefix="trace-c" />
                </div>
              )}
              {!isSignedIn && !guest && (
                <div className="rounded-lg border border-border bg-muted/30 p-4">
                  <p className="mb-3 text-sm text-fg-2">
                    Sign in with your name, mobile number and email. We send a 6-digit code to
                    verify the mobile number before the request is recorded.
                  </p>
                  <LoginForm idPrefix="trace" onSignedIn={() => setIsSignedIn(true)} />
                </div>
              )}
              <form onSubmit={submit} className="space-y-4">
                <div>
                  <label
                    htmlFor="trace-relationship"
                    className="block text-sm font-medium text-fg mb-1"
                  >
                    Your relationship to the investor
                  </label>
                  <Select
                    id="trace-relationship"
                    value={relationship}
                    onChange={(e) => setRelationship(e.target.value as typeof relationship)}
                    required
                  >
                    <option value="SELF">I am the investor</option>
                    <option value="LEGAL_HEIR">Legal heir (son, daughter or spouse)</option>
                    <option value="FAMILY">Other family member</option>
                    <option value="AUTHORISED_REPRESENTATIVE">Authorised representative</option>
                  </Select>
                </div>

                {isSignedIn && (
                  <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-4 text-sm text-fg-2">
                    <CheckCircle2Icon
                      className="mt-0.5 size-4 shrink-0 text-emerald-600"
                      aria-hidden="true"
                    />
                    We will contact you on the mobile number verified when you signed in, and the
                    email on your account.
                  </p>
                )}

                {/* Consent Checkbox */}
                <label className="flex items-start gap-3 rounded-md bg-muted/20 p-3 border border-border/50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                    required
                    className="mt-1 size-4 rounded border-border text-primary shrink-0"
                  />
                  <span className="text-xs text-fg-2 leading-relaxed">
                    I am the investor, a legal heir or family member, or an authorised
                    representative, and I authorise Finsol Enterprises to search company and
                    registrar records for this investor on my behalf. These details are stored
                    encrypted and are read only by Finsol staff working on this request.
                  </span>
                </label>

                <div className="pt-2 flex items-center justify-between">
                  <Button type="button" variant="ghost" onClick={() => setStep(1)} disabled={busy}>
                    ← Back to Clues
                  </Button>

                  <Button
                    type="submit"
                    disabled={busy || !consent || (!isSignedIn && !guest)}
                    className="gap-2"
                  >
                    {busy ? "Submitting Trace Request…" : "Submit Archival Trace Request"}
                    <ShieldCheckIcon className="size-4" />
                  </Button>
                </div>
              </form>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
