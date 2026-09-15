/**
 * Reads the page's head metadata and works out what each network will actually
 * show for it.
 *
 * Everything here is a pure function over a `Document` so the rules can be
 * tested without a browser. The rendering half lives in `seo-sheet.ts`.
 *
 * Two things make this more than a tag dump. Networks disagree about which tag
 * wins — X prefers `twitter:*` and falls back to `og:*`, Google ignores both
 * and reads `<title>` — so one page has as many titles as it has audiences.
 * And every network truncates at its own length, so a title that reads well on
 * LinkedIn can lose its last three words on Google.
 */

import { SEO_NETWORK_IDS, type SeoNetworkId } from '../shared/seo-preview.js';

export type MetaTagSource = 'title' | 'meta-name' | 'meta-property' | 'link' | 'html';

export type MetaTag = {
  key: string;
  value: string;
  source: MetaTagSource;
};

export type OpenGraphMetadata = {
  title?: string;
  description?: string;
  image?: string;
  imageAlt?: string;
  imageWidth?: number;
  imageHeight?: number;
  imageType?: string;
  url?: string;
  type?: string;
  siteName?: string;
  locale?: string;
};

export type TwitterMetadata = {
  card?: string;
  title?: string;
  description?: string;
  image?: string;
  imageAlt?: string;
  site?: string;
  creator?: string;
};

export type PageMetadata = {
  /** The address the preview is for, absolute. */
  url: string;
  domain: string;
  path: string;
  title?: string;
  description?: string;
  canonical?: string;
  robots?: string;
  themeColor?: string;
  favicon?: string;
  lang?: string;
  og: OpenGraphMetadata;
  twitter: TwitterMetadata;
  /** Every recognised head tag, in document order, for the tag inspector. */
  tags: MetaTag[];
};

export type NetworkId = SeoNetworkId;

export const NETWORK_IDS: readonly NetworkId[] = SEO_NETWORK_IDS;

type NetworkSpec = {
  label: string;
  /** Where this card appears, so an unfamiliar shape is not mistaken for a bug. */
  surface: string;
  titleLimit: number;
  descriptionLimit: number;
  /** False for networks that never render a description in this surface. */
  showsDescription: boolean;
};

export const NETWORK_SPECS: Record<NetworkId, NetworkSpec> = {
  x: { label: 'X', surface: 'Timeline link card', titleLimit: 70, descriptionLimit: 125, showsDescription: true },
  facebook: { label: 'Facebook', surface: 'Feed link post', titleLimit: 88, descriptionLimit: 110, showsDescription: true },
  linkedin: { label: 'LinkedIn', surface: 'Feed share', titleLimit: 119, descriptionLimit: 0, showsDescription: false },
  instagram: { label: 'Instagram', surface: 'Direct message link', titleLimit: 60, descriptionLimit: 80, showsDescription: true },
  discord: { label: 'Discord', surface: 'Message embed', titleLimit: 256, descriptionLimit: 350, showsDescription: true },
  slack: { label: 'Slack', surface: 'Message unfurl', titleLimit: 120, descriptionLimit: 220, showsDescription: true },
  whatsapp: { label: 'WhatsApp', surface: 'Chat bubble', titleLimit: 65, descriptionLimit: 90, showsDescription: true },
  google: { label: 'Google', surface: 'Search result', titleLimit: 60, descriptionLimit: 160, showsDescription: true },
};

export type NetworkCard = {
  network: NetworkId;
  label: string;
  surface: string;
  /** Already truncated the way the network truncates it. */
  title: string;
  description: string;
  /** True when the network cut the value short, so the UI can say so. */
  titleTruncated: boolean;
  descriptionTruncated: boolean;
  image?: string;
  imageAlt?: string;
  domain: string;
  url: string;
  siteName?: string;
  themeColor?: string;
  favicon?: string;
  /**
   * `large` renders the wide 1.91:1 image, `compact` the small square thumb.
   * Which one a network picks depends on its own tags, not on preference.
   */
  variant: 'large' | 'compact';
  /** Values the page never supplied, so the card shows a placeholder. */
  missing: Array<'title' | 'description' | 'image'>;
};

export type SeoFindingLevel = 'error' | 'warning' | 'info';

export type SeoFinding = {
  /** Unique to this occurrence: two bad breadcrumbs are two ids. */
  id: string;
  /**
   * Stable across occurrences, naming the *kind* of problem rather than the
   * place it happened. A site audit groups by this, which is how fourteen
   * symptoms become one cause. Defaults to `id` where the two are the same.
   */
  code?: string;
  level: SeoFindingLevel;
  title: string;
  detail: string;
  /** The networks a reader would actually see this on. */
  networks: NetworkId[];
  /** The tag to add or correct, written the way it appears in source. */
  tag?: string;
};

/** Measurements of the real `og:image`, once the browser has loaded it. */
export type ImageProbe = {
  status: 'loading' | 'loaded' | 'failed' | 'absent';
  width?: number;
  height?: number;
};

const OG_IMAGE_MIN = { width: 200, height: 200 };
const OG_IMAGE_RECOMMENDED = { width: 1200, height: 630 };
const DESCRIPTION_MIN = 50;
const DESCRIPTION_MAX = 160;
const TITLE_MIN = 15;

export function readPageMetadata(doc: Document, href: string): PageMetadata {
  const tags: MetaTag[] = [];
  const values = new Map<string, string>();
  const record = (key: string, value: string | null | undefined, source: MetaTagSource): void => {
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed === '') return;
    tags.push({ key, value: trimmed, source });
    // First tag wins, matching how crawlers treat a duplicated property.
    if (!values.has(key)) values.set(key, trimmed);
  };

  const documentTitle = doc.querySelector('title')?.textContent;
  record('title', documentTitle, 'title');

  for (const meta of doc.querySelectorAll('meta')) {
    const key = meta.getAttribute('property') ?? meta.getAttribute('name') ?? meta.getAttribute('itemprop');
    if (key === null) continue;
    const source: MetaTagSource = meta.hasAttribute('property') ? 'meta-property' : 'meta-name';
    record(key.trim().toLowerCase(), meta.getAttribute('content'), source);
  }

  for (const link of doc.querySelectorAll('link')) {
    const rel = link.getAttribute('rel')?.trim().toLowerCase();
    if (rel === undefined) continue;
    if (rel === 'canonical') record('canonical', link.getAttribute('href'), 'link');
    if (rel.split(/\s+/).includes('icon')) record('icon', link.getAttribute('href'), 'link');
  }

  const lang = doc.documentElement.getAttribute('lang');
  record('html:lang', lang, 'html');

  // Every later resolution needs a base, so an unparseable page URL still has
  // to produce one rather than leaving the reader without an origin.
  const base = safeUrl(href) ?? new URL('http://localhost/');
  const canonical = values.get('canonical');
  const ogUrl = values.get('og:url');
  const resolved = safeUrl(canonical ?? ogUrl ?? href, base) ?? base;

  return {
    url: resolved.href,
    domain: resolved.hostname.replace(/^www\./, ''),
    path: resolved.pathname,
    ...pick('title', values.get('title')),
    ...pick('description', values.get('description')),
    ...pick('canonical', absolutize(canonical, base)),
    ...pick('robots', values.get('robots')),
    ...pick('themeColor', values.get('theme-color')),
    ...pick('favicon', absolutize(values.get('icon'), base)),
    ...pick('lang', lang ?? undefined),
    og: {
      ...pick('title', values.get('og:title')),
      ...pick('description', values.get('og:description')),
      // Deliberately not absolutized: whether the author wrote an absolute URL
      // is itself the thing the audit checks, so the raw value must survive.
      ...pick('image', values.get('og:image') ?? values.get('og:image:url')),
      ...pick('imageAlt', values.get('og:image:alt')),
      ...pick('imageWidth', numeric(values.get('og:image:width'))),
      ...pick('imageHeight', numeric(values.get('og:image:height'))),
      ...pick('imageType', values.get('og:image:type')),
      ...pick('url', ogUrl),
      ...pick('type', values.get('og:type')),
      ...pick('siteName', values.get('og:site_name')),
      ...pick('locale', values.get('og:locale')),
    },
    twitter: {
      ...pick('card', values.get('twitter:card')),
      ...pick('title', values.get('twitter:title')),
      ...pick('description', values.get('twitter:description')),
      ...pick('image', values.get('twitter:image') ?? values.get('twitter:image:src')),
      ...pick('imageAlt', values.get('twitter:image:alt')),
      ...pick('site', values.get('twitter:site')),
      ...pick('creator', values.get('twitter:creator')),
    },
    tags,
  };
}

/**
 * Resolves one network's card. Each network reads a different tag chain, and
 * the fallbacks are the whole point: a page with only `<title>` still shows
 * something everywhere, and the card records what it had to invent.
 */
export function resolveNetworkCard(metadata: PageMetadata, network: NetworkId): NetworkCard {
  const spec = NETWORK_SPECS[network];
  const { og, twitter } = metadata;
  const baseUrl = safeUrl(metadata.url);

  const prefersTwitter = network === 'x';
  const rawTitle = prefersTwitter
    ? twitter.title ?? og.title ?? metadata.title
    : network === 'google'
      ? metadata.title ?? og.title
      : og.title ?? metadata.title;
  const rawDescription = prefersTwitter
    ? twitter.description ?? og.description ?? metadata.description
    : network === 'google'
      ? metadata.description ?? og.description
      : og.description ?? metadata.description;
  const rawImage = prefersTwitter ? twitter.image ?? og.image : og.image ?? twitter.image;

  const missing: NetworkCard['missing'] = [];
  if (rawTitle === undefined || rawTitle === '') missing.push('title');
  if (spec.showsDescription && (rawDescription === undefined || rawDescription === '')) {
    missing.push('description');
  }
  if (rawImage === undefined || rawImage === '') missing.push('image');

  const title = truncate(rawTitle ?? metadata.url, spec.titleLimit);
  const description = spec.showsDescription
    ? truncate(rawDescription ?? '', spec.descriptionLimit)
    : { text: '', truncated: false };
  const image = absolutize(rawImage, baseUrl);

  return {
    network,
    label: spec.label,
    surface: spec.surface,
    title: title.text,
    description: description.text,
    titleTruncated: title.truncated,
    descriptionTruncated: description.truncated,
    ...pick('image', image),
    ...pick('imageAlt', prefersTwitter ? twitter.imageAlt ?? og.imageAlt : og.imageAlt),
    domain: metadata.domain,
    url: metadata.url,
    ...pick('siteName', og.siteName),
    ...pick('themeColor', metadata.themeColor),
    ...pick('favicon', metadata.favicon),
    variant: cardVariant(metadata, network, image !== undefined),
    missing,
  };
}

export function resolveNetworkCards(
  metadata: PageMetadata,
  networks: readonly NetworkId[] = NETWORK_IDS,
): NetworkCard[] {
  return networks.map((network) => resolveNetworkCard(metadata, network));
}

/**
 * Which shape the network renders. X and Discord both key off `twitter:card`;
 * the rest pick by whether an image exists at all.
 */
function cardVariant(metadata: PageMetadata, network: NetworkId, hasImage: boolean): 'large' | 'compact' {
  if (!hasImage) return 'compact';
  const card = metadata.twitter.card?.toLowerCase();
  if (network === 'x' || network === 'discord') {
    return card === 'summary_large_image' || card === 'player' ? 'large' : 'compact';
  }
  if (network === 'whatsapp' || network === 'google' || network === 'slack') {
    // These show a thumbnail beside the text rather than a banner above it.
    return 'compact';
  }
  return 'large';
}

/**
 * The findings a developer can act on. Every rule names the networks it
 * actually changes, because "add og:image" is advice and "WhatsApp and Slack
 * will show no image" is a reason.
 */
export function auditPageMetadata(
  metadata: PageMetadata,
  probe: ImageProbe = { status: 'absent' },
): SeoFinding[] {
  const findings: SeoFinding[] = [];
  const { og, twitter } = metadata;
  const add = (finding: SeoFinding): void => {
    findings.push(finding);
  };

  if (metadata.title === undefined) {
    add({
      id: 'title-missing',
      level: 'error',
      title: 'No <title>',
      detail: 'Google has nothing to show as the result headline, and every network that falls back to the document title shows the bare URL.',
      networks: ['google', 'x', 'facebook', 'linkedin', 'instagram', 'discord', 'slack', 'whatsapp'],
      tag: '<title>',
    });
  } else {
    if (metadata.title.length > NETWORK_SPECS.google.titleLimit) {
      add({
        id: 'title-long',
        level: 'warning',
        title: `Title is ${metadata.title.length} characters`,
        detail: `Google truncates around ${NETWORK_SPECS.google.titleLimit}. The tail "${metadata.title.slice(NETWORK_SPECS.google.titleLimit)}" will not be read.`,
        networks: ['google'],
        tag: '<title>',
      });
    }
    if (metadata.title.length < TITLE_MIN) {
      add({
        id: 'title-short',
        level: 'info',
        title: `Title is only ${metadata.title.length} characters`,
        detail: 'A short title leaves the result without the keywords a reader scans for.',
        networks: ['google'],
        tag: '<title>',
      });
    }
  }

  if (metadata.description === undefined) {
    add({
      id: 'description-missing',
      level: 'error',
      title: 'No meta description',
      detail: 'Google writes its own snippet from page text when this is absent, and the choice of text is then out of your hands.',
      networks: ['google'],
      tag: '<meta name="description">',
    });
  } else if (metadata.description.length > DESCRIPTION_MAX) {
    add({
      id: 'description-long',
      level: 'warning',
      title: `Description is ${metadata.description.length} characters`,
      detail: `Google truncates around ${DESCRIPTION_MAX} and Facebook around ${NETWORK_SPECS.facebook.descriptionLimit}.`,
      networks: ['google', 'facebook'],
      tag: '<meta name="description">',
    });
  } else if (metadata.description.length < DESCRIPTION_MIN) {
    add({
      id: 'description-short',
      level: 'info',
      title: `Description is only ${metadata.description.length} characters`,
      detail: `Under ${DESCRIPTION_MIN} characters rarely says enough to earn the click.`,
      networks: ['google'],
      tag: '<meta name="description">',
    });
  }

  if (og.title === undefined) {
    add({
      id: 'og-title-missing',
      level: 'warning',
      title: 'No og:title',
      detail: 'Networks fall back to <title>, which usually carries a site suffix that wastes room in a card.',
      networks: ['facebook', 'linkedin', 'instagram', 'discord', 'slack', 'whatsapp'],
      tag: '<meta property="og:title">',
    });
  }
  if (og.description === undefined) {
    add({
      id: 'og-description-missing',
      level: metadata.description === undefined ? 'error' : 'warning',
      title: 'No og:description',
      detail: metadata.description === undefined
        ? 'With no meta description either, every social card renders with an empty body.'
        : 'Cards fall back to the meta description, which is written for search, not for a card.',
      networks: ['facebook', 'instagram', 'discord', 'slack', 'whatsapp'],
      tag: '<meta property="og:description">',
    });
  }

  if (og.image === undefined && twitter.image === undefined) {
    add({
      id: 'og-image-missing',
      level: 'error',
      title: 'No og:image',
      detail: 'Every card here renders as a text-only link. This is the single largest difference in how a shared link looks.',
      networks: ['x', 'facebook', 'linkedin', 'instagram', 'discord', 'slack', 'whatsapp'],
      tag: '<meta property="og:image">',
    });
  } else {
    const rawImage = og.image ?? twitter.image;
    if (rawImage !== undefined && !isAbsoluteUrl(rawImage)) {
      add({
        id: 'og-image-relative',
        level: 'error',
        title: 'og:image is a relative URL',
        detail: `Crawlers fetch this tag without the page's base, so "${rawImage}" resolves to nothing on their side. Use a full https:// URL.`,
        networks: ['x', 'facebook', 'linkedin', 'instagram', 'discord', 'slack', 'whatsapp'],
        tag: '<meta property="og:image">',
      });
    }
    if (probe.status === 'failed') {
      add({
        id: 'og-image-unreachable',
        level: 'error',
        title: 'og:image did not load',
        detail: 'The browser could not fetch the image at this URL. A crawler will not manage it either.',
        networks: ['x', 'facebook', 'linkedin', 'instagram', 'discord', 'slack', 'whatsapp'],
        tag: '<meta property="og:image">',
      });
    }
    if (probe.status === 'loaded' && probe.width !== undefined && probe.height !== undefined) {
      if (probe.width < OG_IMAGE_MIN.width || probe.height < OG_IMAGE_MIN.height) {
        add({
          id: 'og-image-tiny',
          level: 'error',
          title: `og:image is ${probe.width}×${probe.height}`,
          detail: `Below ${OG_IMAGE_MIN.width}×${OG_IMAGE_MIN.height} the image is dropped outright rather than scaled.`,
          networks: ['facebook', 'linkedin', 'whatsapp', 'slack'],
          tag: '<meta property="og:image">',
        });
      } else if (probe.width < OG_IMAGE_RECOMMENDED.width || probe.height < OG_IMAGE_RECOMMENDED.height) {
        add({
          id: 'og-image-small',
          level: 'warning',
          title: `og:image is ${probe.width}×${probe.height}`,
          detail: `${OG_IMAGE_RECOMMENDED.width}×${OG_IMAGE_RECOMMENDED.height} is the size the wide card is designed around; smaller images are upscaled and look soft.`,
          networks: ['x', 'facebook', 'linkedin'],
          tag: '<meta property="og:image">',
        });
      }
    }
    if (og.imageWidth === undefined || og.imageHeight === undefined) {
      add({
        id: 'og-image-dimensions-missing',
        level: 'info',
        title: 'No og:image:width or og:image:height',
        detail: 'Without declared dimensions the first share of a link often renders before the crawler has measured the image, so the card appears without it.',
        networks: ['facebook', 'linkedin'],
        tag: '<meta property="og:image:width">',
      });
    }
    if (og.imageAlt === undefined && twitter.imageAlt === undefined) {
      add({
        id: 'og-image-alt-missing',
        level: 'warning',
        title: 'No og:image:alt',
        detail: 'The card image is unreadable to anyone using a screen reader on the network.',
        networks: ['x', 'facebook', 'linkedin'],
        tag: '<meta property="og:image:alt">',
      });
    }
  }

  if (twitter.card === undefined) {
    add({
      id: 'twitter-card-missing',
      level: 'warning',
      title: 'No twitter:card',
      detail: 'X renders the small square thumbnail instead of the wide banner. Set summary_large_image for the large card.',
      networks: ['x', 'discord'],
      tag: '<meta name="twitter:card" content="summary_large_image">',
    });
  } else if (!['summary', 'summary_large_image', 'app', 'player'].includes(twitter.card.toLowerCase())) {
    add({
      id: 'twitter-card-invalid',
      level: 'error',
      title: `twitter:card "${twitter.card}" is not a known value`,
      detail: 'X ignores unknown card types and falls back to a plain link.',
      networks: ['x'],
      tag: '<meta name="twitter:card">',
    });
  }

  if (og.url === undefined && metadata.canonical === undefined) {
    add({
      id: 'og-url-missing',
      level: 'warning',
      title: 'No og:url or canonical link',
      detail: 'Shares of the same page through different query strings are counted as separate links.',
      networks: ['facebook', 'linkedin', 'google'],
      tag: '<meta property="og:url">',
    });
  } else if (
    og.url !== undefined &&
    metadata.canonical !== undefined &&
    normalizeForCompare(og.url) !== normalizeForCompare(metadata.canonical)
  ) {
    add({
      id: 'og-url-mismatch',
      level: 'warning',
      title: 'og:url and canonical disagree',
      detail: `og:url is "${og.url}" and the canonical link is "${metadata.canonical}". Search and social will attribute the page to different addresses.`,
      networks: ['facebook', 'google'],
      tag: '<meta property="og:url">',
    });
  }

  if (og.siteName === undefined) {
    add({
      id: 'og-site-name-missing',
      level: 'info',
      title: 'No og:site_name',
      detail: 'Slack and Discord label the unfurl with the bare domain instead of the site name.',
      networks: ['slack', 'discord', 'facebook'],
      tag: '<meta property="og:site_name">',
    });
  }
  if (og.type === undefined) {
    add({
      id: 'og-type-missing',
      level: 'info',
      title: 'No og:type',
      detail: 'Defaults to website. Article pages that set it get the byline and published date in some unfurls.',
      networks: ['facebook', 'linkedin'],
      tag: '<meta property="og:type" content="website">',
    });
  }
  if (metadata.lang === undefined) {
    add({
      id: 'html-lang-missing',
      level: 'warning',
      title: 'No lang on <html>',
      detail: 'Search engines and screen readers both guess the language when it is not declared.',
      networks: ['google'],
      tag: '<html lang="en">',
    });
  }
  if (metadata.robots !== undefined && /noindex/i.test(metadata.robots)) {
    add({
      id: 'robots-noindex',
      level: 'info',
      title: 'This page is marked noindex',
      detail: `robots is "${metadata.robots}", so the page will not appear in search at all. Intentional on staging, costly in production.`,
      networks: ['google'],
      tag: '<meta name="robots">',
    });
  }
  if (metadata.favicon === undefined) {
    add({
      id: 'favicon-missing',
      level: 'info',
      title: 'No icon link',
      detail: 'Google shows a generic globe beside the result, and Slack unfurls lose the site mark.',
      networks: ['google', 'slack'],
      tag: '<link rel="icon">',
    });
  }

  return findings.sort((first, second) => severityRank(first.level) - severityRank(second.level));
}

export function countBySeverity(findings: readonly SeoFinding[]): Record<SeoFindingLevel, number> {
  const counts: Record<SeoFindingLevel, number> = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.level] += 1;
  return counts;
}

/**
 * Writes the agent brief for one or more findings. The current values go in
 * alongside the problem: the agent has to find the head tags in a layout it has
 * not read yet, and the existing title is the cheapest way to locate them.
 */
export function describeFindingsForAgent(
  metadata: PageMetadata,
  findings: readonly SeoFinding[],
): string {
  const current = [
    `Route: ${metadata.path}`,
    `URL: ${metadata.url}`,
    metadata.title === undefined ? 'title: (missing)' : `title: ${metadata.title}`,
    metadata.description === undefined ? 'meta description: (missing)' : `meta description: ${metadata.description}`,
    metadata.og.title === undefined ? 'og:title: (missing)' : `og:title: ${metadata.og.title}`,
    metadata.og.description === undefined ? 'og:description: (missing)' : `og:description: ${metadata.og.description}`,
    metadata.og.image === undefined ? 'og:image: (missing)' : `og:image: ${metadata.og.image}`,
    metadata.twitter.card === undefined ? 'twitter:card: (missing)' : `twitter:card: ${metadata.twitter.card}`,
  ].join('\n');

  const problems = findings
    .map((finding, index) => {
      const networks = finding.networks.map((id) => NETWORK_SPECS[id].label).join(', ');
      return [
        `${index + 1}. [${finding.level}] ${finding.title}`,
        `   ${finding.detail}`,
        finding.tag === undefined ? undefined : `   Tag: ${finding.tag}`,
        `   Affects: ${networks}`,
      ]
        .filter((line) => line !== undefined)
        .join('\n');
    })
    .join('\n');

  return [
    'Current head metadata as rendered:',
    current,
    '',
    `${findings.length} issue${findings.length === 1 ? '' : 's'} to fix:`,
    problems,
  ].join('\n');
}

/** Truncates the way a card does: at a word boundary, with an ellipsis. */
export function truncate(value: string, limit: number): { text: string; truncated: boolean } {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (limit <= 0 || normalized.length <= limit) return { text: normalized, truncated: false };
  const cut = normalized.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  const body = lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut;
  return { text: `${body.trimEnd()}…`, truncated: true };
}

export function isAbsoluteUrl(value: string): boolean {
  return /^(?:https?:)?\/\//i.test(value) || /^data:/i.test(value);
}

function absolutize(value: string | undefined, base: URL | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  const resolved = safeUrl(value, base);
  return resolved?.href ?? value;
}

function safeUrl(value: string | undefined, base?: URL | string): URL | undefined {
  if (value === undefined || value === '') return undefined;
  try {
    return base === undefined ? new URL(value) : new URL(value, base);
  } catch {
    return undefined;
  }
}

function numeric(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeForCompare(value: string): string {
  return value.replace(/\/+$/, '').toLowerCase();
}

function severityRank(level: SeoFindingLevel): number {
  return level === 'error' ? 0 : level === 'warning' ? 1 : 2;
}

/**
 * Builds `{ key: value }` for a defined value and `{}` for an undefined one, so
 * optional fields stay absent rather than explicitly undefined.
 */
function pick<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}
