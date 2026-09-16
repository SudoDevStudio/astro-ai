/**
 * Reads and judges the page's JSON-LD.
 *
 * Structured data is the half of SEO that meta tags cannot express: it is what
 * turns a plain blue link into a result with breadcrumbs, stars, a price, or a
 * set of expandable questions. It is also the half that fails silently — a
 * missing `offers.price` costs the price in the result and nothing anywhere
 * says so.
 *
 * Everything here is a pure function over a `Document`, so the rules can be
 * tested without a browser. Rendering lives in `seo-sheet.ts`.
 */

import type { NetworkId, PageMetadata, SeoFinding } from './seo-metadata.js';

export type SchemaNode = {
  /** The first `@type`, which decides which rules apply. */
  type: string;
  /** Every `@type`, since a node may declare several. */
  types: string[];
  id?: string;
  /** Where the node sits, for a finding to point at: `block 1 · @graph[2]`. */
  path: string;
  value: Record<string, unknown>;
};

export type SchemaBlock = {
  /** Script order in the document, 1-based, as a person would count them. */
  index: number;
  raw: string;
  /** Why the block could not be read, when it could not be. */
  error?: string;
  /** The `@context` as authored, so a wrong one can be quoted back. */
  context?: string;
  nodes: SchemaNode[];
};

export type StructuredData = {
  blocks: SchemaBlock[];
  /** Every node from every block, flattened. */
  nodes: SchemaNode[];
};

/** What the schema will actually add to a search result. */
export type RichResult = {
  breadcrumbs?: string[];
  rating?: { value: number; count?: number; best: number };
  offer?: { price?: string; currency?: string; availability?: string };
  faq?: Array<{ question: string; answer: string }>;
  siteName?: string;
  datePublished?: string;
  author?: string;
};

type TypeRule = {
  /** Without these the type produces no rich result at all. */
  required: string[];
  /** Google asks for these; their absence costs detail, not the result. */
  recommended: string[];
  /** What the reader loses, named so the finding is a reason and not a rule. */
  loses: string;
};

/**
 * The types worth knowing about, and what each needs.
 *
 * Deliberately not the whole of schema.org: these are the ones Google turns
 * into a visibly different result. An unrecognised type is reported as
 * unknown rather than guessed at.
 */
export const TYPE_RULES: Record<string, TypeRule> = {
  Article: {
    required: ['headline'],
    recommended: ['image', 'datePublished', 'author', 'publisher'],
    loses: 'the headline, date, and author shown beside a news or blog result',
  },
  Product: {
    required: ['name'],
    recommended: ['image', 'description', 'brand', 'sku'],
    loses: 'the price, availability, and star rating shown on a product result',
  },
  BreadcrumbList: {
    required: ['itemListElement'],
    recommended: [],
    loses: 'the breadcrumb trail above the result title',
  },
  FAQPage: {
    required: ['mainEntity'],
    recommended: [],
    loses: 'the expandable questions beneath the result',
  },
  Organization: {
    required: ['name'],
    recommended: ['url', 'logo', 'sameAs'],
    loses: 'the knowledge panel and the site name beside the result',
  },
  WebSite: {
    required: ['name', 'url'],
    recommended: ['potentialAction'],
    loses: 'the site name and the sitelinks search box',
  },
  Event: {
    required: ['name', 'startDate', 'location'],
    recommended: ['endDate', 'image', 'description', 'offers'],
    loses: 'the date, venue, and ticket link shown on an event result',
  },
  LocalBusiness: {
    required: ['name', 'address'],
    recommended: ['telephone', 'openingHours', 'geo', 'priceRange'],
    loses: 'the hours, phone number, and map placement for the business',
  },
  VideoObject: {
    required: ['name', 'description', 'thumbnailUrl', 'uploadDate'],
    recommended: ['duration', 'contentUrl'],
    loses: 'the video thumbnail and duration in results and the video tab',
  },
  Recipe: {
    required: ['name', 'image'],
    recommended: ['recipeIngredient', 'recipeInstructions', 'author', 'datePublished'],
    loses: 'the cook time, rating, and ingredient list on a recipe result',
  },
  JobPosting: {
    required: ['title', 'description', 'datePosted', 'hiringOrganization', 'jobLocation'],
    recommended: ['baseSalary', 'employmentType', 'validThrough'],
    loses: 'inclusion in the job search experience',
  },
  Person: { required: ['name'], recommended: ['url', 'sameAs'], loses: 'the knowledge panel entry' },
  WebPage: { required: [], recommended: ['name', 'description'], loses: 'nothing on its own' },
  ItemList: { required: ['itemListElement'], recommended: [], loses: 'the carousel treatment' },
};

/** Types that inherit another type's rules. */
const TYPE_ALIASES: Record<string, string> = {
  NewsArticle: 'Article',
  BlogPosting: 'Article',
  TechArticle: 'Article',
  ScholarlyArticle: 'Article',
  Report: 'Article',
  Store: 'LocalBusiness',
  Restaurant: 'LocalBusiness',
  ProfessionalService: 'LocalBusiness',
  CollectionPage: 'WebPage',
  ItemPage: 'WebPage',
  AboutPage: 'WebPage',
  ContactPage: 'WebPage',
};

/** Types that describe the page itself, rather than the site or its navigation. */
const PAGE_ENTITY_TYPES = new Set([
  'Article',
  'Product',
  'Event',
  'Recipe',
  'VideoObject',
  'JobPosting',
  'LocalBusiness',
]);

const GOOGLE: NetworkId[] = ['google'];
/** Google stops reading an Article headline around here. */
const HEADLINE_LIMIT = 110;

export function readStructuredData(doc: Document): StructuredData {
  const blocks: SchemaBlock[] = [];
  const scripts = doc.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]');

  for (const [position, script] of [...scripts].entries()) {
    const index = position + 1;
    const raw = (script.textContent ?? '').trim();
    if (raw === '') {
      blocks.push({ index, raw, error: 'The script element is empty.', nodes: [] });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      blocks.push({
        index,
        raw,
        error: error instanceof Error ? error.message : 'The block is not valid JSON.',
        nodes: [],
      });
      continue;
    }
    const roots = Array.isArray(parsed) ? parsed : [parsed];
    const nodes: SchemaNode[] = [];
    let context: string | undefined;
    for (const [rootPosition, root] of roots.entries()) {
      if (!isRecord(root)) continue;
      context ??= readContext(root);
      const rootPath = Array.isArray(parsed) ? `block ${index}[${rootPosition}]` : `block ${index}`;
      collectNodes(root, rootPath, nodes);
    }
    blocks.push({ index, raw, ...pick('context', context), nodes });
  }

  return { blocks, nodes: blocks.flatMap(({ nodes }) => nodes) };
}

/**
 * Walks a block into its nodes. `@graph` is the common way to put several
 * things in one script, and each entry is a node in its own right.
 */
function collectNodes(value: Record<string, unknown>, path: string, into: SchemaNode[]): void {
  const graph = value['@graph'];
  if (Array.isArray(graph)) {
    for (const [position, entry] of graph.entries()) {
      if (isRecord(entry)) collectNodes(entry, `${path} · @graph[${position}]`, into);
    }
    // A wrapper that carries only `@graph` is not itself a node.
    if (readTypes(value).length === 0) return;
  }
  const types = readTypes(value);
  into.push({
    type: types[0] ?? '',
    types,
    ...pick('id', asString(value['@id'])),
    path,
    value,
  });
}

export function auditStructuredData(data: StructuredData, metadata: PageMetadata): SeoFinding[] {
  const findings: SeoFinding[] = [];
  const add = (finding: SeoFinding): void => {
    findings.push(finding);
  };

  if (data.blocks.length === 0) {
    add({
      id: 'schema-missing',
      level: 'info',
      title: 'No structured data',
      detail: 'The page has no JSON-LD, so its result can only ever be a title, a URL, and a snippet — no breadcrumbs, stars, price, or questions.',
      networks: GOOGLE,
      tag: '<script type="application/ld+json">',
    });
    return findings;
  }

  for (const block of data.blocks) {
    if (block.error !== undefined) {
      add({
        id: `schema-invalid-json-${block.index}`,
        code: `schema-invalid-json`,
        level: 'error',
        title: `Block ${block.index} is not valid JSON`,
        detail: `${block.error} A block that cannot be parsed is ignored in full, so everything it described is lost.`,
        networks: GOOGLE,
        tag: `<script type="application/ld+json"> · block ${block.index}`,
      });
      continue;
    }
    if (block.context === undefined) {
      add({
        id: `schema-no-context-${block.index}`,
        code: `schema-no-context`,
        level: 'error',
        title: `Block ${block.index} has no @context`,
        detail: 'Without "@context": "https://schema.org" the vocabulary is undefined and the block is skipped.',
        networks: GOOGLE,
        tag: '@context',
      });
    } else if (!/^https?:\/\/schema\.org\/?$/i.test(block.context)) {
      add({
        id: `schema-odd-context-${block.index}`,
        code: `schema-odd-context`,
        level: 'warning',
        title: `Block ${block.index} declares an unusual @context`,
        detail: `"${block.context}" is not schema.org. Search engines only read the schema.org vocabulary here.`,
        networks: GOOGLE,
        tag: '@context',
      });
    }
    if (block.nodes.length === 0) {
      add({
        id: `schema-no-type-${block.index}`,
        code: `schema-no-type`,
        level: 'error',
        title: `Block ${block.index} declares no @type`,
        detail: 'A node without a type describes nothing a search engine can act on.',
        networks: GOOGLE,
        tag: '@type',
      });
    }
  }

  for (const node of data.nodes) {
    findings.push(...auditNode(node));
  }
  findings.push(...crossCheck(data, metadata));

  const seen = new Set<string>();
  return findings.filter(({ id }) => (seen.has(id) ? false : seen.add(id)));
}

function auditNode(node: SchemaNode): SeoFinding[] {
  const findings: SeoFinding[] = [];
  const rule = ruleFor(node.type);

  if (rule === undefined) {
    if (node.type !== '') {
      findings.push({
        id: `schema-unknown-type-${node.type}-${node.path}`,
        code: `schema-unknown-type-${node.type}`,
        level: 'info',
        title: `${node.type} has no rich result rules here`,
        detail: 'The type is left alone: it is valid schema.org, it simply is not one of the types this preview knows how to check.',
        networks: GOOGLE,
        tag: node.type,
      });
    }
    return findings;
  }

  for (const property of rule.required) {
    if (hasProperty(node.value, property)) continue;
    findings.push({
      id: `schema-required-${node.type}-${property}-${node.path}`,
      code: `schema-required-${node.type}-${property}`,
      level: 'error',
      title: `${node.type} is missing ${property}`,
      detail: `Required for this type. Without it the page loses ${rule.loses}.`,
      networks: GOOGLE,
      tag: `${node.type}.${property}`,
    });
  }
  for (const property of rule.recommended) {
    if (hasProperty(node.value, property)) continue;
    findings.push({
      id: `schema-recommended-${node.type}-${property}-${node.path}`,
      code: `schema-recommended-${node.type}-${property}`,
      level: 'warning',
      title: `${node.type} has no ${property}`,
      detail: `Recommended for this type. The result still appears, with less in it.`,
      networks: GOOGLE,
      tag: `${node.type}.${property}`,
    });
  }

  findings.push(...auditTypeShape(node));
  return findings;
}

/** The per-type checks that are about structure rather than presence. */
function auditTypeShape(node: SchemaNode): SeoFinding[] {
  const findings: SeoFinding[] = [];
  const type = canonicalType(node.type);

  if (type === 'Article') {
    const headline = asString(node.value['headline']);
    if (headline !== undefined && headline.length > HEADLINE_LIMIT) {
      findings.push({
        id: `schema-headline-long-${node.path}`,
        code: `schema-headline-long`,
        level: 'warning',
        title: `headline is ${headline.length} characters`,
        detail: `Google stops reading an Article headline around ${HEADLINE_LIMIT}. Longer ones risk the rich result being dropped rather than trimmed.`,
        networks: GOOGLE,
        tag: 'Article.headline',
      });
    }
    const author = node.value['author'];
    if (author !== undefined && !namedEntity(author)) {
      findings.push({
        id: `schema-author-unnamed-${node.path}`,
        code: `schema-author-unnamed`,
        level: 'warning',
        title: 'author has no name',
        detail: 'An author must be a Person or Organization carrying a name; a bare string or an empty object is not attributed.',
        networks: GOOGLE,
        tag: 'Article.author.name',
      });
    }
  }

  if (type === 'Product') {
    const offers = firstEntity(node.value['offers']);
    const rating = firstEntity(node.value['aggregateRating']);
    const review = node.value['review'];
    if (offers === undefined && rating === undefined && review === undefined) {
      findings.push({
        id: `schema-product-bare-${node.path}`,
        code: `schema-product-bare`,
        level: 'error',
        title: 'Product has no offers, review, or aggregateRating',
        detail: 'A product needs at least one of these to qualify for a rich result. Name and image alone render as an ordinary link.',
        networks: GOOGLE,
        tag: 'Product.offers',
      });
    }
    if (offers !== undefined) {
      for (const property of ['price', 'priceCurrency']) {
        if (hasProperty(offers, property)) continue;
        findings.push({
          id: `schema-offer-${property}-${node.path}`,
          code: `schema-offer-${property}`,
          level: 'error',
          title: `offers is missing ${property}`,
          detail: 'An offer without both a price and its currency shows no price in the result.',
          networks: GOOGLE,
          tag: `Product.offers.${property}`,
        });
      }
      if (!hasProperty(offers, 'availability')) {
        findings.push({
          id: `schema-offer-availability-${node.path}`,
          code: `schema-offer-availability`,
          level: 'warning',
          title: 'offers has no availability',
          detail: 'Without it the result cannot say In stock, which is among the first things a shopper reads.',
          networks: GOOGLE,
          tag: 'Product.offers.availability',
        });
      }
    }
    if (rating !== undefined) {
      for (const property of ['ratingValue', 'reviewCount']) {
        if (hasProperty(rating, property) || (property === 'reviewCount' && hasProperty(rating, 'ratingCount'))) continue;
        findings.push({
          id: `schema-rating-${property}-${node.path}`,
          code: `schema-rating-${property}`,
          level: 'error',
          title: `aggregateRating is missing ${property}`,
          detail: 'A rating without both a value and a count is dropped rather than shown with a blank.',
          networks: GOOGLE,
          tag: `Product.aggregateRating.${property}`,
        });
      }
    }
  }

  if (type === 'BreadcrumbList') {
    const items = asArray(node.value['itemListElement']);
    if (items.length === 0 && hasProperty(node.value, 'itemListElement')) {
      findings.push({
        id: `schema-breadcrumb-empty-${node.path}`,
        code: `schema-breadcrumb-empty`,
        level: 'error',
        title: 'BreadcrumbList has no items',
        detail: 'An empty itemListElement produces no trail at all.',
        networks: GOOGLE,
        tag: 'BreadcrumbList.itemListElement',
      });
    }
    for (const [position, entry] of items.entries()) {
      if (!isRecord(entry)) continue;
      const last = position === items.length - 1;
      if (!hasProperty(entry, 'name')) {
        findings.push({
          id: `schema-breadcrumb-name-${position}-${node.path}`,
          code: `schema-breadcrumb-name`,
          level: 'error',
          title: `Breadcrumb ${position + 1} has no name`,
          detail: 'Every crumb needs the text to display.',
          networks: GOOGLE,
          tag: `BreadcrumbList.itemListElement[${position}].name`,
        });
      }
      if (!hasProperty(entry, 'position')) {
        findings.push({
          id: `schema-breadcrumb-position-${position}-${node.path}`,
          code: `schema-breadcrumb-position`,
          level: 'error',
          title: `Breadcrumb ${position + 1} has no position`,
          detail: 'Positions order the trail; without them the crumbs are unordered and the trail is dropped.',
          networks: GOOGLE,
          tag: `BreadcrumbList.itemListElement[${position}].position`,
        });
      }
      // The final crumb is the current page, so it may omit its own link.
      if (!last && !hasProperty(entry, 'item')) {
        findings.push({
          id: `schema-breadcrumb-item-${position}-${node.path}`,
          code: `schema-breadcrumb-item`,
          level: 'warning',
          title: `Breadcrumb ${position + 1} has no item URL`,
          detail: 'Every crumb but the last should link somewhere, otherwise the trail is not navigable.',
          networks: GOOGLE,
          tag: `BreadcrumbList.itemListElement[${position}].item`,
        });
      }
    }
  }

  if (type === 'FAQPage') {
    const questions = asArray(node.value['mainEntity']);
    if (questions.length === 0 && hasProperty(node.value, 'mainEntity')) {
      findings.push({
        id: `schema-faq-empty-${node.path}`,
        code: `schema-faq-empty`,
        level: 'error',
        title: 'FAQPage has no questions',
        detail: 'An empty mainEntity produces no expandable rows.',
        networks: GOOGLE,
        tag: 'FAQPage.mainEntity',
      });
    }
    for (const [position, entry] of questions.entries()) {
      if (!isRecord(entry)) continue;
      const answer = firstEntity(entry['acceptedAnswer']);
      if (!hasProperty(entry, 'name')) {
        findings.push({
          id: `schema-faq-name-${position}-${node.path}`,
          code: `schema-faq-name`,
          level: 'error',
          title: `Question ${position + 1} has no name`,
          detail: 'The question text is what the row displays.',
          networks: GOOGLE,
          tag: `FAQPage.mainEntity[${position}].name`,
        });
      }
      if (answer === undefined || !hasProperty(answer, 'text')) {
        findings.push({
          id: `schema-faq-answer-${position}-${node.path}`,
          code: `schema-faq-answer`,
          level: 'error',
          title: `Question ${position + 1} has no acceptedAnswer text`,
          detail: 'A question without an answer is dropped, and one bad entry can cost the whole set.',
          networks: GOOGLE,
          tag: `FAQPage.mainEntity[${position}].acceptedAnswer.text`,
        });
      }
    }
  }

  if (type === 'WebSite' && hasProperty(node.value, 'potentialAction')) {
    const action = firstEntity(node.value['potentialAction']);
    if (action !== undefined && !hasProperty(action, 'target')) {
      findings.push({
        id: `schema-searchaction-target-${node.path}`,
        code: `schema-searchaction-target`,
        level: 'warning',
        title: 'potentialAction has no target',
        detail: 'A SearchAction without a target URL template cannot produce a sitelinks search box.',
        networks: GOOGLE,
        tag: 'WebSite.potentialAction.target',
      });
    }
  }

  return findings;
}

/**
 * Compares the schema against the page's own tags.
 *
 * These are the findings a validator run on the JSON alone cannot produce: the
 * schema is internally valid and still describes a different page than the one
 * it sits on.
 */
function crossCheck(data: StructuredData, metadata: PageMetadata): SeoFinding[] {
  const findings: SeoFinding[] = [];
  // Only a node that describes *this page* can disagree with it. An
  // Organization or a WebSite names the site, and a BreadcrumbList names the
  // path to it; comparing any of those to the page title invents a conflict.
  const main = data.nodes.find(({ type }) => PAGE_ENTITY_TYPES.has(canonicalType(type)))
    ?? data.nodes.find(({ type }) => canonicalType(type) === 'WebPage');
  if (main === undefined) return findings;

  const headline = asString(main.value['headline']) ?? asString(main.value['name']);
  const pageTitle = metadata.og.title ?? metadata.title;
  if (headline !== undefined && pageTitle !== undefined && !comparable(headline, pageTitle)) {
    findings.push({
      id: 'schema-title-mismatch',
      level: 'warning',
      title: 'The schema and the page disagree about the title',
      detail: `The schema says "${headline}" and the page says "${pageTitle}". Google treats a schema that contradicts the visible page as a reason to distrust it.`,
      networks: GOOGLE,
      tag: `${main.type}.${main.value['headline'] === undefined ? 'name' : 'headline'}`,
    });
  }

  const image = firstImageUrl(main.value['image']);
  if (image !== undefined && metadata.og.image !== undefined && !sameUrl(image, metadata.og.image)) {
    findings.push({
      id: 'schema-image-mismatch',
      level: 'warning',
      title: 'The schema and og:image point at different images',
      detail: `The schema uses "${image}" while og:image uses "${metadata.og.image}". Social cards and search results will show different pictures of the same page.`,
      networks: ['google', 'facebook', 'x'],
      tag: `${main.type}.image`,
    });
  }

  const url = asString(main.value['url']) ?? main.id;
  const canonical = metadata.canonical ?? metadata.og.url;
  if (url !== undefined && canonical !== undefined && !sameUrl(url, canonical)) {
    findings.push({
      id: 'schema-url-mismatch',
      level: 'warning',
      title: 'The schema url is not the canonical URL',
      detail: `The schema claims "${url}" while the page is canonically "${canonical}". The structured data is being attributed to another address.`,
      networks: GOOGLE,
      tag: `${main.type}.url`,
    });
  }

  return findings;
}

/** What the schema will actually add to the Google card. */
export function resolveRichResult(data: StructuredData): RichResult {
  const result: RichResult = {};

  const breadcrumbs = data.nodes.find(({ type }) => canonicalType(type) === 'BreadcrumbList');
  if (breadcrumbs !== undefined) {
    const crumbs = asArray(breadcrumbs.value['itemListElement'])
      .map((entry) => (isRecord(entry) ? asString(entry['name']) : undefined))
      .filter((name): name is string => name !== undefined && name !== '');
    if (crumbs.length > 0) result.breadcrumbs = crumbs;
  }

  for (const node of data.nodes) {
    const rating = firstEntity(node.value['aggregateRating']);
    const value = rating === undefined ? undefined : asNumber(rating['ratingValue']);
    if (result.rating === undefined && rating !== undefined && value !== undefined) {
      const count = asNumber(rating['reviewCount']) ?? asNumber(rating['ratingCount']);
      result.rating = {
        value,
        best: asNumber(rating['bestRating']) ?? 5,
        ...pick('count', count),
      };
    }

    const offer = firstEntity(node.value['offers']);
    if (result.offer === undefined && offer !== undefined) {
      const price = asString(offer['price']) ?? asNumber(offer['price'])?.toString();
      result.offer = {
        ...pick('price', price),
        ...pick('currency', asString(offer['priceCurrency'])),
        ...pick('availability', asString(offer['availability'])?.replace(/^.*\//, '')),
      };
    }

    if (result.faq === undefined && canonicalType(node.type) === 'FAQPage') {
      const questions = asArray(node.value['mainEntity'])
        .map((entry) => {
          if (!isRecord(entry)) return undefined;
          const question = asString(entry['name']);
          const answer = asString(firstEntity(entry['acceptedAnswer'])?.['text']);
          return question === undefined ? undefined : { question, answer: stripTags(answer ?? '') };
        })
        .filter((entry): entry is { question: string; answer: string } => entry !== undefined);
      if (questions.length > 0) result.faq = questions;
    }

    if (result.siteName === undefined && ['Organization', 'WebSite'].includes(canonicalType(node.type))) {
      const name = asString(node.value['name']);
      if (name !== undefined) result.siteName = name;
    }

    if (result.datePublished === undefined) {
      const published = asString(node.value['datePublished']);
      if (published !== undefined) result.datePublished = published;
    }
    if (result.author === undefined) {
      const author = firstEntity(node.value['author']);
      const name = author === undefined ? undefined : asString(author['name']);
      if (name !== undefined) result.author = name;
    }
  }

  return result;
}

/**
 * One entity, reduced to the handful of values that decide how it is drawn.
 *
 * JSON is not what a schema *is* — it is how it is written down. A Product is a
 * thing with a price and a rating; an Article is a thing with a byline and a
 * date. This is the shape a card can be built from, so nobody has to read
 * braces to find out what their page claims to be.
 */
export type EntityView = {
  /** The canonical type, after aliases: NewsArticle reads as Article. */
  type: string;
  /** The type as authored, which is what the page actually says. */
  label: string;
  name?: string;
  description?: string;
  image?: string;
  url?: string;
  rating?: { value: number; best: number; count?: number };
  offer?: { price?: string; currency?: string; availability?: string };
  brand?: string;
  sku?: string;
  author?: string;
  publisher?: string;
  datePublished?: string;
  duration?: string;
  startDate?: string;
  location?: string;
  address?: string;
  telephone?: string;
  breadcrumbs?: Array<{ name: string; url?: string }>;
  faq?: Array<{ question: string; answer: string }>;
  sameAs?: string[];
  /** Whatever else the node declares, for the card that has no special shape. */
  fields: Array<{ label: string; value: string }>;
};

const DISPLAYED_SEPARATELY = new Set([
  '@context', '@type', '@id', '@graph',
  'name', 'headline', 'description', 'image', 'url', 'aggregateRating', 'offers',
  'brand', 'sku', 'author', 'publisher', 'datePublished', 'duration', 'startDate',
  'location', 'address', 'telephone', 'itemListElement', 'mainEntity', 'sameAs',
]);

export function describeEntity(node: SchemaNode): EntityView {
  const value = node.value;
  const type = canonicalType(node.type);
  const view: EntityView = {
    type,
    label: node.types.join(' + ') || 'Untyped',
    ...pick('name', asString(value['headline']) ?? asString(value['name']) ?? asString(value['title'])),
    ...pick('description', asString(value['description'])),
    ...pick('image', firstImageUrl(value['image']) ?? asString(value['thumbnailUrl'])),
    ...pick('url', asString(value['url']) ?? node.id),
    ...pick('brand', entityName(value['brand'])),
    ...pick('sku', asString(value['sku'])),
    ...pick('author', entityName(value['author'])),
    ...pick('publisher', entityName(value['publisher'])),
    ...pick('datePublished', asString(value['datePublished']) ?? asString(value['uploadDate']) ?? asString(value['datePosted'])),
    ...pick('duration', formatDuration(asString(value['duration']) ?? asString(value['totalTime']))),
    ...pick('startDate', asString(value['startDate'])),
    ...pick('location', entityName(value['location']) ?? entityName(value['jobLocation'])),
    ...pick('address', formatAddress(value['address'])),
    ...pick('telephone', asString(value['telephone'])),
    ...pick('sameAs', stringList(value['sameAs'])),
    fields: [],
  };

  const rating = firstEntity(value['aggregateRating']);
  const ratingValue = rating === undefined ? undefined : asNumber(rating['ratingValue']);
  if (rating !== undefined && ratingValue !== undefined) {
    view.rating = {
      value: ratingValue,
      best: asNumber(rating['bestRating']) ?? 5,
      ...pick('count', asNumber(rating['reviewCount']) ?? asNumber(rating['ratingCount'])),
    };
  }

  const offer = firstEntity(value['offers']);
  if (offer !== undefined) {
    view.offer = {
      ...pick('price', asString(offer['price']) ?? asNumber(offer['price'])?.toString()),
      ...pick('currency', asString(offer['priceCurrency'])),
      ...pick('availability', asString(offer['availability'])?.replace(/^.*\//, '')),
    };
  }

  if (type === 'BreadcrumbList') {
    const crumbs = asArray(value['itemListElement'])
      .map((entry) => {
        if (!isRecord(entry)) return undefined;
        const name = asString(entry['name']) ?? entityName(entry['item']);
        if (name === undefined) return undefined;
        const item = entry['item'];
        const url = asString(item) ?? (isRecord(item) ? asString(item['@id']) ?? asString(item['url']) : undefined);
        return { name, ...pick('url', url) };
      })
      .filter((entry): entry is { name: string; url?: string } => entry !== undefined);
    if (crumbs.length > 0) view.breadcrumbs = crumbs;
  }

  if (type === 'FAQPage' || type === 'QAPage') {
    const questions = asArray(value['mainEntity'])
      .map((entry) => {
        if (!isRecord(entry)) return undefined;
        const question = asString(entry['name']);
        const answer = asString(firstEntity(entry['acceptedAnswer'])?.['text'] ?? entry['text']);
        return question === undefined ? undefined : { question, answer: stripTags(answer ?? '') };
      })
      .filter((entry): entry is { question: string; answer: string } => entry !== undefined);
    if (questions.length > 0) view.faq = questions;
  }

  for (const [key, raw] of Object.entries(value)) {
    if (DISPLAYED_SEPARATELY.has(key)) continue;
    const text = displayValue(raw);
    if (text !== undefined) view.fields.push({ label: key, value: text });
  }

  return view;
}

function entityName(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value.trim();
  const entity = firstEntity(value);
  return entity === undefined ? undefined : asString(entity['name']);
}

function stringList(value: unknown): string[] | undefined {
  const entries = (Array.isArray(value) ? value : [value])
    .map((entry) => asString(entry))
    .filter((entry): entry is string => entry !== undefined);
  return entries.length === 0 ? undefined : entries;
}

function formatAddress(value: unknown): string | undefined {
  if (typeof value === 'string') return asString(value);
  const entity = firstEntity(value);
  if (entity === undefined) return undefined;
  const parts = ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry']
    .map((key) => asString(entity[key]))
    .filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(', ');
}

/** ISO 8601 durations are unreadable; a result shows minutes. */
export function formatDuration(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (match === null) return value;
  const [, days, hours, minutes, seconds] = match;
  const parts = [
    days === undefined ? undefined : `${days} day${days === '1' ? '' : 's'}`,
    hours === undefined ? undefined : `${hours} hr`,
    minutes === undefined ? undefined : `${minutes} min`,
    seconds === undefined && (hours !== undefined || minutes !== undefined) ? undefined
      : seconds === undefined ? undefined : `${seconds} sec`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? value : parts.join(' ');
}

/** A short, readable rendering of an arbitrary property. */
function displayValue(value: unknown): string | undefined {
  if (typeof value === 'string') return asString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((entry) => displayValue(entry)).filter((part): part is string => part !== undefined);
    return parts.length === 0 ? undefined : parts.slice(0, 4).join(', ') + (parts.length > 4 ? `, +${parts.length - 4} more` : '');
  }
  if (isRecord(value)) return entityName(value) ?? asString(value['@id']) ?? undefined;
  return undefined;
}

/** A compact rendering of the schema for the agent brief. */
export function describeStructuredData(data: StructuredData): string {
  if (data.blocks.length === 0) return 'Structured data: none on this page.';
  return [
    `Structured data: ${data.blocks.length} block${data.blocks.length === 1 ? '' : 's'}.`,
    ...data.blocks.map((block) => {
      if (block.error !== undefined) return `  block ${block.index}: unparseable — ${block.error}`;
      const types = block.nodes.map(({ type, path }) => `${type || '(no @type)'} at ${path}`).join(', ');
      return `  block ${block.index}: ${types === '' ? '(no nodes)' : types}`;
    }),
  ].join('\n');
}

export function canonicalType(type: string): string {
  return TYPE_ALIASES[type] ?? type;
}

function ruleFor(type: string): TypeRule | undefined {
  return TYPE_RULES[canonicalType(type)];
}

function readContext(root: Record<string, unknown>): string | undefined {
  const context = root['@context'];
  if (typeof context === 'string') return context;
  if (isRecord(context)) return asString(context['@vocab']);
  if (Array.isArray(context)) {
    for (const entry of context) {
      if (typeof entry === 'string') return entry;
    }
  }
  return undefined;
}

function readTypes(value: Record<string, unknown>): string[] {
  const type = value['@type'];
  if (typeof type === 'string') return [type];
  if (Array.isArray(type)) return type.filter((entry): entry is string => typeof entry === 'string');
  return [];
}

function hasProperty(value: Record<string, unknown>, property: string): boolean {
  const found = value[property];
  if (found === undefined || found === null) return false;
  if (typeof found === 'string') return found.trim() !== '';
  if (Array.isArray(found)) return found.length > 0;
  if (isRecord(found)) return Object.keys(found).length > 0;
  return true;
}

/** A property that may be a single entity or an array of them. */
function firstEntity(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (isRecord(entry)) return entry;
    }
  }
  return undefined;
}

function namedEntity(value: unknown): boolean {
  const entity = firstEntity(value);
  if (entity !== undefined) return hasProperty(entity, 'name');
  return false;
}

function firstImageUrl(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = firstImageUrl(entry);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const entity = firstEntity(value);
  return entity === undefined ? undefined : asString(entity['url']) ?? asString(entity['contentUrl']);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Answers are commonly authored as HTML, which a result renders as text. */
function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function comparable(first: string, second: string): boolean {
  const normalize = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();
  const a = normalize(first);
  const b = normalize(second);
  // Either one containing the other is agreement, not contradiction. A site
  // name is as often a prefix as a suffix — "Acme Tools Trade Counter" beside
  // "Trade counter · Acme Tools" is one page described twice, not two pages.
  return a === b || b.includes(a) || a.includes(b);
}

function sameUrl(first: string, second: string): boolean {
  const normalize = (value: string): string => value.replace(/\/+$/, '').toLowerCase();
  return normalize(first) === normalize(second);
}

function pick<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}
