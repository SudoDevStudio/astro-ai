/**
 * Audits every route the project serves, and reports causes rather than pages.
 *
 * A crawler run against a finished site produces one row per URL, which is a
 * list of symptoms: fourteen pages missing `og:image` look like fourteen
 * problems. They are almost never fourteen problems. They are one layout.
 *
 * Running inside the dev server changes what can be said about that. The routes
 * are known before anything is requested, the pages come from the project the
 * agent can edit, and a finding that repeats across a whole directory is
 * evidence of a shared template. So findings are grouped by their cause, the
 * routes are evidence for it, and a fix is offered once for the class.
 */

import {
  auditPageMetadata,
  readPageMetadata,
  type PageMetadata,
  type SeoFinding,
  type SeoFindingLevel,
} from './seo-metadata.js';
import { auditStructuredData, readStructuredData } from './seo-schema.js';
import { auditAnswerReadiness, extractForAnswerEngines } from './seo-aeo.js';
import { sharedRoutePrefix, type PageRoute } from '../shared/page-routes.js';

export type RouteAudit = {
  route: string;
  title?: string;
  findings: SeoFinding[];
  /** Set when the route could not be read, which is itself worth reporting. */
  error?: string;
};

export type AuditCause = {
  /** The stable key every occurrence of this problem shares. */
  code: string;
  level: SeoFindingLevel;
  title: string;
  detail: string;
  tag?: string;
  /** Every route the problem was found on, in route order. */
  routes: string[];
  /**
   * The directory every affected route sits under, when there is one. A cause
   * confined to `/products/` is a template; one spread across the whole site is
   * a layout. Both are one edit.
   */
  sharedPrefix?: string;
  /**
   * True when the routes did not all report the same wording. Several findings
   * put a measurement in their title — "Only 75 words of readable text" — and
   * one route's number must not be presented as every route's.
   */
  varies?: boolean;
};

export type SiteAudit = {
  routes: RouteAudit[];
  causes: AuditCause[];
  /** Routes that produced no finding at all. */
  clean: string[];
  /** Dynamic routes, which are reported but never requested. */
  skipped: PageRoute[];
};

export type ScanOptions = {
  /** Returns the HTML served at a route, or throws. */
  fetchHtml(route: string): Promise<string>;
  parse(html: string): Document;
  /** Absolute address of a route, for resolving relative URLs in its head. */
  resolve(route: string): string;
  /** Hard ceiling on requests, so a large site cannot hang the editor. */
  limit?: number;
  onProgress?(done: number, total: number, route: string): void;
  signal?: { aborted: boolean };
};

export const DEFAULT_ROUTE_LIMIT = 40;

/**
 * Reads every route and audits each one.
 *
 * Requests run one at a time on purpose: this is a dev server also serving the
 * page the editor is running in, and a burst of parallel requests competes with
 * the thing the user is looking at.
 */
export async function scanSite(
  routes: readonly PageRoute[],
  options: ScanOptions,
): Promise<SiteAudit> {
  const limit = options.limit ?? DEFAULT_ROUTE_LIMIT;
  const requestable = routes.filter(({ dynamic }) => !dynamic);
  const skipped = routes.filter(({ dynamic }) => dynamic);
  const queue = requestable.slice(0, limit).map(({ route }) => route);

  // Read through a call rather than a variable: the signal is mutated from
  // outside, including by `onProgress` itself, so a narrowed value read once
  // would be a snapshot of a decision the user has since changed.
  const aborted = (): boolean => options.signal?.aborted === true;

  const audits: RouteAudit[] = [];
  for (const [index, route] of queue.entries()) {
    if (aborted()) break;
    options.onProgress?.(index, queue.length, route);
    // Checked again because reporting progress is what usually gives the user
    // the chance to close the sheet, and a cancelled walk should not spend one
    // more request on the dev server it is sharing.
    if (aborted()) break;
    audits.push(await auditRoute(route, options));
  }
  options.onProgress?.(queue.length, queue.length, '');

  return {
    routes: audits,
    causes: groupByCause(audits),
    clean: audits.filter(({ findings, error }) => error === undefined && findings.length === 0).map(({ route }) => route),
    skipped,
  };
}

async function auditRoute(route: string, options: ScanOptions): Promise<RouteAudit> {
  let html: string;
  try {
    html = await options.fetchHtml(route);
  } catch (error) {
    return { route, findings: [], error: error instanceof Error ? error.message : 'Could not be read.' };
  }

  let doc: Document;
  try {
    doc = options.parse(html);
  } catch {
    return { route, findings: [], error: 'The response was not HTML.' };
  }

  const metadata = readPageMetadata(doc, options.resolve(route));
  const data = readStructuredData(doc);
  const extraction = extractForAnswerEngines(doc, metadata, data);

  return {
    route,
    ...(metadata.title === undefined ? {} : { title: metadata.title }),
    findings: [
      // The image is not fetched for every route: measuring one page's image is
      // cheap, measuring forty is a burst of requests for a check the per-route
      // sheet already does properly.
      ...auditPageMetadata(metadata, { status: 'absent' }),
      ...auditStructuredData(data, metadata),
      // Only the served HTML is available here, which is exactly what an answer
      // engine reads, so the rendered-versus-served comparison cannot apply.
      ...auditAnswerReadiness({ ...extraction, serverWords: extraction.renderedWords }, metadata, data),
    ],
  };
}

/**
 * Collapses per-route findings into the causes behind them.
 *
 * Sorted by severity first and reach second, because an error on one page and
 * an error on thirty are not the same size of problem.
 */
export function groupByCause(audits: readonly RouteAudit[]): AuditCause[] {
  const causes = new Map<string, AuditCause>();
  const wordings = new Map<string, Set<string>>();

  for (const audit of audits) {
    for (const finding of audit.findings) {
      const code = causeKey(finding);
      const seen = wordings.get(code) ?? new Set<string>();
      seen.add(finding.title);
      wordings.set(code, seen);
      const existing = causes.get(code);
      if (existing === undefined) {
        causes.set(code, {
          code,
          level: finding.level,
          title: finding.title,
          detail: finding.detail,
          ...(finding.tag === undefined ? {} : { tag: finding.tag }),
          routes: [audit.route],
        });
        continue;
      }
      if (!existing.routes.includes(audit.route)) existing.routes.push(audit.route);
      // Keep the worst severity the cause was ever reported at: the same
      // missing tag can be an error on one page and a warning on another.
      if (rank(finding.level) < rank(existing.level)) existing.level = finding.level;
    }
  }

  return [...causes.values()]
    .map((cause) => {
      const prefix = sharedRoutePrefix(cause.routes);
      const varies = (wordings.get(cause.code)?.size ?? 1) > 1;
      return {
        ...cause,
        ...(prefix === undefined ? {} : { sharedPrefix: prefix }),
        ...(varies ? { varies: true } : {}),
      };
    })
    .sort((first, second) =>
      rank(first.level) - rank(second.level) ||
      second.routes.length - first.routes.length ||
      first.code.localeCompare(second.code));
}

export function causeKey(finding: SeoFinding): string {
  return finding.code ?? finding.id;
}

/**
 * The brief for fixing one cause everywhere.
 *
 * The routes are the evidence, and saying so matters: the instruction is to
 * find what they have in common and change that, not to visit fourteen pages
 * and paste the same tag into each.
 */
export function describeCauseForAgent(cause: AuditCause, scanned: number): string {
  const routes = cause.routes.slice(0, 20);
  const remainder = cause.routes.length - routes.length;
  const reach = cause.routes.length === 1
    ? 'Only one route is affected, so fix it there rather than in anything shared.'
    : cause.sharedPrefix === undefined
      ? 'They do not share a directory, so the cause is more likely a site-wide layout than a single template.'
      : `Every affected route is under ${cause.sharedPrefix}, so they are most likely rendered by one template or layout.`;
  const instruction = cause.routes.length === 1
    ? 'Change it on that page.'
    : 'Find the shared source that produces these pages and fix it once. Do not add the same tag to each page individually unless they genuinely have no layout in common.';

  return [
    cause.varies === true ? `${cause.title} (the exact value differs by route)` : cause.title,
    '',
    cause.detail,
    cause.tag === undefined ? undefined : `Tag: ${cause.tag}`,
    '',
    `Found on ${cause.routes.length} of ${scanned} routes audited:`,
    ...routes.map((route) => `  ${route}`),
    remainder > 0 ? `  …and ${remainder} more` : undefined,
    '',
    reach,
    instruction,
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

export function countCauses(causes: readonly AuditCause[]): Record<SeoFindingLevel, number> {
  const counts: Record<SeoFindingLevel, number> = { error: 0, warning: 0, info: 0 };
  for (const cause of causes) counts[cause.level] += 1;
  return counts;
}

/** Routes affected by at least one error or warning. */
export function affectedRoutes(causes: readonly AuditCause[]): number {
  const routes = new Set<string>();
  for (const cause of causes) {
    if (cause.level === 'info') continue;
    for (const route of cause.routes) routes.add(route);
  }
  return routes.size;
}

function rank(level: SeoFindingLevel): number {
  return level === 'error' ? 0 : level === 'warning' ? 1 : 2;
}

export type { PageMetadata };
