import { createParamDecorator, SetMetadata, type ExecutionContext } from "@nestjs/common";
import type { Role } from "@finsol/shared";
import type { Request } from "express";

import type { SessionClaims } from "./tokens.service.js";

export const IS_PUBLIC = "finsol:public";
export const ROLES = "finsol:roles";

/** No session needed. A valid session, if sent, is still attached to the request. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Only these roles may call the route (SUPER_ADMIN always may). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export interface AuthedRequest extends Request {
  user?: SessionClaims;
  rawBody?: Buffer;
  /** The visitor's address, when the website's server vouched for it (see client-ip.ts). */
  clientIp?: string;
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().user;
});

export function clientIp(req: Request): string | null {
  return (req as AuthedRequest).clientIp ?? req.ip ?? req.socket?.remoteAddress ?? null;
}
