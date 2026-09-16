/**
 * Turns the files under `src/pages` into the routes they serve.
 *
 * Kept pure over a list of paths so the mapping can be tested without a
 * filesystem, and so the walker that produces the list stays a few lines in the
 * integration rather than something with rules embedded in it.
 */

export type PageRoute = {
  /** The address to request, in directory form: `/`, `/about/`, `/seo/clean/`. */
  route: string;
  /** Project-relative source path, so a finding can name the file behind it. */
  file: string;
  /**
   * True for `[param]` and `[...rest]` routes, whose real addresses only exist
   * once `getStaticPaths` has run. They are reported rather than requested:
   * guessing a parameter would audit a 404.
   */
  dynamic: boolean;
};

/** Extensions Astro serves as pages. Endpoints and data files are not pages. */
const PAGE_EXTENSIONS = ['.astro', '.md', '.mdx', '.markdown', '.html'];
const PAGES_ROOT = 'src/pages/';

export function pageRoutesFromFiles(files: readonly string[]): PageRoute[] {
  const routes = new Map<string, PageRoute>();

  for (const raw of files) {
    const file = raw.replaceAll('\\', '/');
    if (!file.startsWith(PAGES_ROOT)) continue;

    const relative = file.slice(PAGES_ROOT.length);
    const extension = PAGE_EXTENSIONS.find((candidate) => relative.toLowerCase().endsWith(candidate));
    if (extension === undefined) continue;

    const segments = relative.slice(0, -extension.length).split('/');
    // A leading underscore marks a file Astro does not route, at any depth.
    if (segments.some((segment) => segment.startsWith('_'))) continue;
    if (segments.some((segment) => segment === '')) continue;

    const last = segments.at(-1);
    const path = last === 'index' ? segments.slice(0, -1) : segments;
    const dynamic = path.some((segment) => segment.includes('[') && segment.includes(']'));
    const route = path.length === 0 ? '/' : `/${path.join('/')}/`;

    // Two files can claim one route (`about.astro` and `about/index.astro`).
    // Astro resolves that itself; here the first wins so the list stays unique.
    if (!routes.has(route)) routes.set(route, { route, file, dynamic });
  }

  return [...routes.values()].sort((first, second) => first.route.localeCompare(second.route));
}

/**
 * The deepest directory every route shares, or undefined when they have nothing
 * in common but the site root.
 *
 * This is what turns a list of symptoms into a cause: fourteen routes that all
 * begin `/products/` are one template, not fourteen problems.
 */
export function sharedRoutePrefix(routes: readonly string[]): string | undefined {
  if (routes.length < 2) return undefined;
  const split = routes.map((route) => route.split('/').filter((segment) => segment !== ''));
  const first = split[0];
  if (first === undefined || first.length === 0) return undefined;

  const shared: string[] = [];
  for (const [index, segment] of first.entries()) {
    if (!split.every((segments) => segments[index] === segment)) break;
    // The last segment of a route is the page itself, not a directory it is in.
    if (split.some((segments) => segments.length === index + 1)) break;
    shared.push(segment);
  }
  return shared.length === 0 ? undefined : `/${shared.join('/')}/`;
}
