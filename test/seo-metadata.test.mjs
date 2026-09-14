import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
  auditPageMetadata,
  countBySeverity,
  describeFindingsForAgent,
  NETWORK_IDS,
  readPageMetadata,
  resolveNetworkCard,
  resolveNetworkCards,
  truncate,
} from '../dist/toolbar/seo-metadata.js';
import {
  SEO_NETWORK_IDS,
  isSeoNetworkId,
  normalizeSeoPreview,
} from '../dist/shared/seo-preview.js';

const PAGE_URL = 'https://example.com/guides/arc-flash';

function read(head, { url = PAGE_URL, lang = 'en' } = {}) {
  const dom = new JSDOM(`<!doctype html><html${lang === null ? '' : ` lang="${lang}"`}><head>${head}</head><body></body></html>`, { url });
  return readPageMetadata(dom.window.document, url);
}

/** A page with every tag present, so a test can remove exactly one. */
const COMPLETE_HEAD = `
  <title>Arc flash program basics</title>
  <meta name="description" content="How to build an arc flash program that survives an audit, from the study through to the labels on the panel.">
  <meta property="og:title" content="Arc flash program basics">
  <meta property="og:description" content="Build a program that survives an audit.">
  <meta property="og:image" content="https://cdn.example.com/card.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="A labelled panel">
  <meta property="og:url" content="${PAGE_URL}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="Example Safety">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="canonical" href="${PAGE_URL}">
  <link rel="icon" href="/favicon.svg">
`;

test('reads head metadata, keeping the first value for a repeated tag', () => {
  const metadata = read(`
    <title>First title</title>
    <meta property="og:title" content="Open Graph title">
    <meta property="og:title" content="Duplicate that crawlers ignore">
    <meta name="description" content="A description.">
    <meta name="twitter:card" content="summary">
    <link rel="canonical" href="/guides/arc-flash">
    <link rel="icon shortcut" href="/favicon.svg">
    <meta name="theme-color" content="#0f172a">
  `);

  assert.equal(metadata.title, 'First title');
  assert.equal(metadata.og.title, 'Open Graph title');
  assert.equal(metadata.description, 'A description.');
  assert.equal(metadata.twitter.card, 'summary');
  assert.equal(metadata.canonical, PAGE_URL);
  assert.equal(metadata.favicon, 'https://example.com/favicon.svg');
  assert.equal(metadata.themeColor, '#0f172a');
  assert.equal(metadata.lang, 'en');
  assert.equal(metadata.domain, 'example.com');
  assert.equal(metadata.path, '/guides/arc-flash');
  // The duplicate is still reported to the tag inspector, just not used.
  assert.equal(metadata.tags.filter(({ key }) => key === 'og:title').length, 2);
});

test('keeps og:image exactly as authored so a relative URL stays visible', () => {
  const metadata = read('<meta property="og:image" content="/card.png">');
  assert.equal(metadata.og.image, '/card.png');
  // The card still resolves it, because the browser would.
  assert.equal(resolveNetworkCard(metadata, 'facebook').image, 'https://example.com/card.png');
});

test('each network reads its own tag chain', () => {
  const metadata = read(`
    <title>Document title</title>
    <meta name="description" content="Document description">
    <meta property="og:title" content="Open Graph title">
    <meta property="og:description" content="Open Graph description">
    <meta name="twitter:title" content="X title">
    <meta name="twitter:description" content="X description">
  `);

  assert.equal(resolveNetworkCard(metadata, 'x').title, 'X title');
  assert.equal(resolveNetworkCard(metadata, 'x').description, 'X description');
  assert.equal(resolveNetworkCard(metadata, 'google').title, 'Document title');
  assert.equal(resolveNetworkCard(metadata, 'google').description, 'Document description');
  assert.equal(resolveNetworkCard(metadata, 'facebook').title, 'Open Graph title');
  assert.equal(resolveNetworkCard(metadata, 'whatsapp').description, 'Open Graph description');
});

test('falls back down the chain and records what it had to invent', () => {
  const metadata = read('<title>Only a title</title>');

  for (const card of resolveNetworkCards(metadata)) {
    assert.equal(card.title, 'Only a title', `${card.network} title`);
    assert.deepEqual(
      card.missing.includes('image'),
      true,
      `${card.network} should report the missing image`,
    );
  }
  // LinkedIn never renders a description, so a missing one is not a gap there.
  assert.equal(resolveNetworkCards(metadata).find(({ network }) => network === 'linkedin').missing.includes('description'), false);
  assert.equal(resolveNetworkCards(metadata).find(({ network }) => network === 'facebook').missing.includes('description'), true);
});

test('truncates at a word boundary and reports that it did', () => {
  assert.deepEqual(truncate('Short enough', 40), { text: 'Short enough', truncated: false });
  assert.deepEqual(truncate('  collapses   whitespace  ', 40), { text: 'collapses whitespace', truncated: false });

  const long = truncate('Arc flash program basics for industrial electrical safety teams', 40);
  assert.equal(long.truncated, true);
  assert.equal(long.text.endsWith('…'), true);
  assert.equal(long.text.length <= 41, true);
  // Cut at a space rather than mid-word.
  assert.equal(/\s…$/.test(long.text), false);
  assert.equal(long.text, 'Arc flash program basics for industrial…');
});

test('each network truncates at its own limit', () => {
  const title = 'A'.repeat(200);
  const metadata = read(`<title>${title}</title><meta property="og:title" content="${title}">`);

  const byNetwork = new Map(resolveNetworkCards(metadata).map((card) => [card.network, card]));
  assert.equal(byNetwork.get('google').title.length, 61);
  assert.equal(byNetwork.get('x').title.length, 71);
  assert.equal(byNetwork.get('linkedin').title.length, 120);
  assert.equal(byNetwork.get('discord').title.length, 200);
  assert.equal(byNetwork.get('discord').titleTruncated, false);
  assert.equal(byNetwork.get('google').titleTruncated, true);
});

test('twitter:card decides whether X shows the wide image', () => {
  const large = read('<meta property="og:image" content="https://cdn.example.com/c.png"><meta name="twitter:card" content="summary_large_image">');
  assert.equal(resolveNetworkCard(large, 'x').variant, 'large');
  assert.equal(resolveNetworkCard(large, 'discord').variant, 'large');

  const summary = read('<meta property="og:image" content="https://cdn.example.com/c.png"><meta name="twitter:card" content="summary">');
  assert.equal(resolveNetworkCard(summary, 'x').variant, 'compact');

  const untagged = read('<meta property="og:image" content="https://cdn.example.com/c.png">');
  assert.equal(resolveNetworkCard(untagged, 'x').variant, 'compact');
  // Facebook ignores twitter:card entirely and shows the banner regardless.
  assert.equal(resolveNetworkCard(untagged, 'facebook').variant, 'large');

  const imageless = read('<title>No image</title>');
  for (const network of NETWORK_IDS) {
    assert.equal(resolveNetworkCard(imageless, network).variant, 'compact', network);
  }
});

test('a fully tagged page raises nothing above a note', () => {
  const metadata = read(COMPLETE_HEAD);
  const findings = auditPageMetadata(metadata, { status: 'loaded', width: 1200, height: 630 });
  const counts = countBySeverity(findings);

  assert.equal(counts.error, 0, JSON.stringify(findings.map(({ id }) => id)));
  assert.equal(counts.warning, 0, JSON.stringify(findings.map(({ id }) => id)));
});

test('reports a missing image, title, and description as errors', () => {
  const findings = auditPageMetadata(read(''));
  const ids = findings.map(({ id }) => id);

  assert.equal(ids.includes('title-missing'), true);
  assert.equal(ids.includes('description-missing'), true);
  assert.equal(ids.includes('og-image-missing'), true);
  // Errors sort ahead of warnings and notes.
  assert.equal(findings[0].level, 'error');
  assert.deepEqual(
    [...findings].sort((a, b) => rank(a.level) - rank(b.level)).map(({ id }) => id),
    ids,
  );
  // Every finding names the networks a reader would see it on.
  for (const finding of findings) assert.equal(finding.networks.length > 0, true, finding.id);
});

test('flags a relative og:image as an error rather than resolving it away', () => {
  const findings = auditPageMetadata(read(`${COMPLETE_HEAD}`.replace('https://cdn.example.com/card.png', '/card.png')));
  const relative = findings.find(({ id }) => id === 'og-image-relative');

  assert.notEqual(relative, undefined);
  assert.equal(relative.level, 'error');
  assert.equal(relative.detail.includes('/card.png'), true);
});

test('measures the real image rather than trusting the declared size', () => {
  const metadata = read(COMPLETE_HEAD);

  const tiny = auditPageMetadata(metadata, { status: 'loaded', width: 64, height: 64 });
  assert.equal(tiny.find(({ id }) => id === 'og-image-tiny')?.level, 'error');

  const small = auditPageMetadata(metadata, { status: 'loaded', width: 800, height: 418 });
  assert.equal(small.find(({ id }) => id === 'og-image-small')?.level, 'warning');

  const broken = auditPageMetadata(metadata, { status: 'failed' });
  assert.equal(broken.find(({ id }) => id === 'og-image-unreachable')?.level, 'error');

  // A page that declares 1200x630 but serves a 64px file is still wrong.
  assert.equal(metadata.og.imageWidth, 1200);
  assert.equal(tiny.some(({ id }) => id === 'og-image-tiny'), true);
});

test('catches the disagreements a single tag cannot show', () => {
  const mismatch = auditPageMetadata(read(`
    <title>Page</title>
    <meta property="og:url" content="https://example.com/a">
    <link rel="canonical" href="https://example.com/b">
  `));
  assert.equal(mismatch.find(({ id }) => id === 'og-url-mismatch')?.level, 'warning');

  // A trailing slash is not a disagreement.
  const equivalent = auditPageMetadata(read(`
    <meta property="og:url" content="https://example.com/a/">
    <link rel="canonical" href="https://example.com/a">
  `));
  assert.equal(equivalent.some(({ id }) => id === 'og-url-mismatch'), false);
});

test('surfaces noindex and a missing lang without calling them errors', () => {
  const findings = auditPageMetadata(read('<meta name="robots" content="noindex, nofollow">', { lang: null }));

  assert.equal(findings.find(({ id }) => id === 'robots-noindex')?.level, 'info');
  assert.equal(findings.find(({ id }) => id === 'html-lang-missing')?.level, 'warning');
});

test('rejects an unknown twitter:card value', () => {
  const findings = auditPageMetadata(read('<meta name="twitter:card" content="large">'));
  assert.equal(findings.find(({ id }) => id === 'twitter-card-invalid')?.level, 'error');
});

test('the agent brief carries the route and the current values', () => {
  const metadata = read(COMPLETE_HEAD);
  const findings = auditPageMetadata(metadata, { status: 'loaded', width: 400, height: 210 });
  const brief = describeFindingsForAgent(metadata, findings);

  assert.equal(brief.includes('Route: /guides/arc-flash'), true);
  assert.equal(brief.includes('og:image: https://cdn.example.com/card.png'), true);
  assert.equal(brief.includes('twitter:card: summary_large_image'), true);
  assert.equal(brief.includes('og:image is 400×210'), true);
  assert.equal(brief.includes('Affects:'), true);

  // A page with nothing says so, rather than omitting the line.
  assert.equal(describeFindingsForAgent(read(''), []).includes('title: (missing)'), true);
});

test('validates the configured share preview settings', () => {
  assert.equal(normalizeSeoPreview(undefined), undefined);
  assert.equal(normalizeSeoPreview(true), undefined, 'true means "on with defaults"');
  assert.equal(normalizeSeoPreview(false), false);
  assert.equal(normalizeSeoPreview({}), undefined, 'an empty object configures nothing');

  assert.deepEqual(
    normalizeSeoPreview({ networks: ['x', 'google', 'x'] }),
    { networks: ['x', 'google'] },
  );

  // A typo in astro.config.mjs is a mistake worth naming, not a card silently
  // missing from the sheet.
  assert.throws(() => normalizeSeoPreview({ networks: ['twitter'] }), /unknown network "twitter"/);
  assert.throws(() => normalizeSeoPreview({ networks: ['twitter'] }), new RegExp(SEO_NETWORK_IDS.join(', ')));
  assert.throws(() => normalizeSeoPreview({ networks: [] }), /non-empty array/);

  assert.equal(isSeoNetworkId('linkedin'), true);
  assert.equal(isSeoNetworkId('mastodon'), false);
});

test('renders only the configured networks', () => {
  const metadata = read(COMPLETE_HEAD);

  assert.equal(resolveNetworkCards(metadata).length, 8);
  assert.deepEqual(
    resolveNetworkCards(metadata, ['google', 'x']).map(({ network }) => network),
    ['google', 'x'],
    'the configured order is the rendered order',
  );
});

test('every value on a card comes from the page, never from configuration', () => {
  const tagged = read(COMPLETE_HEAD);
  const [card] = resolveNetworkCards(tagged, ['facebook']);
  assert.equal(card.image, 'https://cdn.example.com/card.png');
  assert.equal(card.siteName, 'Example Safety');

  // The same card on a page that declares nothing has nothing to show, and says so.
  const bare = read('<title>No image anywhere</title>');
  const [empty] = resolveNetworkCards(bare, ['facebook']);
  assert.equal(empty.image, undefined);
  assert.equal(empty.siteName, undefined);
  assert.equal(empty.missing.includes('image'), true);

  const finding = auditPageMetadata(bare).find(({ id }) => id === 'og-image-missing');
  assert.equal(finding.level, 'error');
  assert.equal(finding.detail.includes('text-only link'), true);
});

function rank(level) {
  return level === 'error' ? 0 : level === 'warning' ? 1 : 2;
}
