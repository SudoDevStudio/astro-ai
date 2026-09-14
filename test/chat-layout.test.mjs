import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
  ChatWindowManager,
  DOCK_DEFAULT_WIDTH,
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  DOCK_RAIL_WIDTH,
  clampDockWidth,
} from '../dist/toolbar/chat-windows.js';
import { SeoPreviewSheet } from '../dist/toolbar/seo-sheet.js';

test('clamps the dock to a width that leaves the page a column', () => {
  assert.equal(clampDockWidth(Number.NaN), DOCK_DEFAULT_WIDTH);
  assert.equal(clampDockWidth(10), DOCK_MIN_WIDTH);
  assert.equal(clampDockWidth(5000), Math.min(DOCK_MAX_WIDTH, 1024 - 200));
  assert.equal(clampDockWidth(420.4), 420);
});

test('docking moves every conversation into one column with tabs', () => {
  const cleanup = installDom();
  try {
    const manager = new ChatWindowManager(noopCallbacks());
    const first = manager.focused();
    const second = manager.create();
    manager.openAll(false, false, true);

    assert.equal(manager.layout, 'floating');
    assert.equal(tabs(manager).length, 2, 'tabs exist before docking, ready for the switch');
    assert.equal(first.element.hidden, false);
    assert.equal(second.element.hidden, false);

    manager.setLayout('fixed');

    assert.equal(manager.element.dataset.layout, 'fixed');
    assert.equal(first.element.dataset.layout, 'fixed');
    // Only the focused conversation is on screen; the rest live behind a tab.
    assert.equal(second.element.hidden, false);
    assert.equal(first.element.hidden, true);
    assert.deepEqual(tabs(manager).map((tab) => tab.getAttribute('aria-selected')), ['false', 'true']);
    assert.deepEqual(labels(manager), ['Chat 1', 'Chat 2']);

    // A docked window keeps no position of its own.
    assert.equal(first.element.style.left, '');
    assert.equal(first.element.style.width, '');
  } finally { cleanup(); }
});

test('a tab switches the visible conversation without touching its state', () => {
  const cleanup = installDom();
  try {
    const manager = new ChatWindowManager(noopCallbacks());
    const first = manager.focused();
    const second = manager.create();
    manager.openAll(false, false, true);
    manager.setLayout('fixed');

    tabs(manager)[0].dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true }));

    assert.equal(manager.focused().sessionId, first.sessionId);
    assert.equal(first.element.hidden, false);
    assert.equal(second.element.hidden, true);
    assert.deepEqual(tabs(manager).map((tab) => tab.getAttribute('aria-selected')), ['true', 'false']);
  } finally { cleanup(); }
});

test('a tab close button closes that conversation only', () => {
  const cleanup = installDom();
  try {
    const closed = [];
    const manager = new ChatWindowManager({
      ...noopCallbacks(),
      onSessionClose(sessionId) { closed.push(sessionId); },
    });
    const first = manager.focused();
    const second = manager.create();
    manager.openAll(false, false, true);
    manager.setLayout('fixed');

    tabs(manager)[1].querySelector('.dock-tab-close')
      .dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true }));

    assert.deepEqual(closed, [second.sessionId]);
    assert.equal(manager.size, 1);
    assert.deepEqual(labels(manager), ['Chat 1']);
    assert.equal(first.element.hidden, false);
  } finally { cleanup(); }
});

test('renaming a conversation renames its tab', () => {
  const cleanup = installDom();
  try {
    const manager = new ChatWindowManager(noopCallbacks());
    manager.create();
    manager.setLayout('fixed');

    manager.focused().rename('Release notes');

    assert.deepEqual(labels(manager), ['Chat 1', 'Release notes']);
  } finally { cleanup(); }
});

test('the docked page keeps a column of its own', () => {
  const cleanup = installDom();
  try {
    const manager = new ChatWindowManager(noopCallbacks());
    manager.openAll(false, false, true);

    assert.equal(pageInset(), undefined, 'a floating window overlays the page');

    manager.setLayout('fixed');
    assert.equal(pageInset(), `${DOCK_DEFAULT_WIDTH}px`);
    assert.equal(
      globalThis.document.documentElement.style.getPropertyValue('--astro-ai-dock-width'),
      `${DOCK_DEFAULT_WIDTH}px`,
      'the width is published so a host app can offset its own fixed elements',
    );

    manager.setDockWidth(560);
    assert.equal(pageInset(), '560px');

    manager.toggleDock(true);
    assert.equal(pageInset(), `${DOCK_RAIL_WIDTH}px`, 'a collapsed dock still holds its rail');

    manager.setLayout('floating');
    assert.equal(pageInset(), undefined);
  } finally { cleanup(); }
});

test('closing the editor gives the whole page back', () => {
  const cleanup = installDom();
  try {
    const manager = new ChatWindowManager(noopCallbacks());
    manager.setLayout('fixed');
    manager.openAll(false, false, true);
    assert.equal(pageInset(), `${DOCK_DEFAULT_WIDTH}px`);

    manager.hideAll(false);
    assert.equal(pageInset(), undefined);

    manager.openAll(false, false, true);
    assert.equal(pageInset(), `${DOCK_DEFAULT_WIDTH}px`);

    manager.destroy();
    assert.equal(pageInset(), undefined);
    assert.equal(globalThis.document.querySelector('style[data-astro-ai="dock-inset"]'), null);
  } finally { cleanup(); }
});

test('collapsing the dock pauses selection the way collapsing every window does', () => {
  const cleanup = installDom();
  try {
    const paused = [];
    const manager = new ChatWindowManager({
      ...noopCallbacks(),
      onSelectionPaused(value) { paused.push(value); },
    });
    manager.openAll(false, false, true);
    manager.setLayout('fixed');
    paused.length = 0;

    manager.toggleDock(true);
    assert.equal(paused.at(-1), true);

    manager.toggleDock(false);
    assert.equal(paused.at(-1), false);
  } finally { cleanup(); }
});

test('context arriving from outside reopens a collapsed dock', () => {
  const cleanup = installDom();
  try {
    const manager = new ChatWindowManager(noopCallbacks());
    manager.openAll(false, false, true);
    manager.setLayout('fixed');
    manager.toggleDock(true);
    assert.equal(manager.dockCollapsed, true);

    manager.openWithExternalContext({ kind: 'seo', title: 'No og:image', message: 'details' });

    assert.equal(manager.dockCollapsed, false);
    assert.equal(manager.focused().element.hidden, false);
  } finally { cleanup(); }
});

test('floating again brings every window back on screen', () => {
  const cleanup = installDom();
  try {
    const manager = new ChatWindowManager(noopCallbacks());
    const first = manager.focused();
    const second = manager.create();
    manager.openAll(false, false, true);
    manager.setLayout('fixed');
    assert.equal(first.element.hidden, true);

    manager.setLayout('floating');

    assert.equal(first.element.hidden, false);
    assert.equal(second.element.hidden, false);
    assert.equal(first.element.dataset.layout, 'floating');
  } finally { cleanup(); }
});

test('the chosen layout survives a reload', () => {
  const cleanup = installDom();
  try {
    const first = new ChatWindowManager(noopCallbacks());
    first.setLayout('fixed');
    first.setDockWidth(500);
    first.toggleDock(true);

    // A new manager against the same session storage is what a reload produces.
    const restored = new ChatWindowManager(noopCallbacks());
    assert.equal(restored.layout, 'fixed');
    assert.equal(restored.dockWidth, 500);
    assert.equal(restored.dockCollapsed, true);
    assert.equal(restored.focused().element.dataset.layout, 'fixed');
  } finally { cleanup(); }
});

test('the configured layout applies until the user picks one', () => {
  const cleanup = installDom();
  try {
    const manager = new ChatWindowManager(noopCallbacks());
    manager.openAll(false, false, true);
    assert.equal(manager.layout, 'floating');

    manager.setDefaultLayout('fixed');
    assert.equal(manager.layout, 'fixed', 'the project default applies to a session with no choice in it');

    // A default is not a choice, so it must not be stored as one.
    const restored = new ChatWindowManager(noopCallbacks());
    assert.equal(restored.layout, 'floating');
    restored.setDefaultLayout('fixed');
    assert.equal(restored.layout, 'fixed');

    // Once the user switches, the config stops overriding them.
    restored.toggleLayout();
    assert.equal(restored.layout, 'floating');
    restored.setDefaultLayout('fixed');
    assert.equal(restored.layout, 'floating', 'the user outranks the configured default');

    const reloaded = new ChatWindowManager(noopCallbacks());
    reloaded.setDefaultLayout('fixed');
    assert.equal(reloaded.layout, 'floating', 'and the choice survives a reload');
  } finally { cleanup(); }
});

test('turning the share preview off hides its control', () => {
  const cleanup = installDom();
  try {
    const manager = new ChatWindowManager(noopCallbacks());
    manager.openAll(false, false, true);
    const button = () => manager.element.querySelector('.seo-button');
    assert.equal(button().hidden, false);

    manager.setSeoAvailable(false);
    assert.equal(button().hidden, true);

    // A window opened afterwards must not bring the control back.
    const second = manager.create();
    assert.equal(second.element.querySelector('.seo-button').hidden, true);

    manager.setSeoAvailable(true);
    assert.equal(button().hidden, false);
  } finally { cleanup(); }
});

test('the sheet renders only the configured networks', () => {
  const cleanup = installDom('', '<title>Configured</title>');
  try {
    const sheet = new SeoPreviewSheet({ onFix() {} });
    globalThis.document.body.append(sheet.element);

    sheet.configure({ networks: ['google', 'x'] });
    sheet.open();
    assert.deepEqual(
      [...sheet.element.querySelectorAll('.seo-card')].map((card) => card.dataset.network),
      ['google', 'x'],
    );

    // An unknown name can only come from a version skew; it is dropped.
    sheet.configure({ networks: ['google', 'mastodon'] });
    assert.deepEqual(sheet.networks, ['google']);

    // Switching the feature off still leaves the sheet renderable on its own.
    sheet.configure(false);
    assert.equal(sheet.networks.length, 8);

    sheet.destroy();
  } finally { cleanup(); }
});

test('reflowing the page tells the overlays to re-measure', () => {
  const cleanup = installDom();
  try {
    let reflows = 0;
    const manager = new ChatWindowManager({
      ...noopCallbacks(),
      onPageReflow() { reflows += 1; },
    });
    manager.openAll(false, false, true);
    assert.equal(reflows, 0, 'a floating window reflows nothing');

    // Each of these changes how much width the page has, and none of them
    // fires a scroll or resize event for the overlay to notice on its own.
    manager.setLayout('fixed');
    assert.equal(reflows, 1);

    manager.setDockWidth(560);
    assert.equal(reflows, 2);

    manager.toggleDock(true);
    assert.equal(reflows, 3);

    manager.toggleDock(false);
    assert.equal(reflows, 4);

    manager.setLayout('floating');
    assert.equal(reflows, 5, 'releasing the column reflows the page back');

    // A width change while floating moves nothing on the page.
    manager.setDockWidth(400);
    assert.equal(reflows, 5);
  } finally { cleanup(); }
});

test('a long status never pushes the controls out of the panel', () => {
  const cleanup = installDom();
  try {
    const manager = new ChatWindowManager(noopCallbacks());
    manager.openAll(false, false, true);
    const drawer = manager.focused();

    drawer.setNotice('Source-backed selection resolved locally in a notice long enough to overrun the row.');

    const notice = drawer.element.querySelector('.drawer-notice');
    const text = notice.querySelector('.notice-text');
    // The text is its own element, because ellipsis does not apply to a flex
    // container and this one holds the status dot.
    assert.notEqual(text, null);
    assert.match(text.textContent, /^Source-backed selection resolved/);
    assert.match(notice.title, /overrun the row/, 'the full status stays reachable');
    // The existing contract still holds for anything reading the notice.
    assert.match(notice.textContent, /^Source-backed selection resolved/);
  } finally { cleanup(); }
});

test('the toolbar controls carry a word, not just a glyph', () => {
  const cleanup = installDom();
  try {
    const manager = new ChatWindowManager(noopCallbacks());
    manager.openAll(false, false, true);
    const seo = manager.element.querySelector('.seo-button');
    const layout = manager.element.querySelector('.layout-button');

    assert.equal(seo.querySelector('.tool-label').textContent, 'SEO');
    assert.match(seo.getAttribute('aria-label'), /shared link/);
    assert.equal(layout.querySelector('.tool-label').textContent, 'Dock');
    assert.equal(layout.getAttribute('aria-pressed'), 'false');

    // The label states what the button will do next, not the state it is in.
    manager.setLayout('fixed');
    assert.equal(layout.querySelector('.tool-label').textContent, 'Float');
    assert.equal(layout.getAttribute('aria-pressed'), 'true');
    assert.match(layout.getAttribute('aria-label'), /Float the chat windows/);

    manager.setLayout('floating');
    assert.equal(layout.querySelector('.tool-label').textContent, 'Dock');
  } finally { cleanup(); }
});

test('the share preview reads the live page and hands findings to the agent', () => {
  const cleanup = installDom('', `
    <title>Arc flash program basics</title>
    <meta property="og:title" content="Arc flash program basics">
  `);
  try {
    const fixes = [];
    const sheet = new SeoPreviewSheet({ onFix(context) { fixes.push(context); } });
    globalThis.document.body.append(sheet.element);

    assert.equal(sheet.isOpen, false);
    assert.equal(sheet.element.hidden, true);

    sheet.open();
    assert.equal(sheet.isOpen, true);
    // One card per network, each rendering into its own shape.
    const cards = [...sheet.element.querySelectorAll('.seo-card')];
    assert.equal(cards.length, 8);
    assert.deepEqual(
      cards.map((card) => card.dataset.network),
      ['x', 'facebook', 'linkedin', 'instagram', 'discord', 'slack', 'whatsapp', 'google'],
    );
    assert.equal(sheet.element.querySelector('.gg-title').textContent, 'Arc flash program basics');
    // A page with no og:image says so on the card rather than showing an empty box.
    assert.equal(sheet.element.querySelectorAll('.seo-image-missing').length > 0, true);

    sheet.showPane('issues');
    const findings = [...sheet.element.querySelectorAll('.seo-finding')];
    assert.equal(findings.length > 0, true);
    assert.equal(findings.some((item) => item.dataset.level === 'error'), true);

    findings[0].querySelector('.seo-fix')
      .dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true }));

    assert.equal(fixes.length, 1);
    assert.equal(fixes[0].kind, 'seo');
    assert.equal(fixes[0].message.includes('Route: /'), true);
    // Handing a finding over closes the sheet, so the chat it opens is visible.
    assert.equal(sheet.isOpen, false);

    sheet.open();
    sheet.element.querySelector('.seo-fix-all')
      .dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true }));
    assert.equal(fixes.length, 2);
    assert.equal(fixes[1].title.includes('issues'), true);

    sheet.destroy();
  } finally { cleanup(); }
});

test('the Google card renders what the page’s JSON-LD produces', () => {
  const schema = JSON.stringify([
    {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: 'Torque Wrench 200Nm',
      offers: { '@type': 'Offer', price: '189.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
      aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.6, reviewCount: 128 },
    },
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
      mainEntity: [{ '@type': 'Question', name: 'What torque range?', acceptedAnswer: { '@type': 'Answer', text: '20 to 200 Nm.' } }],
    },
  ]);
  const cleanup = installDom('', `<title>Torque Wrench 200Nm</title><script type="application/ld+json">${schema}</script>`);
  try {
    const sheet = new SeoPreviewSheet({ onFix() {} });
    globalThis.document.body.append(sheet.element);
    sheet.configure({ networks: ['google', 'facebook'] });
    sheet.open();

    const google = sheet.element.querySelector('.seo-card[data-network="google"]');
    assert.match(google.querySelector('.gg-url').textContent, /Tools › Torque Wrench/);
    assert.match(google.querySelector('.gg-stars').textContent, /★/);
    assert.match(google.querySelector('.gg-score').textContent, /4\.6 \(128\)/);
    assert.equal(google.querySelector('.gg-price').textContent, '$189.00');
    assert.equal(google.querySelector('.gg-stock').textContent, 'In Stock');
    assert.equal(google.querySelector('.gg-faq-row summary').textContent, 'What torque range?');

    // Only Google renders rich results; the other cards are untouched.
    assert.equal(sheet.element.querySelector('.seo-card[data-network="facebook"] .gg-stars'), null);

    sheet.destroy();
  } finally { cleanup(); }
});

test('the Schema pane lists each block and its findings reach Issues', () => {
  const cleanup = installDom('', `
    <title>Broken schema</title>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article"}</script>
    <script type="application/ld+json">{ not json }</script>
  `);
  try {
    const fixes = [];
    const sheet = new SeoPreviewSheet({ onFix(context) { fixes.push(context); } });
    globalThis.document.body.append(sheet.element);
    sheet.open();

    sheet.showPane('schema');
    const blocks = [...sheet.element.querySelectorAll('.schema-block')];
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks.map((block) => block.dataset.state), ['parsed', 'invalid']);
    assert.equal(blocks[0].querySelector('.schema-type').textContent, 'Article');
    assert.notEqual(blocks[1].querySelector('.schema-error'), null);

    // Schema problems are ordinary findings, sorted in with the meta-tag ones.
    sheet.showPane('issues');
    const titles = [...sheet.element.querySelectorAll('.seo-finding-title')].map((node) => node.textContent);
    assert.equal(titles.some((title) => /not valid JSON/.test(title)), true);
    assert.equal(titles.some((title) => /Article is missing headline/.test(title)), true);
    assert.equal(titles.some((title) => /og:image/.test(title)), true, 'meta findings are still there');

    // Fixing a schema finding hands the agent the JSON as well as the tags.
    const row = [...sheet.element.querySelectorAll('.seo-finding')]
      .find((item) => /not valid JSON/.test(item.querySelector('.seo-finding-title').textContent));
    row.querySelector('.seo-fix').dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true }));
    assert.equal(fixes[0].kind, 'seo');
    assert.match(fixes[0].message, /Structured data: 2 blocks/);
    assert.match(fixes[0].message, /block 2: unparseable/);

    sheet.destroy();
  } finally { cleanup(); }
});

test('the Schema pane draws each entity, with the JSON behind a toggle', () => {
  const schema = JSON.stringify([
    {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: 'Torque Wrench 200Nm',
      offers: { '@type': 'Offer', price: '189.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
      aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.6, reviewCount: 128 },
      brand: { '@type': 'Brand', name: 'Acme Tools' },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Tools', item: 'https://example.com/tools' },
        { '@type': 'ListItem', position: 2, name: 'Torque Wrench' },
      ],
    },
    { '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Astro AI', operatingSystem: 'macOS' },
  ]);
  const cleanup = installDom('', `<title>Torque Wrench</title><script type="application/ld+json">${schema}</script>`);
  try {
    const sheet = new SeoPreviewSheet({ onFix() {} });
    globalThis.document.body.append(sheet.element);
    sheet.open();
    sheet.showPane('schema');

    const cards = [...sheet.element.querySelectorAll('.entity-card')];
    assert.deepEqual(cards.map((card) => card.dataset.type), ['Product', 'BreadcrumbList', 'SoftwareApplication']);

    // A Product is drawn as a product, not as braces.
    const product = cards[0];
    assert.equal(product.querySelector('.entity-name').textContent, 'Torque Wrench 200Nm');
    assert.equal(product.querySelector('.entity-price').textContent, '$189.00');
    assert.equal(product.querySelector('.entity-stock').textContent, 'In Stock');
    assert.match(product.querySelector('.gg-stars').textContent, /★/);
    assert.match(product.querySelector('.entity-meta').textContent, /Acme Tools/);

    // A trail is drawn as a trail, and marks the crumb that links nowhere.
    assert.deepEqual(
      [...cards[1].querySelectorAll('.entity-crumb')].map((crumb) => crumb.textContent),
      ['Tools', 'Torque Wrench'],
    );

    // A type with no card of its own still shows its fields rather than nothing.
    assert.equal(cards[2].querySelector('.entity-name').textContent, 'Astro AI');
    assert.match(cards[2].querySelector('.entity-fields').textContent, /operatingSystem/);

    // The JSON is still reachable, just no longer the first thing shown.
    assert.equal(sheet.element.querySelectorAll('.schema-source pre').length, 1);
    sheet.destroy();
  } finally { cleanup(); }
});

test('a Product with no price says so on the card', () => {
  const schema = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Torque Wrench',
    offers: { '@type': 'Offer', priceCurrency: 'USD' },
  });
  const cleanup = installDom('', `<title>x</title><script type="application/ld+json">${schema}</script>`);
  try {
    const sheet = new SeoPreviewSheet({ onFix() {} });
    globalThis.document.body.append(sheet.element);
    sheet.open();
    sheet.showPane('schema');

    assert.equal(sheet.element.querySelector('.entity-missing').textContent, 'no price');
    assert.equal(sheet.element.querySelector('.entity-price'), null);
    sheet.destroy();
  } finally { cleanup(); }
});

test('the AEO pane shows what an answer engine can take, and the answer it affords', () => {
  const schema = JSON.stringify([
    {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: 'Torque Wrench 200Nm',
      offers: { '@type': 'Offer', price: '189.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
      aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.6, reviewCount: 128 },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [{ '@type': 'Question', name: 'What torque range?', acceptedAnswer: { '@type': 'Answer', text: '20 to 200 Nm.' } }],
    },
  ]);
  const cleanup = installDom(
    '<main><h1>Torque Wrench</h1><p>Calibrated to 200 Nm.</p></main>',
    `<title>Torque Wrench 200Nm</title><script type="application/ld+json">${schema}</script>`,
  );
  try {
    const sheet = new SeoPreviewSheet({ onFix() {} });
    globalThis.document.body.append(sheet.element);
    sheet.open();
    sheet.showPane('aeo');

    assert.equal(sheet.element.querySelector('.aeo-subject-type').textContent, 'Product');
    assert.equal(sheet.element.querySelector('.aeo-subject-name').textContent, 'Torque Wrench 200Nm');

    const facts = sheet.element.querySelector('.aeo-facts').textContent;
    assert.match(facts, /Price/);
    assert.match(facts, /USD 189\.00/);
    // A fact from schema is marked apart from one read out of a meta tag.
    assert.match(sheet.element.querySelector('.aeo-source').textContent, /structured/);

    assert.equal(sheet.element.querySelector('.aeo-question').textContent, 'What torque range?FAQ schema');

    const answer = sheet.element.querySelector('.aeo-answer');
    assert.equal(answer.dataset.grounding, 'strong');
    assert.match(answer.querySelector('.aeo-sentence').textContent, /costs USD 189\.00/);
    // The mock must never pass itself off as a model's output.
    assert.match(sheet.element.querySelector('.aeo-caveat').textContent, /not generated by a model/);

    sheet.destroy();
  } finally { cleanup(); }
});

test('a page with nothing to quote says so rather than inventing an answer', () => {
  const cleanup = installDom('<main><p>Hello.</p></main>', '<title>A page</title>');
  try {
    const fixes = [];
    const sheet = new SeoPreviewSheet({ onFix(context) { fixes.push(context); } });
    globalThis.document.body.append(sheet.element);
    sheet.open();
    sheet.showPane('aeo');

    assert.equal(sheet.element.querySelector('.aeo-subject').dataset.state, 'missing');
    assert.equal(sheet.element.querySelector('.aeo-answer').dataset.grounding, 'thin');
    assert.match(sheet.element.querySelector('.aeo-findings-note').textContent, /limiting how quotable/);

    // AEO findings are ordinary findings, and carry the extraction to the agent.
    sheet.showPane('issues');
    const row = [...sheet.element.querySelectorAll('.seo-finding')]
      .find((item) => /no headings|readable text|quoted as a fact/i.test(item.querySelector('.seo-finding-title').textContent));
    row.querySelector('.seo-fix').dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true }));
    assert.match(fixes[0].message, /What an answer engine can take/);

    sheet.destroy();
  } finally { cleanup(); }
});

test('a meta-only fix is not padded with JSON the agent need not read', () => {
  const cleanup = installDom('', `
    <title>A page</title>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Person","name":"A"}</script>
  `);
  try {
    const fixes = [];
    const sheet = new SeoPreviewSheet({ onFix(context) { fixes.push(context); } });
    globalThis.document.body.append(sheet.element);
    sheet.open();
    sheet.showPane('issues');

    const row = [...sheet.element.querySelectorAll('.seo-finding')]
      .find((item) => /No og:image/.test(item.querySelector('.seo-finding-title').textContent));
    row.querySelector('.seo-fix').dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true }));

    assert.match(fixes[0].message, /og:image/);
    assert.equal(/Structured data:/.test(fixes[0].message), false);
    sheet.destroy();
  } finally { cleanup(); }
});

test('the share preview closes on Escape', () => {
  const cleanup = installDom();
  try {
    const sheet = new SeoPreviewSheet({ onFix() {} });
    globalThis.document.body.append(sheet.element);
    sheet.open();

    globalThis.document.dispatchEvent(
      new globalThis.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );

    assert.equal(sheet.isOpen, false);
    assert.equal(sheet.element.hidden, true);
    sheet.destroy();
  } finally { cleanup(); }
});

function tabs(manager) {
  return [...manager.element.querySelectorAll('.dock-tab')];
}

function labels(manager) {
  return tabs(manager).map((tab) => tab.querySelector('.dock-tab-label').textContent);
}

/** The inset rule the dock writes into the page's own head, if any. */
function pageInset() {
  const style = globalThis.document.querySelector('style[data-astro-ai="dock-inset"]');
  if (style === null || style.parentNode === null) return undefined;
  return style.textContent.match(/margin-right:\s*([^\s!]+)/)?.[1];
}

function noopCallbacks() {
  return {
    onSubmit() {},
    onCancel() {},
    onUndo() {},
    onRedo() {},
    onSessionClose() {},
    onEmpty() {},
    onSelectionPaused() {},
    onOpenSeo() {},
  };
}

function installDom(markup = '', head = '') {
  const dom = new JSDOM(
    `<!doctype html><html lang="en"><head>${head}</head><body>${markup}</body></html>`,
    { url: 'http://localhost/' },
  );
  dom.window.requestAnimationFrame = (callback) => dom.window.setTimeout(() => callback(Date.now()), 0);
  dom.window.cancelAnimationFrame = (id) => dom.window.clearTimeout(id);
  const previous = new Map();
  const globals = {
    window: dom.window,
    document: dom.window.document,
    sessionStorage: dom.window.sessionStorage,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Image: dom.window.Image,
    Node: dom.window.Node,
    DOMRect: dom.window.DOMRect,
    MutationObserver: dom.window.MutationObserver,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, globalThis[key]);
    globalThis[key] = value;
  }
  return () => {
    dom.window.close();
    for (const [key, value] of previous) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  };
}
