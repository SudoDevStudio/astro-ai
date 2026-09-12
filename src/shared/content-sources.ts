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
  /** Entry address template. `{id}` is replaced with the URL-encoded attribute value. */
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
  url?: string;
  docs?: string;
  mcp?: string;
  instructions?: string;
};

const MAX_SOURCES = 12;
const MAX_NAME_LENGTH = 60;
const MAX_ID_LENGTH = 200;
const MAX_INSTRUCTIONS_LENGTH = 500;
const ATTRIBUTE_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
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
    return this.#sources.map(({ attribute }) => attribute);
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
      const url = source.entryUrl === undefined
        ? undefined
        : source.entryUrl.replaceAll(ID_PLACEHOLDER, encodeURIComponent(id));
      return [{
        source: source.name,
        attribute: source.attribute,
        id,
        ...(url === undefined ? {} : { url }),
        ...(source.docs === undefined ? {} : { docs: source.docs }),
        ...(source.mcp === undefined ? {} : { mcp: source.mcp }),
        ...(source.instructions === undefined ? {} : { instructions: source.instructions }),
      }];
    });
  }
}

/**
 * What the user asked for from an entry: its URL when the source can address
 * entries, and the bare id when it cannot.
 */
export function contentEntryReference(origin: ContentOrigin): string {
  return origin.url ?? origin.id;
}

export function describeContentOrigin(origin: ContentOrigin): string {
  const detail = [
    origin.url === undefined ? `id ${origin.id}` : origin.url,
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
  return definitions.map((definition) => {
    if (typeof definition !== 'object' || definition === null) {
      throw new Error('Each content source must be an object.');
    }
    const name = requireText(definition.name, 'name', MAX_NAME_LENGTH);
    if (names.has(name)) throw new Error(`Duplicate content source name “${name}”.`);
    names.add(name);

    const attribute = requireText(definition.attribute, `content source “${name}” attribute`, 100);
    if (!ATTRIBUTE_PATTERN.test(attribute)) {
      throw new Error(`Content source “${name}” attribute “${attribute}” is not a valid DOM attribute name.`);
    }
    const attributeKey = attribute.toLowerCase();
    if (attributes.has(attributeKey)) {
      throw new Error(`Attribute “${attribute}” is already claimed by another content source.`);
    }
    attributes.add(attributeKey);

    return {
      name,
      attribute,
      ...(definition.entryUrl === undefined
        ? {}
        : { entryUrl: requireEntryUrl(definition.entryUrl, name) }),
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

function requireEntryUrl(value: unknown, name: string): string {
  const template = requireText(value, `“${name}” entryUrl`, 500);
  if (!template.includes(ID_PLACEHOLDER)) {
    throw new Error(`Content source “${name}” entryUrl must contain the ${ID_PLACEHOLDER} placeholder.`);
  }
  requireHttpUrl(template.replaceAll(ID_PLACEHOLDER, 'entry-id'), `“${name}” entryUrl`);
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
