/**
 * Polite outbound HTTP for acquisition: an honest user agent, robots.txt,
 * at most one request per host every few seconds, conditional requests for
 * change detection, size and time limits. No browser impersonation, no
 * cookies replayed, no CAPTCHA or login handling: a refusal is recorded, not
 * worked around.
 */
import { robotsAllows, USER_AGENT } from "../http.js";

const MAX_BYTES = 40 * 1024 * 1024;
const lastHit = new Map<string, number>();

export const HOST_GAP_MS = Number(process.env.ACQUIRE_HOST_GAP_MS ?? 2500);

async function throttle(host: string) {
  for (;;) {
    const wait = (lastHit.get(host) ?? 0) + HOST_GAP_MS - Date.now();
    if (wait <= 0) break;
    await new Promise((r) => setTimeout(r, wait));
  }
  lastHit.set(host, Date.now());
}

export type FetchOutcome =
  | {
      kind: "ok";
      status: number;
      body: Buffer;
      contentType: string | null;
      finalUrl: string;
      etag: string | null;
      lastModified: string | null;
    }
  | { kind: "not-modified" }
  | { kind: "robots" }
  | { kind: "blocked"; status: number }
  | { kind: "http-error"; status: number }
  | { kind: "timeout"; message: string }
  | { kind: "too-large" }
  | { kind: "network"; message: string };

export async function politeGet(
  url: string,
  opts: { etag?: string | null; lastModified?: string | null; timeoutMs?: number } = {},
): Promise<FetchOutcome> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { kind: "network", message: "Not a valid URL." };
  }
  if (!(await robotsAllows(url))) return { kind: "robots" };
  await throttle(u.host);
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        accept:
          "text/html,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,*/*;q=0.5",
        ...(opts.etag ? { "if-none-match": opts.etag } : {}),
        ...(opts.lastModified ? { "if-modified-since": opts.lastModified } : {}),
      },
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 45_000),
    });
    const drop = () => res.body?.cancel().catch(() => {});
    if (res.status === 304) {
      await drop();
      return { kind: "not-modified" };
    }
    // 401/403/429 and challenge pages are access controls: recorded, never bypassed.
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      await drop();
      return { kind: "blocked", status: res.status };
    }
    if (!res.ok) {
      await drop();
      return { kind: "http-error", status: res.status };
    }
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) {
      await drop();
      return { kind: "too-large" };
    }
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > MAX_BYTES) return { kind: "too-large" };
    const type = res.headers.get("content-type");
    // A challenge interstitial, not a page that merely embeds a form CAPTCHA.
    const head = type?.includes("html") ? body.subarray(0, 20000).toString("utf8") : "";
    if (
      /cf-chl|challenge-platform|__cf_chl_opt|<title>Just a Moment\.\.\.<\/title>|<title>Attention Required!<\/title>|ray id:[0-9a-f]+|waf-block|perimeterx/i.test(
        head,
      ) ||
      ((res.status === 401 || res.status === 403 || res.status === 429) && /captcha/i.test(head))
    )
      return { kind: "blocked", status: res.status };
    return {
      kind: "ok",
      status: res.status,
      body,
      contentType: type,
      finalUrl: res.url,
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
    };
  } catch (e) {
    const err = e as Error;
    const msg = err.message || "";
    if (err.name === "TimeoutError" || /timeout|aborted/i.test(msg)) {
      return { kind: "timeout", message: msg.slice(0, 200) };
    }
    return { kind: "network", message: msg.slice(0, 200) };
  }
}
