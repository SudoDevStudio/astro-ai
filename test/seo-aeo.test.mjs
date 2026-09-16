import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { readPageMetadata } from '../dist/toolbar/seo-metadata.js';
import { readStructuredData } from '../dist/toolbar/seo-schema.js';
import {
  auditAnswerReadiness,
  composeAnswer,
  describeExtractionForAgent,
  extractForAnswerEngines,
  measureServerText,
} from '../dist/toolbar/seo-aeo.js';

const PAGE_URL = 'https://example.com/products/torque-wrench';

const PRODUCT = {
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'Torque Wrench 200Nm',
  description: 'Calibrated to 200 Nm.',
  brand: { '@type': 'Brand', name: 'Acme Tools' },
  sku: 'SKU-1001',
  offers: { '@type': 'Offer', price: '189.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
  aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.6, reviewCount: 128 },
};

/** Builds a page and reads it exactly as the sheet does. */
function page({ head = '', body = '', schema = [] } = {}) {
  const scripts = schema
    .map((block) => `<script type="application/ld+json">${typeof block === 'string' ? block : JSON.stringify(block)}</script>`)
    .join('');
  const dom = new JSDOM(
    `<!doctype html><html lang="en"><head>${head}${scripts}</head><body>${body}</body></html>`,
    { url: PAGE_URL },
  );
  const doc = dom.window.document;
  const metadata = readPageMetadata(doc, PAGE_URL);
  const data = readStructuredData(doc);
  const extraction = extractForAnswerEngines(doc, metadata, data);
  return { doc, metadata, data, extraction };
}

const ids = (findings) => findings.map(({ id }) => id);
const find = (findings, id) => findings.find((finding) => finding.id === id);
const prose = (words) => `<p>${Array.from({ length: words }, (_, index) => `word${index}`).join(' ')}</p>`;

test('lifts the subject and its facts from structured data', () => {
  const { extraction } = page({ schema: [PRODUCT] });

  assert.deepEqual(extraction.entity, { type: 'Product', label: 'Product', name: 'Torque Wrench 200Nm' });
  const facts = new Map(extraction.facts.map(({ label, value }) => [label, value]));
  assert.equal(facts.get('Price'), 'USD 189.00');
  assert.equal(facts.get('Rating'), '4.6 out of 5 from 128 reviews');
  assert.equal(facts.get('Availability'), 'In Stock');
  assert.equal(facts.get('Brand'), 'Acme Tools');
  // Facts from schema are marked apart from facts read out of a meta tag.
  assert.equal(extraction.facts.every(({ source }) => source === 'schema'), true);
});

test('a meta description is a fact, but a weaker one', () => {
  const { extraction } = page({ head: '<meta name="description" content="A calibrated wrench.">' });
  const summary = extraction.facts.find(({ label }) => label === 'Summary');
  assert.equal(summary.source, 'meta');
  assert.equal(summary.value, 'A calibrated wrench.');
});

test('site furniture is never the subject of an answer', () => {
  const { extraction } = page({
    schema: [
      { '@context': 'https://schema.org', '@type': 'Organization', name: 'Acme Tools' },
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [] },
    ],
  });
  assert.equal(extraction.entity, undefined);
  // The organisation still counts as provenance, just not as the subject.
  assert.equal(extraction.provenance.publisher, 'Acme Tools');
});

test('collects question and answer pairs from schema and from headings', () => {
  const { extraction } = page({
    schema: [{
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [{ '@type': 'Question', name: 'What torque range?', acceptedAnswer: { '@type': 'Answer', text: '<p>20 to 200 Nm.</p>' } }],
    }],
    body: `
      <h2>How often does it need recalibrating?</h2>
      <p>Once a year, or after any drop.</p>
      <h2>Shipping</h2>
      <p>Ships in two days.</p>
    `,
  });

  assert.equal(extraction.quotable.length, 2);
  assert.deepEqual(extraction.quotable[0], { question: 'What torque range?', answer: '20 to 200 Nm.', source: 'faq' });
  // A heading is only quotable when it is actually a question.
  assert.deepEqual(extraction.quotable[1], {
    question: 'How often does it need recalibrating?',
    answer: 'Once a year, or after any drop.',
    source: 'heading',
  });
});

test('ignores navigation and editor UI when reading the page text', () => {
  const bare = page({ body: '<main><p>one two three</p></main>' });
  const dressed = page({
    body: `
      <nav><a href="/a">Home</a><a href="/b">Catalog</a></nav>
      <main><p>one two three</p></main>
      <footer>All rights reserved</footer>
      <script>const noise = "not text";</script>
      <div data-astro-ai-ui="selection">src/pages/index.astro:1</div>
    `,
  });
  assert.equal(bare.extraction.renderedWords, 3);
  assert.equal(dressed.extraction.renderedWords, 3);
});

test('measures the text present before scripts run', () => {
  const parse = (markup) => new JSDOM(markup, { url: PAGE_URL }).window.document;
  assert.equal(measureServerText('<html><body><main><p>one two three</p></main></body></html>', parse), 3);
  assert.equal(measureServerText('<html><body><div id="root"></div></body></html>', parse), 0);
});

test('reports a page whose text only exists after hydration', () => {
  const { extraction, metadata, data } = page({ body: `<main>${prose(300)}</main>` });
  const clientRendered = { ...extraction, serverWords: 4 };

  const findings = auditAnswerReadiness(clientRendered, metadata, data);
  const finding = find(findings, 'aeo-client-rendered');
  assert.equal(finding.level, 'error');
  assert.match(finding.detail, /4 words/);
  assert.match(finding.detail, /300/);

  // A server-rendered page of the same size says nothing.
  const served = auditAnswerReadiness({ ...extraction, serverWords: 300 }, metadata, data);
  assert.equal(find(served, 'aeo-client-rendered'), undefined);
});

test('nosnippet is an error, because it forbids being quoted at all', () => {
  const { extraction, metadata, data } = page({ head: '<meta name="robots" content="max-image-preview:large, nosnippet">' });
  const findings = auditAnswerReadiness(extraction, metadata, data);
  const finding = find(findings, 'aeo-nosnippet');
  assert.equal(finding.level, 'error');
  assert.match(finding.detail, /may not quote/);
});

test('an explicit AI opt-out is reported as deliberate, not broken', () => {
  const { extraction, metadata, data } = page({ head: '<meta name="robots" content="noai, noimageai">' });
  assert.equal(extraction.aiPolicy, 'noai, noimageai');
  assert.equal(find(auditAnswerReadiness(extraction, metadata, data), 'aeo-ai-policy').level, 'info');
});

test('a page with everything raises nothing about being quotable', () => {
  const { extraction, metadata, data } = page({
    head: `
      <meta name="description" content="Calibrated to 200 Nm, with a certificate valid for twelve months.">
      <link rel="canonical" href="${PAGE_URL}">
    `,
    schema: [
      { ...PRODUCT, author: { '@type': 'Person', name: 'A. Category Manager' }, datePublished: '2026-03-04', publisher: { '@type': 'Organization', name: 'Acme Tools' } },
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: [{ '@type': 'Question', name: 'What torque range?', acceptedAnswer: { '@type': 'Answer', text: '20 to 200 Nm.' } }],
      },
    ],
    body: `<main><h1>Torque Wrench</h1>${prose(200)}</main>`,
  });

  const findings = auditAnswerReadiness({ ...extraction, serverWords: extraction.renderedWords }, metadata, data);
  assert.deepEqual(findings, [], JSON.stringify(ids(findings)));
});

test('an empty page is reported on every count that matters', () => {
  const { extraction, metadata, data } = page({ body: '<main><p>Hello.</p></main>' });
  const findings = auditAnswerReadiness(extraction, metadata, data);
  const reported = ids(findings);

  assert.equal(reported.includes('aeo-no-entity'), true);
  assert.equal(reported.includes('aeo-thin-facts'), true);
  assert.equal(reported.includes('aeo-thin-content'), true);
  assert.equal(reported.includes('aeo-no-headings'), true);
  assert.equal(reported.includes('aeo-weak-provenance'), true);
  assert.equal(reported.includes('aeo-no-canonical'), true);
  // Errors first, then warnings, then notes.
  assert.deepEqual(findings.map(({ level }) => level), [...findings.map(({ level }) => level)].sort(
    (first, second) => ['error', 'warning', 'info'].indexOf(first) - ['error', 'warning', 'info'].indexOf(second),
  ));
});

test('the answer is assembled from facts the page actually states', () => {
  const { extraction, metadata } = page({ schema: [PRODUCT] });
  const answer = composeAnswer(extraction, metadata);

  assert.equal(answer.grounding, 'strong');
  assert.equal(answer.citation, 'example.com');
  assert.match(answer.sentence, /^Torque Wrench 200Nm/);
  assert.match(answer.sentence, /costs USD 189\.00/);
  assert.match(answer.sentence, /rated 4\.6 out of 5/);
  assert.match(answer.sentence, /in stock/);
});

test('a page with nothing to say produces a sentence that says so', () => {
  const bare = page({ body: '<p>Hi.</p>' });
  const answer = composeAnswer(bare.extraction, bare.metadata);
  assert.equal(answer.grounding, 'thin');
  assert.match(answer.sentence, /no named subject/);

  // A title and a description alone are partial grounding, not strong.
  const described = page({
    head: '<title>Torque Wrench</title><meta name="description" content="Calibrated to 200 Nm.">',
  });
  const partial = composeAnswer(described.extraction, described.metadata);
  assert.equal(partial.grounding, 'partial');
  assert.match(partial.sentence, /Calibrated to 200 Nm/);
});

test('the agent brief states what was extracted and what was missing', () => {
  const { extraction } = page({ schema: [PRODUCT] });
  const brief = describeExtractionForAgent({ ...extraction, serverWords: 12 });

  assert.match(brief, /Subject: Product · Torque Wrench 200Nm/);
  assert.match(brief, /Price=USD 189\.00/);
  assert.match(brief, /12 in the HTML as served/);
  assert.match(brief, /author=\(none\)/);
});

test('something that was written is answered with its byline', () => {
  const { extraction, metadata } = page({
    schema: [{
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: 'Specifying a torque wrench',
      author: { '@type': 'Person', name: 'A. Category Manager' },
      datePublished: '2026-03-04',
      publisher: { '@type': 'Organization', name: 'Acme Tools' },
    }],
  });
  const answer = composeAnswer(extraction, metadata);

  assert.equal(answer.grounding, 'strong');
  assert.match(answer.sentence, /written by A\. Category Manager/);
  assert.match(answer.sentence, /published on 2026-03-04/);

  // A product is not attributed to an author, so it gets no byline clause.
  const product = page({ schema: [{ ...PRODUCT, author: { '@type': 'Person', name: 'Nobody' } }] });
  assert.equal(/written by/.test(composeAnswer(product.extraction, product.metadata).sentence), false);
});

test('lifts the facts a job posting and a shopfront state', () => {
  const job = page({
    schema: [{
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Field Application Engineer',
      description: 'Support customers on site.',
      datePosted: '2026-08-30',
      hiringOrganization: { '@type': 'Organization', name: 'Acme Tools' },
      jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Sheffield' } },
      baseSalary: { '@type': 'MonetaryAmount', currency: 'USD' },
    }],
  });
  assert.equal(job.extraction.entity.name, 'Field Application Engineer');

  const store = page({
    schema: [{
      '@context': 'https://schema.org',
      '@type': 'Store',
      name: 'Acme Tools Trade Counter',
      telephone: '+1 555 0100',
      address: { '@type': 'PostalAddress', streetAddress: '1 Forge Lane', addressLocality: 'Sheffield' },
    }],
  });
  const facts = new Map(store.extraction.facts.map(({ label, value }) => [label, value]));
  assert.equal(facts.get('Location'), '1 Forge Lane, Sheffield');
  assert.equal(facts.get('Telephone'), '+1 555 0100');
});
