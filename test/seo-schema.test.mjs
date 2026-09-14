import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { readPageMetadata } from '../dist/toolbar/seo-metadata.js';
import {
  auditStructuredData,
  canonicalType,
  describeEntity,
  describeStructuredData,
  formatDuration,
  readStructuredData,
  resolveRichResult,
} from '../dist/toolbar/seo-schema.js';

const PAGE_URL = 'https://example.com/products/torque-wrench';

/** Builds a document with the given JSON-LD blocks, as authored. */
function read(...blocks) {
  const scripts = blocks
    .map((block) => `<script type="application/ld+json">${typeof block === 'string' ? block : JSON.stringify(block)}</script>`)
    .join('');
  const dom = new JSDOM(`<!doctype html><html lang="en"><head>${scripts}</head><body></body></html>`, { url: PAGE_URL });
  return readStructuredData(dom.window.document);
}

function metadataFor(head = '') {
  const dom = new JSDOM(`<!doctype html><html lang="en"><head>${head}</head><body></body></html>`, { url: PAGE_URL });
  return readPageMetadata(dom.window.document, PAGE_URL);
}

const ids = (findings) => findings.map(({ id }) => id);
const find = (findings, prefix) => findings.find(({ id }) => id.startsWith(prefix));

const PRODUCT = {
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'Torque Wrench 200Nm',
  image: 'https://example.com/og/card.png',
  description: 'Calibrated to 200 Nm.',
  brand: { '@type': 'Brand', name: 'Acme' },
  sku: 'SKU-1001',
  offers: {
    '@type': 'Offer',
    price: '189.00',
    priceCurrency: 'USD',
    availability: 'https://schema.org/InStock',
  },
  aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.6, reviewCount: 128 },
};

test('reads every block, including arrays and @graph', () => {
  const data = read(
    PRODUCT,
    [{ '@context': 'https://schema.org', '@type': 'Organization', name: 'Acme' }],
    {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', name: 'Acme', url: 'https://example.com' },
        { '@type': 'BreadcrumbList', itemListElement: [] },
      ],
    },
  );

  assert.equal(data.blocks.length, 3);
  assert.deepEqual(data.nodes.map(({ type }) => type), ['Product', 'Organization', 'WebSite', 'BreadcrumbList']);
  // A wrapper that only carries @graph is not itself a node.
  assert.equal(data.nodes.some(({ type }) => type === ''), false);
  assert.match(data.nodes[2].path, /@graph\[0\]/);
});

test('an unparseable block is reported rather than silently dropped', () => {
  const data = read('{ "@type": "Product", }');
  assert.equal(data.blocks.length, 1);
  assert.notEqual(data.blocks[0].error, undefined);
  assert.deepEqual(data.nodes, []);

  const findings = auditStructuredData(data, metadataFor());
  const invalid = find(findings, 'schema-invalid-json');
  assert.equal(invalid.level, 'error');
  assert.match(invalid.detail, /ignored in full/);
});

test('an empty script is a finding, not a parse crash', () => {
  const findings = auditStructuredData(read('   '), metadataFor());
  assert.equal(find(findings, 'schema-invalid-json').level, 'error');
});

test('a complete Product raises nothing', () => {
  const head = `
    <meta property="og:title" content="Torque Wrench 200Nm">
    <meta property="og:image" content="https://example.com/og/card.png">
    <link rel="canonical" href="${PAGE_URL}">
  `;
  const findings = auditStructuredData(read({ ...PRODUCT, url: PAGE_URL }), metadataFor(head));
  assert.deepEqual(findings, [], JSON.stringify(ids(findings)));
});

test('names what a missing property costs the reader', () => {
  const { offers, aggregateRating, ...bare } = PRODUCT;
  const findings = auditStructuredData(read(bare), metadataFor());

  const bareProduct = find(findings, 'schema-product-bare');
  assert.equal(bareProduct.level, 'error');
  assert.match(bareProduct.detail, /ordinary link/);

  // A missing required property explains the loss rather than citing a rule.
  const required = auditStructuredData(read({ '@context': 'https://schema.org', '@type': 'Article' }), metadataFor());
  const headline = find(required, 'schema-required-Article-headline');
  assert.equal(headline.level, 'error');
  assert.match(headline.detail, /shown beside a news or blog result/);
  assert.equal(headline.tag, 'Article.headline');
});

test('an offer without a price shows no price', () => {
  const findings = auditStructuredData(
    read({ ...PRODUCT, offers: { '@type': 'Offer', priceCurrency: 'USD' } }),
    metadataFor(),
  );
  assert.equal(find(findings, 'schema-offer-price').level, 'error');
  assert.equal(find(findings, 'schema-offer-availability').level, 'warning');
});

test('a rating without a count is dropped, so it is an error', () => {
  const findings = auditStructuredData(
    read({ ...PRODUCT, aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.6 } }),
    metadataFor(),
  );
  assert.equal(find(findings, 'schema-rating-reviewCount').level, 'error');

  // ratingCount is the accepted alternative to reviewCount.
  const either = auditStructuredData(
    read({ ...PRODUCT, aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.6, ratingCount: 9 } }),
    metadataFor(),
  );
  assert.equal(find(either, 'schema-rating-'), undefined);
});

test('checks every breadcrumb, and lets the last one omit its link', () => {
  const findings = auditStructuredData(read({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Tools' },
      { '@type': 'ListItem', position: 2, item: 'https://example.com/tools/wrenches' },
      { '@type': 'ListItem', position: 3, name: 'Torque Wrench' },
    ],
  }), metadataFor());

  assert.equal(find(findings, 'schema-breadcrumb-item-0').level, 'warning', 'crumb 1 has no link');
  assert.equal(find(findings, 'schema-breadcrumb-name-1').level, 'error', 'crumb 2 has no name');
  // The last crumb is the current page, so a missing link there is fine.
  assert.equal(ids(findings).some((id) => id.startsWith('schema-breadcrumb-item-2')), false);
});

test('a question without an answer costs the whole set', () => {
  const findings = auditStructuredData(read({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: 'What torque range?', acceptedAnswer: { '@type': 'Answer', text: '20 to 200 Nm.' } },
      { '@type': 'Question', name: 'Is it calibrated?' },
    ],
  }), metadataFor());

  assert.equal(find(findings, 'schema-faq-answer-1').level, 'error');
  assert.equal(ids(findings).some((id) => id.startsWith('schema-faq-answer-0')), false);
});

test('catches a schema that describes a different page than the one it sits on', () => {
  const head = `
    <meta property="og:title" content="Torque Wrench 200Nm">
    <meta property="og:image" content="https://example.com/og/card.png">
    <link rel="canonical" href="${PAGE_URL}">
  `;
  const findings = auditStructuredData(read({
    ...PRODUCT,
    name: 'A completely different product',
    image: 'https://cdn.example.com/other.png',
    url: 'https://example.com/elsewhere',
  }), metadataFor(head));

  assert.equal(find(findings, 'schema-title-mismatch').level, 'warning');
  assert.equal(find(findings, 'schema-image-mismatch').level, 'warning');
  assert.equal(find(findings, 'schema-url-mismatch').level, 'warning');
  // The image disagreement shows up on the social cards too, not only Google.
  assert.deepEqual(find(findings, 'schema-image-mismatch').networks, ['google', 'facebook', 'x']);
});

test('only a node describing this page can disagree with it', () => {
  const head = '<meta property="og:title" content="Torque Wrench 200Nm">';
  // An Organization names the site and a BreadcrumbList names the path to it.
  // Neither is the page's title, so neither is a contradiction.
  const findings = auditStructuredData(read(
    { '@context': 'https://schema.org', '@type': 'Organization', name: 'Acme Tools', url: 'https://example.com', logo: 'l', sameAs: ['s'] },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Tools' }] },
  ), metadataFor(head));
  assert.equal(find(findings, 'schema-title-mismatch'), undefined);

  // A WebPage stands in when nothing more specific describes the page.
  const page = auditStructuredData(
    read({ '@context': 'https://schema.org', '@type': 'WebPage', name: 'Something else entirely', description: 'd' }),
    metadataFor(head),
  );
  assert.equal(find(page, 'schema-title-mismatch').level, 'warning');
});

test('a site suffix on the page title is not a contradiction', () => {
  const head = '<meta property="og:title" content="Torque Wrench 200Nm · Acme">';
  const findings = auditStructuredData(read(PRODUCT), metadataFor(head));
  assert.equal(find(findings, 'schema-title-mismatch'), undefined);
});

test('a trailing slash is not a url disagreement', () => {
  const head = `<link rel="canonical" href="${PAGE_URL}/">`;
  const findings = auditStructuredData(read({ ...PRODUCT, url: PAGE_URL }), metadataFor(head));
  assert.equal(find(findings, 'schema-url-mismatch'), undefined);
});

test('a page with no JSON-LD says what it forfeits', () => {
  const findings = auditStructuredData(read(), metadataFor());
  assert.deepEqual(ids(findings), ['schema-missing']);
  assert.equal(findings[0].level, 'info');
  assert.match(findings[0].detail, /breadcrumbs, stars, price/);
});

test('an unknown type is left alone rather than guessed at', () => {
  const findings = auditStructuredData(
    read({ '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Thing' }),
    metadataFor(),
  );
  const unknown = find(findings, 'schema-unknown-type');
  assert.equal(unknown.level, 'info');
  assert.match(unknown.detail, /it simply is not one of the types/);
});

test('requires a schema.org context', () => {
  assert.equal(find(auditStructuredData(read({ '@type': 'Product', name: 'x' }), metadataFor()), 'schema-no-context').level, 'error');
  assert.equal(
    find(auditStructuredData(read({ '@context': 'https://example.org', '@type': 'Product', name: 'x' }), metadataFor()), 'schema-odd-context').level,
    'warning',
  );
  // http, a trailing slash, and an array context are all still schema.org.
  assert.equal(find(auditStructuredData(read({ '@context': 'http://schema.org/', '@type': 'Person', name: 'x' }), metadataFor()), 'schema-odd-context'), undefined);
});

test('resolves what the schema will actually add to the result', () => {
  const rich = resolveRichResult(read(
    PRODUCT,
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Tools', item: 'https://example.com/tools' },
        { '@type': 'ListItem', position: 2, name: 'Torque Wrench' },
      ],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [{
        '@type': 'Question',
        name: 'What torque range?',
        acceptedAnswer: { '@type': 'Answer', text: '<p>20 to <b>200</b> Nm.</p>' },
      }],
    },
    { '@context': 'https://schema.org', '@type': 'Organization', name: 'Acme Tools' },
  ));

  assert.deepEqual(rich.breadcrumbs, ['Tools', 'Torque Wrench']);
  assert.deepEqual(rich.rating, { value: 4.6, best: 5, count: 128 });
  assert.deepEqual(rich.offer, { price: '189.00', currency: 'USD', availability: 'InStock' });
  assert.equal(rich.siteName, 'Acme Tools');
  // Answers are commonly authored as HTML, which a result renders as text.
  assert.deepEqual(rich.faq, [{ question: 'What torque range?', answer: '20 to 200 Nm.' }]);
});

test('an article contributes its byline', () => {
  const rich = resolveRichResult(read({
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: 'Specifying a torque wrench',
    datePublished: '2026-03-04',
    author: { '@type': 'Person', name: 'A. Category Manager' },
  }));
  assert.equal(rich.datePublished, '2026-03-04');
  assert.equal(rich.author, 'A. Category Manager');
});

test('article subtypes inherit the article rules', () => {
  assert.equal(canonicalType('NewsArticle'), 'Article');
  assert.equal(canonicalType('Restaurant'), 'LocalBusiness');
  assert.equal(canonicalType('Product'), 'Product');

  const findings = auditStructuredData(
    read({ '@context': 'https://schema.org', '@type': 'NewsArticle', headline: 'x', image: 'i', datePublished: 'd', author: { name: 'a' }, publisher: { name: 'p' } }),
    metadataFor(),
  );
  assert.equal(ids(findings).some((id) => id.includes('required')), false);
});

test('flags an article headline past the length Google reads', () => {
  const findings = auditStructuredData(read({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: 'A'.repeat(140),
    image: 'i', datePublished: 'd', author: { name: 'a' }, publisher: { name: 'p' },
  }), metadataFor());
  assert.equal(find(findings, 'schema-headline-long').level, 'warning');
});

test('the agent brief names each block and its types', () => {
  const brief = describeStructuredData(read(PRODUCT, '{ bad json'));
  assert.match(brief, /2 blocks/);
  assert.match(brief, /block 1: Product/);
  assert.match(brief, /block 2: unparseable/);
  assert.equal(describeStructuredData(read()), 'Structured data: none on this page.');
});

test('reduces an entity to the values a card is drawn from', () => {
  const [product] = read(PRODUCT).nodes.map((node) => describeEntity(node));

  assert.equal(product.type, 'Product');
  assert.equal(product.label, 'Product');
  assert.equal(product.name, 'Torque Wrench 200Nm');
  assert.equal(product.brand, 'Acme', 'a nested Brand is read down to its name');
  assert.deepEqual(product.rating, { value: 4.6, best: 5, count: 128 });
  assert.deepEqual(product.offer, { price: '189.00', currency: 'USD', availability: 'InStock' });
});

test('an article reads its headline, byline and date', () => {
  const [article] = read({
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: 'Specifying a torque wrench',
    author: { '@type': 'Person', name: 'A. Category Manager' },
    publisher: { '@type': 'Organization', name: 'Acme Tools' },
    datePublished: '2026-03-04',
  }).nodes.map((node) => describeEntity(node));

  // The canonical type decides the card; the authored type is still shown.
  assert.equal(article.type, 'Article');
  assert.equal(article.label, 'NewsArticle');
  assert.equal(article.name, 'Specifying a torque wrench');
  assert.equal(article.author, 'A. Category Manager');
  assert.equal(article.publisher, 'Acme Tools');
});

test('a breadcrumb entity keeps which crumbs link somewhere', () => {
  const [trail] = read({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Tools', item: 'https://example.com/tools' },
      { '@type': 'ListItem', position: 2, name: 'Torque Wrench' },
    ],
  }).nodes.map((node) => describeEntity(node));

  assert.deepEqual(trail.breadcrumbs, [
    { name: 'Tools', url: 'https://example.com/tools' },
    { name: 'Torque Wrench' },
  ]);
});

test('an address is flattened and a duration made readable', () => {
  const [shop] = read({
    '@context': 'https://schema.org',
    '@type': 'Store',
    name: 'Acme Tools',
    address: { '@type': 'PostalAddress', streetAddress: '1 Forge Lane', addressLocality: 'Sheffield', postalCode: 'S1 2AB' },
    telephone: '+44 114 000 0000',
  }).nodes.map((node) => describeEntity(node));

  assert.equal(shop.type, 'LocalBusiness');
  assert.equal(shop.address, '1 Forge Lane, Sheffield, S1 2AB');
  assert.equal(shop.telephone, '+44 114 000 0000');

  assert.equal(formatDuration('PT1H30M'), '1 hr 30 min');
  assert.equal(formatDuration('PT45M'), '45 min');
  assert.equal(formatDuration('P2D'), '2 days');
  // Anything that is not an ISO duration is passed through rather than mangled.
  assert.equal(formatDuration('about an hour'), 'about an hour');
  assert.equal(formatDuration(undefined), undefined);
});

test('a type with no card of its own keeps its remaining fields', () => {
  const [app] = read({
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Astro AI',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS, Linux',
  }).nodes.map((node) => describeEntity(node));

  assert.equal(app.name, 'Astro AI');
  // Fields already drawn elsewhere are not repeated in the generic rows.
  assert.deepEqual(app.fields, [
    { label: 'applicationCategory', value: 'DeveloperApplication' },
    { label: 'operatingSystem', value: 'macOS, Linux' },
  ]);
});
