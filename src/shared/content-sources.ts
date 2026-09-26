/**
 * Content sources map rendered DOM back to the system that owns the words.
 *
 * A page built from a CMS carries the entry identity in an attribute the CMS
 * client already emits. The editor knows the source file that renders an
 * element, but not that the text inside it is fetched data no source edit can
 * change. Declaring the attribute turns that id into an entry reference the
 * agent can act on: the entry URL when the source can address its entries, and
 * the raw id otherwise.
 */

export type ContentSourceDefinition = {
  /** Identifies the source in agent context and in the selection UI. */
  name: string;
  /** DOM attribute carrying the entry id, read from the element or its nearest ancestor. */
  attribute: string;
  /**
   * Further attributes describing the same entry, keyed by the name each one
   * carries into agent context — `{ type: 'data-stamp-type', field:
   * 'data-stamp-field' }`.
   *
   * A facet is read relative to the element the entry id was found on, so an
   * element inside a nested entry never borrows a facet from the entry that
   * wraps it.
   */
  facets?: Record<string, string>;
  /**
   * Entry address template. `{id}` is replaced with the URL-encoded entry id,
   * and `{facet}` with the URL-encoded value of that declared facet.
   */
  entryUrl?: string;
  /** Documentation the agent should consult before proposing content changes. */
  docs?: string;
  /** MCP server already connected to the Codex or Claude CLI that can read and write these entries. */
  mcp?: string;
  /** Extra guidance appended to the agent's content policy for this source. */
  instructions?: string;
};

export type ContentOrigin = {
  source: string;
  attribute: string;
  id: string;
  /** Facet values found alongside the id, keyed by their configured name. */
  facets?: Record<string, string>;
  url?: string;
  docs?: string;
  mcp?: string;
  instructions?: string;
};

/**
 * One source's attributes as the browser client needs them: the entry id, and
 * the facet attributes that only count when they sit within that same entry.
 */
export type ContentAttributeGroup = {
  attribute: string;
  facets?: string[];
};

const MAX_SOURCES = 12;
const MAX_FACETS = 8;
const MAX_NAME_LENGTH = 60;
const MAX_ID_LENGTH = 200;
const MAX_INSTRUCTIONS_LENGTH = 500;
const ATTRIBUTE_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const FACET_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;
const PLACEHOLDER_PATTERN = /\{[A-Za-z0-9_-]+\}/;
const MCP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,60}$/;
const ID_PLACEHOLDER = '{id}';
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

/**
 * Validated content sources, and the only place an attribute value becomes an
 * entry reference. Attribute values arrive from the rendered page, so ids are
 * bounded and URLs are always built from the configured template — never from
 * anything the page or the browser client supplied.
 */
export class ContentSourceRegistry {
  readonly #sources: ContentSourceDefinition[];

  constructor(definitions: ContentSourceDefinition[] = []) {
    this.#sources = normalizeContentSources(definitions);
  }

  get empty(): boolean {
    return this.#sources.length === 0;
  }

  /** Attribute names the browser client collects from selected elements. */
  get attributes(): string[] {
    return this.#sources.flatMap((source) => [
      source.attribute,
      ...Object.values(source.facets ?? {}),
    ]);
  }

  /**
   * The same attributes grouped by the source that declared them. The client
   * needs the grouping to know which id a facet belongs to; the flat list
   * above remains the allow-list for what may come back.
   */
  get groups(): ContentAttributeGroup[] {
    return this.#sources.map((source) => {
      const facets = Object.values(source.facets ?? {});
      return {
        attribute: source.attribute,
        ...(facets.length === 0 ? {} : { facets }),
      };
    });
  }

  /** Resolves collected attribute values into entry references, in configured order. */
  resolve(attributes: Record<string, string> | undefined): ContentOrigin[] {
    if (attributes === undefined || this.#sources.length === 0) return [];
    const collected = new Map<string, string>();
    for (const [attribute, value] of Object.entries(attributes)) {
      if (typeof attribute !== 'string' || typeof value !== 'string') continue;
      collected.set(attribute.toLowerCase(), value);
    }
    return this.#sources.flatMap((source) => {
      const id = normalizeEntryId(collected.get(source.attribute.toLowerCase()));
      if (id === undefined) return [];
      const facets: Record<string, string> = {};
      for (const [facet, attribute] of Object.entries(source.facets ?? {})) {
        const value = normalizeEntryId(collected.get(attribute.toLowerCase()));
        if (value !== undefined) facets[facet] = value;
      }
      const url = buildEntryUrl(source, id, facets);
      return [{
        source: source.name,
        attribute: source.attribute,
        id,
        ...(Object.keys(facets).length === 0 ? {} : { facets }),
        ...(url === undefined ? {} : { url }),
        ...(source.docs === undefined ? {} : { docs: source.docs }),
        ...(source.mcp === undefined ? {} : { mcp: source.mcp }),
        ...(source.instructions === undefined ? {} : { instructions: source.instructions }),
      }];
    });
  }
}

/**
 * Builds the entry address from the configured template.
 *
 * A template naming a facet cannot address the entry without it, so a missing
 * value yields no URL rather than one with an unfilled placeholder in it.
 */
function buildEntryUrl(
  source: ContentSourceDefinition,
  id: string,
  facets: Record<string, string>,
): string | undefined {
  if (source.entryUrl === undefined) return undefined;
  let url = source.entryUrl.replaceAll(ID_PLACEHOLDER, encodeURIComponent(id));
  for (const facet of Object.keys(source.facets ?? {})) {
    const placeholder = `{${facet}}`;
    if (!url.includes(placeholder)) continue;
    const value = facets[facet];
    if (value === undefined) return undefined;
    url = url.replaceAll(placeholder, encodeURIComponent(value));
  }
  return url;
}

/**
 * What the user asked for from an entry: its URL when the source can address
 * entries, and the bare id when it cannot.
 */
export function contentEntryReference(origin: ContentOrigin): string {
  return origin.url ?? origin.id;
}

/**
 * The id comes first and is always present. A configured entry URL contains it
 * already, but only in encoded form buried in a path, and the id is what you
 * paste into a CMS search or quote back to whoever owns the entry.
 */
export function describeContentOrigin(origin: ContentOrigin): string {
  const detail = [
    `entry ${origin.id}`,
    ...Object.entries(origin.facets ?? {}).map(([facet, value]) => `${facet} ${value}`),
    origin.url,
    origin.mcp === undefined ? undefined : `MCP server ${origin.mcp}`,
    origin.docs === undefined ? undefined : `docs ${origin.docs}`,
  ].filter((part): part is string => part !== undefined);
  return `${origin.source}: ${detail.join(' · ')}`;
}

export function normalizeContentSources(
  definitions: ContentSourceDefinition[] | undefined,
): ContentSourceDefinition[] {
  if (definitions === undefined) return [];
  if (!Array.isArray(definitions)) throw new Error('contentSources must be an array.');
  if (definitions.length > MAX_SOURCES) {
    throw new Error(`Declare no more than ${MAX_SOURCES} content sources.`);
  }
  const names = new Set<string>();
  const attributes = new Set<string>();
  // Ids and facets share one namespace: a value coming back names only its
  // attribute, so two sources claiming one attribute could not be told apart.
  const claimAttribute = (attribute: string, label: string): string => {
    if (!ATTRIBUTE_PATTERN.test(attribute)) {
      throw new Error(`Content source ${label} “${attribute}” is not a valid DOM attribute name.`);
    }
    const key = attribute.toLowerCase();
    if (attributes.has(key)) {
      throw new Error(`Attribute “${attribute}” is already claimed by another content source.`);
    }
    attributes.add(key);
    return attribute;
  };
  return definitions.map((definition) => {
    if (typeof definition !== 'object' || definition === null) {
      throw new Error('Each content source must be an object.');
    }
    const name = requireText(definition.name, 'name', MAX_NAME_LENGTH);
    if (names.has(name)) throw new Error(`Duplicate content source name “${name}”.`);
    names.add(name);

    const attribute = claimAttribute(
      requireText(definition.attribute, `content source “${name}” attribute`, 100),
      `“${name}” attribute`,
    );
    const facets = normalizeFacets(definition.facets, name, claimAttribute);

    return {
      name,
      attribute,
      ...(facets === undefined ? {} : { facets }),
      ...(definition.entryUrl === undefined
        ? {}
        : { entryUrl: requireEntryUrl(definition.entryUrl, name, Object.keys(facets ?? {})) }),
      ...(definition.docs === undefined
        ? {}
        : { docs: requireHttpUrl(definition.docs, `content source “${name}” docs`) }),
      ...(definition.mcp === undefined ? {} : { mcp: requireMcpName(definition.mcp, name) }),
      ...(definition.instructions === undefined
        ? {}
        : {
            instructions: requireText(
              definition.instructions,
              `content source “${name}” instructions`,
              MAX_INSTRUCTIONS_LENGTH,
            ),
          }),
    };
  });
}

/**
 * Accepts attribute values collected by the browser client. The client reads
 * them off the live page, so both the attribute names and the values are
 * treated as untrusted and bounded here rather than at the point of use.
 */
export function normalizeContentAttributes(
  value: unknown,
  allowedAttributes: readonly string[],
): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const allowed = new Set(allowedAttributes.map((attribute) => attribute.toLowerCase()));
  const collected: Record<string, string> = {};
  for (const [attribute, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'string' || !allowed.has(attribute.toLowerCase())) continue;
    const id = normalizeEntryId(raw);
    if (id !== undefined) collected[attribute] = id;
  }
  return Object.keys(collected).length === 0 ? undefined : collected;
}

/**
 * An id reaches the agent prompt verbatim, so anything that could read as a
 * second instruction — a line break, a control character — disqualifies it.
 */
function normalizeEntryId(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  if (id === '' || id.length > MAX_ID_LENGTH) return undefined;
  return CONTROL_CHARACTERS.test(id) ? undefined : id;
}

function requireText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`A content source ${label} is required.`);
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new Error(`The content source ${label} exceeds ${maxLength} characters.`);
  }
  return text;
}

/**
 * Facet names are validated here rather than at use, so a typo in a facet name
 * is reported at startup instead of silently never resolving on the page.
 */
function normalizeFacets(
  value: unknown,
  name: string,
  claimAttribute: (attribute: string, label: string) => string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Content source “${name}” facets must be an object of facet name to attribute.`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return undefined;
  if (entries.length > MAX_FACETS) {
    throw new Error(`Content source “${name}” declares more than ${MAX_FACETS} facets.`);
  }
  const facets: Record<string, string> = {};
  for (const [facet, attribute] of entries) {
    if (facet === 'id') {
      throw new Error(`Content source “${name}” cannot declare a facet named “id”; that is the entry id itself.`);
    }
    if (!FACET_NAME_PATTERN.test(facet)) {
      throw new Error(`Content source “${name}” facet name “${facet}” must start with a letter and use letters, digits, dashes, or underscores.`);
    }
    facets[facet] = claimAttribute(
      requireText(attribute, `“${name}” facet “${facet}”`, 100),
      `“${name}” facet “${facet}”`,
    );
  }
  return facets;
}

function requireEntryUrl(value: unknown, name: string, facetNames: readonly string[]): string {
  const template = requireText(value, `“${name}” entryUrl`, 500);
  if (!template.includes(ID_PLACEHOLDER)) {
    throw new Error(`Content source “${name}” entryUrl must contain the ${ID_PLACEHOLDER} placeholder.`);
  }
  let probe = template.replaceAll(ID_PLACEHOLDER, 'entry-id');
  for (const facet of facetNames) probe = probe.replaceAll(`{${facet}}`, 'facet-value');
  const unknown = PLACEHOLDER_PATTERN.exec(probe);
  if (unknown !== null) {
    throw new Error(`Content source “${name}” entryUrl uses ${unknown[0]}, which is not a declared facet.`);
  }
  requireHttpUrl(probe, `“${name}” entryUrl`);
  return template;
}

function requireHttpUrl(value: unknown, label: string): string {
  const text = requireText(value, label, 500);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`The content source ${label} must be an absolute http or https URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`The content source ${label} must use http or https.`);
  }
  return text;
}

function requireMcpName(value: unknown, name: string): string {
  const mcp = requireText(value, `“${name}” mcp`, 60);
  if (!MCP_PATTERN.test(mcp)) {
    throw new Error(`Content source “${name}” mcp must be an MCP server name.`);
  }
  return mcp;
}
