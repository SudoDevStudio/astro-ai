import type { SeoPreviewConfig } from './protocol.js';

/**
 * The networks the share preview can render, in the order they appear.
 *
 * This list is shared rather than owned by the toolbar because the integration
 * validates `seo.networks` against it at startup: a typo in `astro.config.mjs`
 * should fail loudly there rather than silently render one card fewer.
 */
export const SEO_NETWORK_IDS = [
  'x',
  'facebook',
  'linkedin',
  'instagram',
  'discord',
  'slack',
  'whatsapp',
  'google',
] as const;

export type SeoNetworkId = (typeof SEO_NETWORK_IDS)[number];

export type SeoPreviewOption = boolean | {
  /** Networks to render, in the order given. Every network when omitted. */
  networks?: SeoNetworkId[];
};

export function isSeoNetworkId(value: unknown): value is SeoNetworkId {
  return typeof value === 'string' && (SEO_NETWORK_IDS as readonly string[]).includes(value);
}

/**
 * Validates the configured share preview settings.
 *
 * Returns `false` when the preview is switched off, and `undefined` when
 * nothing was configured, so the toolbar can tell "off" from "default".
 */
export function normalizeSeoPreview(option: SeoPreviewOption | undefined): SeoPreviewConfig | false | undefined {
  if (option === false) return false;
  if (option === undefined || option === true) return undefined;
  if (typeof option !== 'object' || option === null) {
    throw new Error('`seo` must be a boolean or an object.');
  }

  const config: SeoPreviewConfig = {};

  if (option.networks !== undefined) {
    if (!Array.isArray(option.networks) || option.networks.length === 0) {
      throw new Error('`seo.networks` must be a non-empty array of network names.');
    }
    const seen = new Set<string>();
    for (const network of option.networks) {
      if (!isSeoNetworkId(network)) {
        throw new Error(
          `\`seo.networks\` contains an unknown network ${JSON.stringify(network)}. Known networks: ${SEO_NETWORK_IDS.join(', ')}.`,
        );
      }
      seen.add(network);
    }
    config.networks = [...seen];
  }

  return Object.keys(config).length === 0 ? undefined : config;
}
