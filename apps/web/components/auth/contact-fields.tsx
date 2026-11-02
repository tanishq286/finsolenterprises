"use client";

import * as React from "react";
import Link from "next/link";
import {
  CheckCircle2Icon,
  FileSearchIcon,
  FileTextIcon,
  LoaderCircleIcon,
  PhoneCallIcon,
  SearchIcon,
} from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { callApi } from "@/lib/api/client";

export interface Contact {
  name: string;
  phone: string;
  email: string;
}

export const EMPTY_CONTACT: Contact = { name: "", phone: "", email: "" };

export interface IntakeStatus {
  smsSignIn: boolean;
  guestDossier: boolean;
  guestTrace: boolean;
  callback: boolean;
}

/** Which flows work without a sign-in code right now; null while loading or if unknown. */
export function useIntakeStatus(): IntakeStatus | null {
  const [status, setStatus] = React.useState<IntakeStatus | null>(null);
  React.useEffect(() => {
    let live = true;
    callApi<IntakeStatus>("intake/status")
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, []);
  return status;
}

/** Mirrors the API: a 10-digit Indian mobile, optionally with +91 / 0 and spaces. */
export function looksLikeIndianMobile(raw: string): boolean {
  const digits = raw.replace(/[\s()-]/g, "").replace(/^(\+91|91|0)(?=\d{10}$)/, "");
  return /^[6-9]\d{9}$/.test(digits);
}

/** Client-side check before sending; the API checks again. */
export function contactProblem(c: Contact): string | null {
  if (c.name.trim().length < 2) return "Enter your full name.";
  if (!looksLikeIndianMobile(c.phone)) return "Enter a 10-digit Indian mobile number.";
  if (!/^\S+@\S+\.\S+$/.test(c.email.trim())) return "Enter a valid email address.";
  return null;
}

export const trimmed = (c: Contact): Contact => ({
  name: c.name.trim(),
  phone: c.phone.trim(),
  email: c.email.trim(),
});

/** Name, mobile and email, kept as typed. */
export function ContactFields({
  value,
  onChange,
  idPrefix,
}: {
  value: Contact;
  onChange: (next: Contact) => void;
  idPrefix: string;
}) {
  const id = (k: string) => `${idPrefix}-${k}`;
  const set = (k: keyof Contact, v: string) => onChange({ ...value, [k]: v });
  return (
    <div className="grid gap-4">
      <div>
        <label htmlFor={id("name")} className="mb-1.5 block text-sm text-fg-2">
          Full name *
        </label>
        <Input
          id={id("name")}
          required
          minLength={2}
          maxLength={120}
          autoComplete="name"
          value={value.name}
          onChange={(e) => set("name", e.target.value)}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={id("phone")} className="mb-1.5 block text-sm text-fg-2">
            Mobile number *
          </label>
          <Input
            id={id("phone")}
            required
            inputMode="tel"
            autoComplete="tel-national"
            placeholder="98765 43210"
            value={value.phone}
            onChange={(e) => set("phone", e.target.value)}
            className="tnum"
          />
        </div>
        <div>
          <label htmlFor={id("email")} className="mb-1.5 block text-sm text-fg-2">
            Email *
          </label>
          <Input
            id={id("email")}
            required
            type="email"
            autoComplete="email"
            maxLength={200}
            value={value.email}
            onChange={(e) => set("email", e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}

/** A consent checkbox in the site's style. */
export function ConsentBox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-[10px] border border-line bg-white/60 p-3">
      <input
        type="checkbox"
        required
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-(--color-signal)"
      />
      <span className="text-sm text-fg-2">{children}</span>
    </label>
  );
}

/**
 * What the Login Gateway shows while sign-in codes cannot be texted: the
 * things that need no sign-in, and a request for a verification call. Nobody
 * is signed in without a verified number.
 */
export function SignInFallback({ message }: { message: string }) {
  const [contact, setContact] = React.useState<Contact>(EMPTY_CONTACT);
  const [consent, setConsent] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const problem = contactProblem(contact);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await callApi("intake/callback", { body: { contact: trimmed(contact), consent: true } });
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const routes = [
    { href: "/calculator", Icon: FileTextIcon, label: "Download a Valuation Dossier" },
    { href: "/deeper-trace", Icon: FileSearchIcon, label: "Request a Deeper Trace" },
    { href: "/search", Icon: SearchIcon, label: "Run the free 3-Minute Check" },
  ];
  return (
    <div data-testid="otp-paused" className="grid gap-5">
      <p className="text-sm text-fg-2">{message}</p>
      <div>
        <p className="mb-2 text-sm font-medium text-fg">No sign-in needed for these:</p>
        <ul className="grid gap-2">
          {routes.map(({ href, Icon, label }) => (
            <li key={href}>
              <Link
                href={href}
                className="flex items-center gap-2.5 rounded-[10px] border border-line bg-white/70 px-3 py-2.5 text-sm text-fg hover:border-signal"
              >
                <Icon className="size-4 shrink-0 text-signal" aria-hidden="true" />
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
      <div className="border-t border-(--glass-border) pt-5">
        <p className="flex items-center gap-2 font-medium text-fg">
          <PhoneCallIcon className="size-4 text-signal" aria-hidden="true" />
          Open your account with a verification call
        </p>
        <p className="mt-1 text-sm text-fg-3">
          Leave your details and a Finsol analyst calls you to confirm your number, usually within
          one working day.
        </p>
        {sent ? (
          <Alert variant="confirmed" role="status" className="mt-4">
            <CheckCircle2Icon aria-hidden="true" />
            <AlertDescription>
              Thank you. We will call {contact.phone.trim()} to verify your number.
            </AlertDescription>
          </Alert>
        ) : (
          <form onSubmit={submit} className="mt-4 grid gap-4" noValidate>
            {error && (
              <Alert variant="blocker" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <ContactFields value={contact} onChange={setContact} idPrefix="cb" />
            <ConsentBox checked={consent} onChange={setConsent}>
              Finsol Enterprises may call and email me about my holdings.
            </ConsentBox>
            <Button type="submit" size="lg" disabled={busy || !consent}>
              {busy ? (
                <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
              ) : (
                <PhoneCallIcon aria-hidden="true" />
              )}
              Request a verification call
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
