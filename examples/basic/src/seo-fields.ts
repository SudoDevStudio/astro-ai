/**
 * The head metadata one page declares.
 *
 * Every field is optional and separately omittable, because the job of this app
 * is to produce *different* head states on demand: a complete one, a broken one,
 * and one with almost nothing. A real site would hardcode its own defaults in
 * `Seo.astro` and expose two or three props.
 */
/**
 * One `<script type="application/ld+json">` block. An object is serialised; a
 * string is emitted exactly as written, which is how a fixture ships JSON that
 * does not parse.
 */
export type SchemaBlock = string | Record<string, unknown>;

export type SeoFields = {
  description?: string;
  /** Site-relative path, made absolute unless `relativeImage` is set. */
  image?: string;
  imageAlt?: string;
  /** `false` omits og:image:width and og:image:height. */
  imageSize?: [number, number] | false;
  /**
   * Emits `og:image` exactly as written instead of absolutizing it. Crawlers
   * fetch the tag without the page's base, so a relative value resolves to
   * nothing on their side — the mistake the share preview reports as an error.
   */
  relativeImage?: boolean;
  canonical?: string;
  /** Defaults to the canonical URL. Set it apart to show the two disagreeing. */
  ogUrl?: string;
  ogType?: string | false;
  siteName?: string | false;
  twitterCard?: string | false;
  robots?: string;
  themeColor?: string | false;
  favicon?: boolean;
  /**
   * JSON-LD for this page.
   *
   * `'auto'` builds a WebPage and an Organization from the values above, so the
   * schema agrees with the tags by construction — which is the point, since a
   * schema that contradicts its own page is one of the things the share preview
   * reports. Pass objects instead to describe something richer, or a string to
   * emit it verbatim, which is how the broken fixture ships invalid JSON.
   */
  schema?: 'auto' | SchemaBlock | SchemaBlock[];
};
