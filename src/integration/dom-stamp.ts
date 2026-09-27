/**
 * Derives a content source from an `astro-dom-stamp` configuration.
 *
 * Stamping and reading the stamps are two halves of one decision: the
 * attributes dom-stamp writes are exactly the attributes the editor has to
 * look for. Declaring them twice is a correctness hazard rather than a
 * convenience — the names drift, and the only symptom is that selections
 * quietly stop resolving to an entry.
 *
 * So the editor takes dom-stamp's own options and asks dom-stamp what it will
 * write, through the same `resolveOptions` the integration itself uses.
 *
 * This module is deliberately outside `shared/`: browser code imports from
 * there, and dom-stamp's core carries the marker encoder that has no business
 * in a toolbar bundle.
 */

import {
  resolveOptions,
  type AstroDomStampOptions,
} from '@sudodevstudio/astro-dom-stamp/core';

import type { ContentSourceDefinition } from '../shared/content-sources.js';

export type DomStampOption = AstroDomStampOptions & {
  /**
   * Which `read` key carries the entry id. Defaults to `id` when it is read,
   * and to the first key otherwise.
   */
  entryKey?: string;
  /**
   * How the derived source is named and addressed. Everything here is what a
   * hand-written `contentSources` entry would carry; the attribute and its
   * facets come from dom-stamp.
   */
  source?: {
    name?: string;
    entryUrl?: string;
    docs?: string;
    mcp?: string;
    instructions?: string;
  };
};

const DEFAULT_SOURCE_NAME = 'stamp';
const DEFAULT_ENTRY_KEY = 'id';

/**
 * The entry id and every other stamped attribute as one content source.
 *
 * Read keys other than the entry key become facets, and `deepStamps` adds the
 * field attribute, so an element that renders one value of one record reaches
 * the agent as exactly that.
 */
export function contentSourceFromDomStamp(
  option: DomStampOption,
): ContentSourceDefinition {
  // dom-stamp validates `read`, the attribute prefix, and the reserved keys,
  // so a bad stamp configuration is reported once, in its own words.
  const resolved = resolveOptions(option);
  const entryKey = option.entryKey
    ?? (resolved.read.includes(DEFAULT_ENTRY_KEY) ? DEFAULT_ENTRY_KEY : resolved.read[0]);
  const attribute = entryKey === undefined ? undefined : resolved.attributes[entryKey];
  if (attribute === undefined) {
    throw new Error(
      `domStamp.entryKey “${String(entryKey)}” is not one of the read keys (${resolved.read.join(', ')}).`,
    );
  }

  // A facet is named by its attribute without the prefix, so what reaches the
  // agent — `type product` — reads as the attribute it came from.
  const facetName = (stamped: string): string => stamped.slice(resolved.attributePrefix.length);
  const facets: Record<string, string> = {};
  for (const [key, stamped] of Object.entries(resolved.attributes)) {
    if (key === entryKey) continue;
    facets[facetName(stamped)] = stamped;
  }
  if (resolved.deepStamps) facets[facetName(resolved.fieldAttribute)] = resolved.fieldAttribute;

  const source = option.source ?? {};
  return {
    name: source.name ?? DEFAULT_SOURCE_NAME,
    attribute,
    ...(Object.keys(facets).length === 0 ? {} : { facets }),
    ...(source.entryUrl === undefined ? {} : { entryUrl: source.entryUrl }),
    ...(source.docs === undefined ? {} : { docs: source.docs }),
    ...(source.mcp === undefined ? {} : { mcp: source.mcp }),
    ...(source.instructions === undefined ? {} : { instructions: source.instructions }),
  };
}
