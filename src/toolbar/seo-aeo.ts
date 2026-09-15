/**
 * What an answer engine can take from this page.
 *
 * Search shows your page; an answer engine reads it, states what it says, and
 * cites you if you are lucky. Those are different jobs, and a page can be
 * excellent at the first and useless at the second — beautiful cards, and not
 * one extractable fact, quotable sentence, or byline to attribute.
 *
 * Nothing here predicts what a model will do. It reports what is *available* to
 * one: the typed entity, the facts stated plainly enough to lift, the question
 * and answer pairs, the provenance that makes a citation possible, and whether
 * the text exists before JavaScript runs. The answer shown alongside is built
 * from those extracted values by a template — it is what the page affords, not
 * a model's output, and it says so.
 */

import type { PageMetadata, SeoFinding } from './seo-metadata.js';
import { describeEntity, type EntityView, type StructuredData } from './seo-schema.js';

export type ExtractedFact = {
  label: string;
  value: string;
  /** Where the fact came from, since a fact in schema is far easier to lift. */
  source: 'schema' | 'meta';
};

export type QuotableUnit = {
  question: string;
  answer: string;
  source: 'faq' | 'heading';
};

export type AeoExtraction = {
  /** The thing the page is about, when it says so. */
  entity?: { type: string; label: string; name: string };
  facts: ExtractedFact[];
  quotable: QuotableUnit[];
  provenance: {
    author?: string;
    publisher?: string;
    published?: string;
    canonical?: string;
  };
  headings: Array<{ level: number; text: string }>;
  /** Words of readable text in the page as rendered. */
  renderedWords: number;
  /**
   * Words present before JavaScript runs. Undefined until the raw HTML has been
   * fetched; an engine that does not execute scripts sees only these.
   */
  serverWords?: number;
  /** Directives that permit or forbid quoting, as authored. */
  robots?: string;
  aiPolicy?: string;
};

export type AeoAnswer = {
  /** Assembled from the extracted values. Never a model's output. */
  sentence: string;
  citation: string;
  /** How much the page gave the sentence to work with. */
  grounding: 'strong' | 'partial' | 'thin';
};

const AEO: SeoFinding['networks'] = ['google'];
/** Below this there is not enough prose to quote a passage from. */
const THIN_CONTENT_WORDS = 120;
/** A rendered page this much larger than its HTML is mostly built by scripts. */
const CLIENT_RENDER_RATIO = 0.4;

/**
 * Elements that are furniture rather than content.
 *
 * Deliberately short. `header` and `aside` are not on it: an article header
 * carries the byline and an aside is as often a callout as a sidebar, and
 * dropping real prose would invent a thin-content warning on a page that has
 * plenty. Counting a little boilerplate is the cheaper mistake.
 */
const NON_CONTENT = 'script, style, noscript, template, svg, nav, footer, astro-dev-toolbar, vite-error-overlay, [data-astro-ai-ui]';

/** Where the page's own content lives, when it says so. */
const CONTENT_ROOT = 'main, article, [role="main"]';

export function extractForAnswerEngines(
  doc: Document,
  metadata: PageMetadata,
  data: StructuredData,
): AeoExtraction {
  const entities = data.nodes.map((node) => describeEntity(node));
  const subject = entities.find((entity) => SUBJECT_TYPES.has(entity.type) && entity.name !== undefined);

  const facts: ExtractedFact[] = [];
  const seen = new Set<string>();
  const addFact = (label: string, value: string | undefined, source: ExtractedFact['source']): void => {
    if (value === undefined || value === '' || seen.has(label)) return;
    seen.add(label);
    facts.push({ label, value, source });
  };

  if (subject !== undefined) {
    addFact('Name', subject.name, 'schema');
    if (subject.offer?.price !== undefined) {
      addFact('Price', `${subject.offer.currency ?? ''} ${subject.offer.price}`.trim(), 'schema');
    }
    if (subject.offer?.availability !== undefined) addFact('Availability', spaced(subject.offer.availability), 'schema');
    if (subject.rating !== undefined) {
      addFact(
        'Rating',
        `${subject.rating.value} out of ${subject.rating.best}${subject.rating.count === undefined ? '' : ` from ${subject.rating.count} reviews`}`,
        'schema',
      );
    }
    addFact('Brand', subject.brand, 'schema');
    addFact('SKU', subject.sku, 'schema');
    addFact('Starts', subject.startDate, 'schema');
    addFact('Location', subject.location ?? subject.address, 'schema');
    addFact('Duration', subject.duration, 'schema');
    addFact('Telephone', subject.telephone, 'schema');
    addFact('Salary', readSalary(subject), 'schema');
  }
  addFact('Summary', metadata.og.description ?? metadata.description, 'meta');

  const quotable: QuotableUnit[] = [];
  for (const entity of entities) {
    for (const entry of entity.faq ?? []) {
      if (entry.answer === '') continue;
      quotable.push({ question: entry.question, answer: entry.answer, source: 'faq' });
    }
  }

  const body = readableBody(doc);
  const headings = body === undefined ? [] : readHeadings(body);
  // A heading phrased as a question, with prose under it, is the shape an
  // answer engine lifts when there is no FAQ schema to read.
  if (body !== undefined) {
    for (const heading of headingSections(body)) {
      if (!/\?\s*$/.test(heading.text) || heading.answer === '') continue;
      if (quotable.some((unit) => comparableText(unit.question, heading.text))) continue;
      quotable.push({ question: heading.text, answer: heading.answer, source: 'heading' });
    }
  }

  const author = subject?.author ?? entities.find((entity) => entity.author !== undefined)?.author;
  const publisher = subject?.publisher
    ?? entities.find((entity) => entity.type === 'Organization')?.name
    ?? metadata.og.siteName;
  const published = subject?.datePublished ?? entities.find((entity) => entity.datePublished !== undefined)?.datePublished;

  return {
    ...(subject === undefined || subject.name === undefined
      ? {}
      : { entity: { type: subject.type, label: subject.label, name: subject.name } }),
    facts,
    quotable,
    provenance: {
      ...pick('author', author),
      ...pick('publisher', publisher),
      ...pick('published', published),
      ...pick('canonical', metadata.canonical ?? metadata.og.url),
    },
    headings,
    renderedWords: body === undefined ? 0 : countWords(body.textContent ?? ''),
    ...pick('robots', metadata.robots),
    ...pick('aiPolicy', readAiPolicy(doc)),
  };
}

/** Subjects that are written by somebody, and so carry a byline and a date. */
const AUTHORED_TYPES = new Set(['Article', 'Recipe', 'Book', 'Course']);

/** Types that can be the subject of an answer, as opposed to site furniture. */
const SUBJECT_TYPES = new Set([
  'Product', 'Article', 'Recipe', 'Event', 'VideoObject', 'JobPosting',
  'LocalBusiness', 'Person', 'SoftwareApplication', 'Course', 'Book',
]);

/**
 * Counts the words present before scripts run.
 *
 * The sheet reads the rendered DOM, which is the page after hydration. Most
 * answer engines are not browsers: they read the HTML as served. Where the two
 * disagree, everything built on the client is invisible to them, and this is
 * the only way to see that from inside the page.
 */
export function measureServerText(html: string, parse: (markup: string) => Document): number {
  const doc = parse(html);
  const body = readableBody(doc);
  return body === undefined ? 0 : countWords(body.textContent ?? '');
}

/**
 * Assembles the answer this page affords, from the values actually extracted.
 *
 * A template, not a model: every clause is a fact the page stated, so the
 * sentence can only be as good as the page. That is the point — a thin sentence
 * here means a thin page, not a cautious model.
 */
export function composeAnswer(extraction: AeoExtraction, metadata: PageMetadata): AeoAnswer {
  const citation = metadata.domain;
  const facts = new Map(extraction.facts.map(({ label, value }) => [label, value]));
  const name = extraction.entity?.name ?? metadata.og.title ?? metadata.title;

  if (name === undefined) {
    return {
      sentence: `There is no named subject on this page, so an assistant has nothing to attribute an answer to.`,
      citation,
      grounding: 'thin',
    };
  }

  const clauses: string[] = [];
  const price = facts.get('Price');
  const rating = facts.get('Rating');
  const availability = facts.get('Availability');
  const starts = facts.get('Starts');
  const location = facts.get('Location');
  const duration = facts.get('Duration');

  if (price !== undefined) clauses.push(`costs ${price}`);
  if (rating !== undefined) clauses.push(`is rated ${rating}`);
  if (availability !== undefined) clauses.push(`is listed as ${availability.toLowerCase()}`);
  if (starts !== undefined) clauses.push(`starts ${starts}`);
  if (location !== undefined) clauses.push(`is at ${location}`);
  if (duration !== undefined) clauses.push(`takes ${duration}`);

  // Something that was written is answered with its byline, which is also the
  // part an assistant needs in order to attribute the claim to anyone.
  if (extraction.entity !== undefined && AUTHORED_TYPES.has(extraction.entity.type)) {
    const { author, published } = extraction.provenance;
    if (author !== undefined) clauses.push(`was written by ${author}`);
    if (published !== undefined) clauses.push(`was published on ${published}`);
  }

  const summary = facts.get('Summary');
  if (clauses.length > 0) {
    return {
      sentence: `${name} ${joinClauses(clauses)}.`,
      citation,
      grounding: clauses.length >= 2 ? 'strong' : 'partial',
    };
  }
  if (summary !== undefined) {
    return { sentence: `${name} — ${trimSentence(summary)}`, citation, grounding: 'partial' };
  }
  return {
    sentence: `${name}. The page states no fact an assistant could quote beyond its title.`,
    citation,
    grounding: 'thin',
  };
}

export function auditAnswerReadiness(
  extraction: AeoExtraction,
  metadata: PageMetadata,
  data: StructuredData,
): SeoFinding[] {
  const findings: SeoFinding[] = [];
  const add = (finding: SeoFinding): void => {
    findings.push(finding);
  };

  const robots = (extraction.robots ?? '').toLowerCase();
  if (robots.includes('nosnippet')) {
    add({
      id: 'aeo-nosnippet',
      level: 'error',
      title: 'robots forbids snippets',
      detail: '`nosnippet` tells search and answer engines they may not quote any part of this page. The page can be indexed and still never be the source of an answer.',
      networks: AEO,
      tag: '<meta name="robots" content="nosnippet">',
    });
  }
  if (robots.includes('noindex')) {
    add({
      id: 'aeo-noindex',
      level: 'info',
      title: 'The page is not indexed, so it cannot be cited',
      detail: 'An answer engine retrieves from an index. A noindex page is outside every one of them.',
      networks: AEO,
      tag: '<meta name="robots">',
    });
  }
  if (extraction.aiPolicy !== undefined) {
    add({
      id: 'aeo-ai-policy',
      level: 'info',
      title: `The page declares "${extraction.aiPolicy}"`,
      detail: 'A deliberate opt-out from AI use. Nothing to fix if it is intended — worth knowing if it is not.',
      networks: AEO,
      tag: '<meta name="robots" content="noai">',
    });
  }

  if (extraction.entity === undefined) {
    add({
      id: 'aeo-no-entity',
      level: data.nodes.length === 0 ? 'warning' : 'info',
      title: 'The page names no subject an answer can be about',
      detail: data.nodes.length === 0
        ? 'With no structured data, an engine has to infer what this page is about from prose. A typed entity — Product, Article, Recipe, Event — states it outright.'
        : 'The structured data here describes the site or its navigation, not a thing the page is about.',
      networks: AEO,
      tag: '<script type="application/ld+json">',
    });
  }

  const schemaFacts = extraction.facts.filter(({ source }) => source === 'schema').length;
  if (schemaFacts < 2) {
    add({
      id: 'aeo-thin-facts',
      level: 'warning',
      title: 'Almost nothing here can be quoted as a fact',
      detail: 'An answer engine states specifics — a price, a rating, a date, a duration. Facts declared in structured data are lifted verbatim; facts buried in prose usually are not.',
      networks: AEO,
      tag: '<script type="application/ld+json">',
    });
  }

  if (extraction.quotable.length === 0) {
    add({
      id: 'aeo-no-qa',
      level: 'info',
      title: 'No question and answer pairs',
      detail: 'Assistants answer questions. A FAQPage, or headings phrased as questions with a direct answer beneath, give them something shaped like the thing they are producing.',
      networks: AEO,
      tag: 'FAQPage.mainEntity',
    });
  }

  if (extraction.renderedWords < THIN_CONTENT_WORDS) {
    add({
      id: 'aeo-thin-content',
      level: 'warning',
      title: `Only ${extraction.renderedWords} words of readable text`,
      detail: `Under ${THIN_CONTENT_WORDS} words there is rarely a passage worth quoting, whatever the tags say.`,
      networks: AEO,
    });
  }

  if (
    extraction.serverWords !== undefined &&
    extraction.renderedWords > THIN_CONTENT_WORDS &&
    extraction.serverWords < extraction.renderedWords * CLIENT_RENDER_RATIO
  ) {
    add({
      id: 'aeo-client-rendered',
      level: 'error',
      title: 'Most of the text only exists after JavaScript runs',
      detail: `The HTML as served carries ${extraction.serverWords} words; the rendered page has ${extraction.renderedWords}. Search crawlers usually execute scripts eventually, and most answer engines do not — what they read is the smaller number.`,
      networks: AEO,
    });
  }

  if (extraction.headings.length === 0) {
    add({
      id: 'aeo-no-headings',
      level: 'warning',
      title: 'The page has no headings',
      detail: 'Headings are how a passage is located and how a section earns a citation of its own. Without them the page is one undifferentiated block.',
      networks: AEO,
      tag: '<h1>',
    });
  }

  const { author, published, canonical, publisher } = extraction.provenance;
  // A byline is provenance for something written. A product or a venue is
  // attributed to whoever publishes it, and asking a catalogue page for an
  // author is noise rather than advice.
  const authored = extraction.entity === undefined || AUTHORED_TYPES.has(extraction.entity.type);
  const missing = [
    authored && author === undefined ? 'author' : undefined,
    authored && published === undefined ? 'published date' : undefined,
    publisher === undefined ? 'publisher' : undefined,
  ].filter((part): part is string => part !== undefined);
  if (missing.length > 0) {
    add({
      id: 'aeo-weak-provenance',
      level: missing.length >= 3 ? 'warning' : 'info',
      title: `No ${missing.join(' or ')}`,
      detail: 'Assistants prefer sources they can attribute and date. Provenance is what separates a page worth citing from one worth paraphrasing without credit.',
      networks: AEO,
      tag: 'Article.author',
    });
  }
  if (canonical === undefined) {
    add({
      id: 'aeo-no-canonical',
      level: 'warning',
      title: 'No canonical URL to cite',
      detail: 'A citation needs one address. Without a canonical link the same page can be cited under several, splitting whatever credit it earns.',
      networks: AEO,
      tag: '<link rel="canonical">',
    });
  }

  return findings.sort((first, second) => rank(first.level) - rank(second.level));
}

/** A compact rendering of the extraction for the agent brief. */
export function describeExtractionForAgent(extraction: AeoExtraction): string {
  return [
    'What an answer engine can take from this page:',
    `  Subject: ${extraction.entity === undefined ? '(none declared)' : `${extraction.entity.label} · ${extraction.entity.name}`}`,
    `  Facts: ${extraction.facts.length === 0 ? '(none)' : extraction.facts.map(({ label, value }) => `${label}=${value}`).join('; ')}`,
    `  Question and answer pairs: ${extraction.quotable.length}`,
    `  Readable words: ${extraction.renderedWords}${extraction.serverWords === undefined ? '' : ` rendered, ${extraction.serverWords} in the HTML as served`}`,
    `  Provenance: author=${extraction.provenance.author ?? '(none)'}, published=${extraction.provenance.published ?? '(none)'}, publisher=${extraction.provenance.publisher ?? '(none)'}, canonical=${extraction.provenance.canonical ?? '(none)'}`,
  ].join('\n');
}

function readableBody(doc: Document): HTMLElement | undefined {
  // A page that marks its own main content is taken at its word; everything
  // else is read whole, minus the parts that are plainly not prose.
  const root = doc.querySelector<HTMLElement>(CONTENT_ROOT) ?? doc.body;
  if (root === null) return undefined;
  const clone = root.cloneNode(true) as HTMLElement;
  for (const node of clone.querySelectorAll(NON_CONTENT)) node.remove();
  return clone;
}

function readHeadings(body: HTMLElement): Array<{ level: number; text: string }> {
  return [...body.querySelectorAll('h1, h2, h3')]
    .map((node) => ({ level: Number(node.tagName.slice(1)), text: normalize(node.textContent ?? '') }))
    .filter(({ text }) => text !== '');
}

/** Each heading with the prose that follows it, up to the next heading. */
function headingSections(body: HTMLElement): Array<{ text: string; answer: string }> {
  const sections: Array<{ text: string; answer: string }> = [];
  for (const heading of body.querySelectorAll('h1, h2, h3, h4')) {
    const text = normalize(heading.textContent ?? '');
    if (text === '') continue;
    const parts: string[] = [];
    let sibling = heading.nextElementSibling;
    while (sibling !== null && !/^H[1-4]$/.test(sibling.tagName)) {
      const content = normalize(sibling.textContent ?? '');
      if (content !== '') parts.push(content);
      if (parts.join(' ').length > 400) break;
      sibling = sibling.nextElementSibling;
    }
    sections.push({ text, answer: trimSentence(parts.join(' ')) });
  }
  return sections;
}

/** Signals a page uses to opt out of AI use, as they are written today. */
function readAiPolicy(doc: Document): string | undefined {
  for (const meta of doc.querySelectorAll('meta')) {
    const name = meta.getAttribute('name')?.toLowerCase();
    const content = meta.getAttribute('content')?.trim();
    if (content === undefined || content === '') continue;
    if (name === 'robots' || name === 'googlebot') {
      const directive = content.toLowerCase();
      if (/\bnoai\b|\bnoimageai\b/.test(directive)) return content;
    }
    if (name !== undefined && ['noai', 'ai-policy'].includes(name)) return content;
  }
  return undefined;
}

function countWords(text: string): number {
  const normalized = normalize(text);
  return normalized === '' ? 0 : normalized.split(' ').length;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function trimSentence(text: string, limit = 180): string {
  const normalized = normalize(text);
  if (normalized.length <= limit) return normalized;
  const cut = normalized.slice(0, limit);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' '));
  return `${cut.slice(0, stop > limit * 0.5 ? stop : limit).trimEnd()}…`;
}

function comparableText(first: string, second: string): boolean {
  return normalize(first).toLowerCase() === normalize(second).toLowerCase();
}

/** A salary range stated plainly enough for an assistant to repeat. */
function readSalary(subject: EntityView): string | undefined {
  const salary = subject.fields.find(({ label }) => label === 'baseSalary');
  return salary?.value;
}

function spaced(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function joinClauses(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

function rank(level: SeoFinding['level']): number {
  return level === 'error' ? 0 : level === 'warning' ? 1 : 2;
}

function pick<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

export type { EntityView };
