import { NextResponse, type NextRequest } from "next/server";

import { API_URL, SESSION_COOKIE, WHO_COOKIE } from "@/lib/api/config";

/**
 * Backend-for-frontend: the browser calls /api/v1/*, this handler adds the
 * httpOnly session cookie as a header and forwards to the API. Sign-in
 * responses have their token moved into the cookie, so the browser never
 * sees a token. Only listed API areas are reachable.
 */
const ALLOWED =
  /^(auth\/(otp\/request|otp\/verify|otp\/status|me)|search\/(unclaimed|claim|live\/[0-9a-f-]{36})|companies(\/.*)?|market\/(prices|equities(\/.*)?)|valuation\/report|stats|cases(\/.*)?|traces(\/[0-9a-f-]{36}\/withdraw)?|crm\/.+|associates\/.+|admin\/(ingestion|companies)(\/.*)?|admin\/traces(\/[0-9a-f-]{36}(\/checks)?)?|health)$/;

const secure = process.env.NODE_ENV === "production";

function cookieOptions(expiresAt: string) {
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    expires: new Date(expiresAt),
  };
}

function who(user: { name: string; role: string }) {
  return Buffer.from(JSON.stringify({ name: user.name, role: user.role })).toString("base64url");
}

async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const path = (await ctx.params).path.join("/");
  if (!ALLOWED.test(path)) return NextResponse.json({ message: "Not found." }, { status: 404 });

  const headers = new Headers();
  for (const h of ["content-type", "accept"]) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const session = req.cookies.get(SESSION_COOKIE)?.value;
  if (session) headers.set("authorization", `Bearer ${session}`);
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) headers.set("x-forwarded-for", fwd);

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}/${path}${req.nextUrl.search}`, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      // Required to stream a request body (multipart uploads).
      ...(hasBody ? { duplex: "half" } : {}),
      cache: "no-store",
    } as RequestInit);
  } catch {
    return NextResponse.json(
      { message: "Finsol Enterprises is not reachable right now. Please try again shortly." },
      { status: 503 },
    );
  }

  const type = upstream.headers.get("content-type") ?? "";
  const movesToken = path === "auth/otp/verify" || path === "associates/register";
  if (upstream.ok && type.includes("json") && movesToken) {
    const body = (await upstream.json()) as Record<string, unknown>;
    const res = NextResponse.json(
      path === "auth/otp/verify"
        ? { user: body.user, expiresAt: body.expiresAt }
        : { associate: body.associate },
      { status: upstream.status },
    );
    if (path === "auth/otp/verify") {
      res.cookies.set(SESSION_COOKIE, String(body.token), cookieOptions(String(body.expiresAt)));
      const user = body.user as { name: string; role: string };
      res.cookies.set(WHO_COOKIE, who(user), {
        ...cookieOptions(String(body.expiresAt)),
        httpOnly: false,
      });
    }
    if (path === "associates/register") {
      const s = body.session as { token: string; expiresAt: string };
      res.cookies.set(SESSION_COOKIE, s.token, cookieOptions(s.expiresAt));
      const claims = JSON.parse(
        Buffer.from(s.token.split(".")[1] ?? "", "base64url").toString("utf8"),
      ) as { name: string; role: string };
      res.cookies.set(WHO_COOKIE, who(claims), { ...cookieOptions(s.expiresAt), httpOnly: false });
    }
    return res;
  }

  const out = new Headers({ "cache-control": "private, no-store, no-transform" });
  for (const h of [
    "content-type",
    "content-disposition",
    "x-content-type-options",
    "x-report-code",
    "x-reports-left-today",
  ]) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  return new NextResponse(upstream.body, { status: upstream.status, headers: out });
}

export { forward as GET, forward as POST, forward as PATCH, forward as PUT, forward as DELETE };
