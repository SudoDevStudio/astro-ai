/**
 * The head metadata one page declares.
 *
 * Every field is optional and separately omittable, because the job of this app
 * is to produce *different* head states on demand: a complete one, a broken one,
 * and one with almost nothing. A real site would hardcode its own defaults in
 * `Seo.astro` and expose two or three props.
 */
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
};
