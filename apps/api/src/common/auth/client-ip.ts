import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import type { NextFunction, Request, Response } from "express";

import { clientIp, type AuthedRequest } from "./decorators.js";

export const PROXY_KEY_HEADER = "x-finsol-proxy-key";
export const CLIENT_IP_HEADER = "x-finsol-client-ip";

const digest = (v: string) => createHash("sha256").update(v).digest();

/**
 * Browsers reach the API through the website's server, so the connecting
 * address is the website's for every visitor. The website's server sends the
 * shared secret with the visitor's address; only then is that address used.
 * Anyone else sending the header is ignored and keeps their own address.
 */
export function vouchedClientIp(req: Request, secret: string | undefined): string | undefined {
  if (!secret) return undefined;
  const key = req.headers[PROXY_KEY_HEADER];
  const ip = req.headers[CLIENT_IP_HEADER];
  if (typeof key !== "string" || typeof ip !== "string") return undefined;
  if (!timingSafeEqual(digest(key), digest(secret))) return undefined;
  const trimmed = ip.trim();
  return isIP(trimmed) ? trimmed : undefined;
}

export function clientIpMiddleware(secret: string | undefined) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const ip = vouchedClientIp(req, secret);
    if (ip) (req as AuthedRequest).clientIp = ip;
    next();
  };
}

/** Rate limits count per visitor, using the vouched address when there is one. */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    return clientIp(req as unknown as Request) ?? "unknown";
  }
}
