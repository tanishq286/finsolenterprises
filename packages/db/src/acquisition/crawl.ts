/**
 * Discovery for one issuer: from its website or investor page, follow
 * investor-relations links on the same site (two levels at most) and record
 * every IEPF / unclaimed-dividend document link found. Pages that build
 * their lists with scripts or forms yield no links: that is recorded as
 * SCRIPT_RENDERED, a dependency on a manual download or an agreement.
 */
import { formatOf } from "../statement-reader.js";
import { classifyDocument, safeDecode, INVESTOR_LINK, type DocClass } from "./classify.js";
import { politeGet } from "./http.js";
import { decideRegistrar, newTally, pageText, tallyPage } from "./registrar.js";

export interface FoundDocument {
  url: string;
  label: string;
  foundOn: string;
  docClass: DocClass;
  periodHint: string | null;
}

export interface CrawlResult {
  result:
    | "OK"
    | "NO_DOCUMENTS"
    | "SCRIPT_RENDERED"
    | "ROBOTS_DISALLOWED"
    | "BLOCKED_403"
    | "HTTP_ERROR"
    | "TIMEOUT"
    | "ERROR";
  detail: string;
  irUrl: string | null;
  pagesFetched: number;
  documents: FoundDocument[];
  /** The registrar (RTA) the issuer's pages name, when one name clearly dominates. */
  registrar: { name: string; foundOn: string } | null;
}

const DOC_KEYWORDS =
  /iepf|unclaim|unpaid|un-?paid|transfer|dividend|div ?\d{4}|shareholders? list|list of (share)?holders|suspense|tentative|trfd/i;

function sameSite(a: string, b: string) {
  const host = (u: string) => new URL(u).hostname.replace(/^www\./, "");
  const reg = (h: string) => h.split(".").slice(-3).join(".");
  try {
    const [x, y] = [host(a), host(b)];
    return x === y || reg(x) === reg(y) || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
  } catch {
    return false;
  }
}

function links(html: string, base: string): { url: string; label: string }[] {
  const out = new Map<string, { url: string; label: string }>();
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = /href\s*=\s*["']([^"'#][^"']*)["']/i.exec(m[1] ?? "")?.[1];
    if (!href || /^(javascript|mailto|tel):/i.test(href)) continue;
    let url: string;
    try {
      url = new URL(href.replace(/&amp;/g, "&"), base).toString();
    } catch {
      continue;
    }
    const label = (m[2] ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    if (!out.has(url)) out.set(url, { url, label });
  }
  return [...out.values()];
}

export async function crawlIssuer(start: string, maxPages = 12): Promise<CrawlResult> {
  const queue: { url: string; depth: number }[] = [{ url: start, depth: 0 }];
  const seen = new Set<string>();
  const documents = new Map<string, FoundDocument>();
  let pages = 0;
  let irUrl: string | null = null;
  let firstFailure: CrawlResult["result"] | null = null;
  let detail = "";
  let scriptHeavy = false;
  const registrars = newTally();

  while (queue.length && pages < maxPages) {
    const { url, depth } = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    const res = await politeGet(url, { timeoutMs: 30_000 });
    if (res.kind !== "ok") {
      if (pages === 0) {
        firstFailure =
          res.kind === "robots"
            ? "ROBOTS_DISALLOWED"
            : res.kind === "blocked"
              ? "BLOCKED_403"
              : res.kind === "http-error"
                ? "HTTP_ERROR"
                : res.kind === "timeout"
                  ? "TIMEOUT"
                  : "ERROR";
        detail = "status" in res ? `HTTP ${res.status}` : "message" in res ? res.message : res.kind;
      }
      continue;
    }
    pages++;
    if (!res.contentType?.includes("html")) continue;
    const html = res.body.toString("utf8");
    tallyPage(registrars, pageText(html), res.finalUrl);
    const found = links(html, res.finalUrl);
    if (found.length < 5 && /<script/i.test(html)) scriptHeavy = true;
    for (const l of found) {
      if (formatOf(new URL(l.url).pathname)) {
        if (!DOC_KEYWORDS.test(safeDecode(l.url)) && !DOC_KEYWORDS.test(l.label)) continue;
        const c = classifyDocument(l.url, l.label);
        documents.set(l.url, { url: l.url, label: l.label, foundOn: res.finalUrl, ...c });
        if (!irUrl && (c.docClass !== "OTHER" || /iepf|unclaim/i.test(l.url))) irUrl = res.finalUrl;
      } else if (
        depth < 2 &&
        sameSite(l.url, start) &&
        (INVESTOR_LINK.test(l.url) || INVESTOR_LINK.test(l.label))
      ) {
        // Pages about IEPF or unclaimed dividends first, general investor pages after.
        const priority = /iepf|unclaim|unpaid/i.test(l.url + l.label) ? 0 : 1;
        if (priority === 0) queue.unshift({ url: l.url, depth: depth + 1 });
        else queue.push({ url: l.url, depth: depth + 1 });
      }
    }
  }
  const docs = [...documents.values()];
  if (pages === 0)
    return {
      result: firstFailure ?? "ERROR",
      detail,
      irUrl: null,
      pagesFetched: 0,
      documents: [],
      registrar: null,
    };
  return {
    result: docs.length ? "OK" : scriptHeavy ? "SCRIPT_RENDERED" : "NO_DOCUMENTS",
    detail: docs.length
      ? `${docs.length} document links on ${pages} pages`
      : scriptHeavy
        ? "Pages load their content with scripts; no document links in the HTML"
        : `No IEPF or unclaimed-dividend documents linked from ${pages} pages`,
    irUrl,
    pagesFetched: pages,
    documents: docs,
    registrar: decideRegistrar(registrars),
  };
}
