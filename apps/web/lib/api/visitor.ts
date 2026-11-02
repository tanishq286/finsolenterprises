import "server-only";

import { isIP } from "node:net";

/**
 * Tells the API which visitor a server-side request is for, so its
 * per-visitor rate limits count visitors rather than this server. The API
 * believes the address only with the shared FINSOL_PROXY_SECRET; without the
 * secret nothing is sent and the API counts this server's address, as before.
 * On Vercel, x-real-ip and x-forwarded-for are set by the platform itself.
 */
export function visitorHeaders(incoming: Headers): Record<string, string> {
  const secret = process.env.FINSOL_PROXY_SECRET;
  if (!secret) return {};
  const ip = (
    incoming.get("x-real-ip") ??
    incoming.get("x-forwarded-for")?.split(",")[0] ??
    ""
  ).trim();
  if (!isIP(ip)) return {};
  return { "x-finsol-proxy-key": secret, "x-finsol-client-ip": ip };
}
