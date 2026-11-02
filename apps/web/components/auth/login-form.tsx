"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { KeyRoundIcon, LoaderCircleIcon, ShieldCheckIcon } from "lucide-react";
import type { Role } from "@finsol/shared";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { homeFor } from "@/components/auth/account-link";
import { SignInFallback } from "@/components/auth/contact-fields";
import { callApi } from "@/lib/api/client";

/**
 * The Finsol Enterprises Login Gateway: full name, mobile (verified with a
 * 6-digit code typed here) and email. On the login page it goes to the
 * visitor's home; inside the gateway modal it calls `onSignedIn` instead.
 */
export function LoginForm({
  next,
  onSignedIn,
  idPrefix = "l",
}: {
  next?: string;
  onSignedIn?: () => void;
  idPrefix?: string;
}) {
  const router = useRouter();
  const [form, setForm] = React.useState({ name: "", phone: "", email: "", code: "" });
  const [sent, setSent] = React.useState(false);
  /** null while checking; a message when sign-in codes cannot be delivered. */
  const [paused, setPaused] = React.useState<string | null | undefined>(undefined);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  React.useEffect(() => {
    let live = true;
    callApi<{ available: boolean; message: string | null }>("auth/otp/status")
      .then((s) => live && setPaused(s.available ? null : (s.message ?? "Sign-in is paused.")))
      // If the check itself fails, let the request show the real error.
      .catch(() => live && setPaused(null));
    return () => {
      live = false;
    };
  }, []);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await callApi("auth/otp/request", { body: { phone: form.phone, purpose: "LOGIN" } });
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await callApi<{ user: { role: Role } }>("auth/otp/verify", {
        body: {
          phone: form.phone,
          code: form.code,
          name: form.name.trim(),
          email: form.email.trim(),
        },
      });
      if (onSignedIn) {
        onSignedIn();
        router.refresh();
        return;
      }
      // Only same-site paths are followed after sign-in.
      const target =
        next && /^\/(?![/\\])/.test(next) && !next.includes("\\") ? next : homeFor(res.user.role);
      router.push(target);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const id = (k: string) => `${idPrefix}-${k}`;
  return (
    <div>
      {error && (
        <Alert variant="blocker" role="alert" className="mb-5">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {paused ? (
        <SignInFallback message="Sign-in codes by SMS are switched off while our SMS sender registration completes. Everything else works, and our team can verify your number by phone." />
      ) : !sent ? (
        <form onSubmit={send} className="grid gap-4" aria-busy={paused === undefined}>
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
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </div>
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
              value={form.phone}
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
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
            />
          </div>
          <Button type="submit" size="lg" disabled={busy || paused === undefined}>
            {busy ? (
              <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
            ) : (
              <KeyRoundIcon aria-hidden="true" />
            )}
            Send me a code
          </Button>
        </form>
      ) : (
        <form onSubmit={verify} className="grid gap-4">
          <div>
            <label htmlFor={id("code")} className="mb-1.5 block text-sm text-fg-2">
              6-digit code sent to {form.phone}
            </label>
            <Input
              id={id("code")}
              required
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={form.code}
              onChange={(e) => set("code", e.target.value.replace(/\D/g, ""))}
              className="tnum text-center font-mono text-2xl tracking-[0.5em]"
            />
          </div>
          <Button type="submit" size="lg" disabled={busy || form.code.length !== 6}>
            {busy && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
            Verify and sign in
          </Button>
          <button
            type="button"
            className="link justify-self-start text-sm text-fg-2"
            onClick={() => setSent(false)}
          >
            Change my details
          </button>
        </form>
      )}
      <p className="mt-5 flex items-start gap-2 border-t border-(--glass-border) pt-4 text-sm text-fg-3">
        <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-signal" aria-hidden="true" />
        <span>
          Type the code only into this page. We never ask for it by phone, WhatsApp or email. We use
          your details only to handle your request; see our{" "}
          <Link href="/privacy" className="link">
            privacy notice
          </Link>{" "}
          and{" "}
          <Link href="/terms" className="link">
            terms
          </Link>
          .
        </span>
      </p>
    </div>
  );
}
