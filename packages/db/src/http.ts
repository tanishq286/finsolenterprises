/**
 * Outbound HTTP for the IEPF tools. Requests identify themselves honestly
 * (no browser impersonation), respect robots.txt, time out, and cap size.
 */
export const USER_AGENT =
  process.env.FETCH_USER_AGENT ??
  "FinsolEnterprises-IEPF-Fetcher/0.3 (+https://finsolenterprises.com/bot; collects public IEPF statutory statements)";

const MAX_BYTES = 40 * 1024 * 1024;

export async function fetchBuffer(
  url: string,
  timeoutMs = 60_000,
): Promise<{ buffer: Buffer; contentType: string | null; finalUrl: string }> {
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}.`);
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) throw new Error(`${url} is larger than ${MAX_BYTES / 1024 / 1024} MB.`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_BYTES)
    throw new Error(`${url} is larger than ${MAX_BYTES / 1024 / 1024} MB.`);
  return { buffer, contentType: res.headers.get("content-type"), finalUrl: res.url };
}

const robotsCache = new Map<string, { disallow: string[]; allow: string[] } | null>();

/** Minimal robots.txt check for our user agent or "*". Unreadable robots files allow nothing to be assumed: they count as no rules. */
export async function robotsAllows(url: string): Promise<boolean> {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    let rules: { disallow: string[]; allow: string[] } | null = null;
    try {
      const res = await fetch(`${u.origin}/robots.txt`, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
      const type = res.headers.get("content-type") ?? "";
      // Always settle the body: an unread body can crash undici when the server hangs up.
      if (!(res.ok && type.includes("text/plain"))) await res.body?.cancel().catch(() => {});
      if (res.ok && type.includes("text/plain")) {
        rules = { disallow: [], allow: [] };
        let applies = false;
        for (const line of (await res.text()).split(/\r?\n/)) {
          const [k, ...rest] = line.split(":");
          const key = k?.trim().toLowerCase();
          const value = rest.join(":").trim();
          if (key === "user-agent")
            applies = value === "*" || USER_AGENT.toLowerCase().includes(value.toLowerCase());
          else if (applies && key === "disallow" && value) rules.disallow.push(value);
          else if (applies && key === "allow" && value) rules.allow.push(value);
        }
      }
    } catch {
      rules = null;
    }
    robotsCache.set(u.origin, rules);
  }
  const rules = robotsCache.get(u.origin);
  if (!rules) return true;
  const path = u.pathname + u.search;
  const longest = (list: string[]) =>
    Math.max(-1, ...list.filter((p) => path.startsWith(p)).map((p) => p.length));
  return longest(rules.allow) >= longest(rules.disallow);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
