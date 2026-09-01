import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AstroResolver } from '../dist/resolver/astro-resolver.js';
import { VisualCapabilityResolver } from '../dist/visual/capability-resolver.js';
import { VisualCommandEngine } from '../dist/visual/command-engine.js';
import { PatchTransactionStore } from '../dist/visual/patch-transactions.js';

const fixture = `---
const title = 'From a local variable';
const products = [{ name: 'One' }, { name: 'Two' }];
---
<main>
  <h2>Hello</h2>
  <p>First</p>
  <p>Second</p>
  <Card label="Card title" tone="violet" count={2} active={true} />
  <div>{title}</div>
  <ul>{products.map((product) => <li>{product.name}</li>)}</ul>
</main>
`;

test('instruments source-backed Astro nodes and classifies safe capabilities', async (t) => {
  const setup = await createFixture(t);
  const instrumented = setup.resolver.instrumentFile(setup.file, fixture);
  const nodes = setup.resolver.listNodes(setup.file);
  const heading = nodes.find(({ tagName, textValue }) => tagName === 'h2' && textValue === 'Hello');
  const component = nodes.find(({ componentName }) => componentName === 'Card');
  const dynamic = nodes.find(({ tagName, sourceKind }) => tagName === 'div' && sourceKind === 'local-variable');
  const repeated = nodes.find(({ tagName }) => tagName === 'li');

  assert.ok(heading);
  assert.ok(component);
  assert.ok(dynamic);
  assert.ok(repeated);
  assert.match(instrumented.code, new RegExp(`data-astro-ai-id="${heading.nodeId}"`));
  assert.match(instrumented.code, /data-astro-ai-name="h2"/);
  assert.match(instrumented.code, /data-astro-ai-source="page\.astro:6"/);
  assert.equal(instrumented.map.sources[0], 'page.astro');

  const headingContext = setup.resolver.resolveSelection(heading.nodeId, '/');
  assert.equal(headingContext.capabilities.editableText, true);
  assert.equal(headingContext.capabilities.sourceKind, 'literal-source');
  assert.equal(headingContext.capabilities.reorderable, true);

  const componentContext = setup.resolver.resolveSelection(component.nodeId, '/');
  assert.deepEqual(
    componentContext.capabilities.editableProps.map(({ name, type, value }) => ({ name, type, value })),
    [
      { name: 'label', type: 'string', value: 'Card title' },
      { name: 'tone', type: 'string', value: 'violet' },
      { name: 'count', type: 'number', value: 2 },
      { name: 'active', type: 'boolean', value: true },
    ],
  );

  const dynamicContext = setup.resolver.resolveSelection(dynamic.nodeId, '/');
  assert.equal(dynamicContext.capabilities.editableText, false);
  assert.equal(dynamicContext.capabilities.dataProvenance.kind, 'local');
  assert.equal(dynamicContext.capabilities.dataProvenance.symbol, 'title');

  const repeatedContext = setup.resolver.resolveSelection(repeated.nodeId, '/');
  assert.equal(repeatedContext.capabilities.sourceKind, 'repeated-template');
  assert.equal(repeatedContext.capabilities.repeatContext?.affectsAllInstances, true);
  assert.equal(repeatedContext.capabilities.editableText, false);
});

test('edits literal text and supports undo and redo', async (t) => {
  const { file, resolver, engine } = await createFixture(t);
  const heading = resolver.listNodes(file).find(({ tagName }) => tagName === 'h2');
  assert.ok(heading);

  await engine.execute({ kind: 'edit-literal-text', nodeId: heading.nodeId, text: 'Hello <Astro>' });
  assert.match(await readFile(file, 'utf8'), /<h2>Hello &lt;Astro&gt;<\/h2>/);
  assert.equal(engine.transactions.state().canUndo, true);

  await engine.transactions.undo();
  assert.equal(await readFile(file, 'utf8'), fixture);
  await engine.transactions.redo();
  assert.match(await readFile(file, 'utf8'), /<h2>Hello &lt;Astro&gt;<\/h2>/);
});

test('reorders compatible sibling AST nodes and undoes the transaction', async (t) => {
  const { file, resolver, engine } = await createFixture(t);
  const first = resolver.listNodes(file).find(({ tagName, textValue }) => tagName === 'p' && textValue === 'First');
  assert.ok(first);

  await engine.execute({ kind: 'reorder-sibling', nodeId: first.nodeId, direction: 'next' });
  const changed = await readFile(file, 'utf8');
  assert.ok(changed.indexOf('<p>Second</p>') < changed.indexOf('<p>First</p>'));

  await engine.transactions.undo();
  assert.equal(await readFile(file, 'utf8'), fixture);
});

test('changes a literal component prop and undoes the transaction', async (t) => {
  const { file, resolver, engine } = await createFixture(t);
  const component = resolver.listNodes(file).find(({ componentName }) => componentName === 'Card');
  assert.ok(component);

  await engine.execute({
    kind: 'set-literal-prop',
    nodeId: component.nodeId,
    prop: 'count',
    value: 3,
  });
  assert.match(await readFile(file, 'utf8'), /tone="violet" count=\{3\}/);

  await engine.transactions.undo();
  assert.equal(await readFile(file, 'utf8'), fixture);
});

test('enforces registered enum metadata before changing source', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'astro-ai-visual-'));
  const file = join(directory, 'page.astro');
  await writeFile(file, fixture, 'utf8');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const resolver = new AstroResolver(
    directory,
    new VisualCapabilityResolver([
      {
        name: 'Card',
        props: {
          tone: { control: 'enum', values: ['violet', 'mint'] },
        },
      },
    ]),
  );
  resolver.indexFile(file, fixture);
  const component = resolver.listNodes(file).find(({ componentName }) => componentName === 'Card');
  assert.ok(component);
  const engine = new VisualCommandEngine(resolver);

  await assert.rejects(
    engine.execute({
      kind: 'set-literal-prop',
      nodeId: component.nodeId,
      prop: 'tone',
      value: 'danger',
    }),
    /does not accept that value/,
  );
  assert.equal(await readFile(file, 'utf8'), fixture);
});

test('rejects rendered local-variable text instead of overwriting it', async (t) => {
  const { file, resolver, engine } = await createFixture(t);
  const dynamic = resolver.listNodes(file).find(({ tagName, sourceKind }) => tagName === 'div' && sourceKind === 'local-variable');
  assert.ok(dynamic);

  await assert.rejects(
    engine.execute({ kind: 'edit-literal-text', nodeId: dynamic.nodeId, text: 'Unsafe' }),
    /cannot be overwritten safely/,
  );
  assert.equal(await readFile(file, 'utf8'), fixture);
  assert.deepEqual(engine.transactions.state(), { canUndo: false, canRedo: false });
});

test('commits multi-file AI changes as one reversible transaction', async (t) => {
  const { file, resolver, engine } = await createFixture(t);
  const secondFile = join(resolver.projectRoot, 'generated.ts');
  const before = await readFile(file, 'utf8');
  const after = before.replace('From a local variable', 'Changed by an agent');

  const transaction = await engine.transactions.commitBatch('agent', [
    { file, before, after },
    { file: secondFile, after: 'export const generated = true;\n' },
  ]);
  assert.deepEqual(transaction.files, ['page.astro', 'generated.ts']);
  assert.match(await readFile(file, 'utf8'), /Changed by an agent/);
  assert.equal(await readFile(secondFile, 'utf8'), 'export const generated = true;\n');

  await engine.transactions.undo();
  assert.equal(await readFile(file, 'utf8'), before);
  await assert.rejects(readFile(secondFile, 'utf8'), /ENOENT/);

  await engine.transactions.redo();
  assert.match(await readFile(file, 'utf8'), /Changed by an agent/);
  assert.equal(await readFile(secondFile, 'utf8'), 'export const generated = true;\n');
});

test('wraps all transaction writes in one source-change notification boundary', async (t) => {
  const { file, resolver } = await createFixture(t);
  const secondFile = join(resolver.projectRoot, 'agent-generated.ts');
  const before = await readFile(file, 'utf8');
  const events = [];
  const store = new PatchTransactionStore(resolver, {
    async beforeApply(files) {
      events.push(['before', [...files]]);
    },
    async afterApply(files) {
      events.push(['after', [...files]]);
      assert.match(await readFile(file, 'utf8'), /Agent batch value/);
      assert.equal(await readFile(secondFile, 'utf8'), 'export const batch = true;\n');
    },
  });

  await store.commitBatch('agent', [
    { file, before, after: before.replace('From a local variable', 'Agent batch value') },
    { file: secondFile, after: 'export const batch = true;\n' },
  ]);

  assert.deepEqual(events, [
    ['before', [file, secondFile]],
    ['after', [file, secondFile]],
  ]);
});

test('instruments and deterministically edits source-backed React TSX', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'astro-ai-react-'));
  const file = join(directory, 'ProductCard.tsx');
  const source = `type ProductCardProps = { title: string };

export function ProductCard({ title }: ProductCardProps) {
  return (
    <section data-tone="violet">
      <h2>React heading</h2>
      <p>First detail</p>
      <p>Second detail</p>
      <span>{title}</span>
    </section>
  );
}
`;
  await writeFile(file, source, 'utf8');
  t.after(() => rm(directory, { recursive: true, force: true }));

  const resolver = new AstroResolver(directory);
  const instrumented = resolver.instrumentFile(file, source);
  const heading = resolver.listNodes(file).find(({ tagName }) => tagName === 'h2');
  const section = resolver.listNodes(file).find(({ tagName }) => tagName === 'section');
  const first = resolver.listNodes(file).find(({ textValue }) => textValue === 'First detail');
  const dynamic = resolver.listNodes(file).find(({ tagName }) => tagName === 'span');
  assert.ok(heading);
  assert.ok(section);
  assert.ok(first);
  assert.ok(dynamic);
  assert.match(instrumented.code, new RegExp(`data-astro-ai-id="${heading.nodeId}"`));
  assert.equal(heading.sourceLanguage, 'tsx');
  assert.equal(heading.parentComponents[0]?.name, 'ProductCard');

  const dynamicContext = resolver.resolveSelection(dynamic.nodeId, '/');
  assert.equal(dynamicContext.capabilities.editableText, false);
  assert.equal(dynamicContext.capabilities.dataProvenance.kind, 'prop');
  assert.equal(dynamicContext.capabilities.dataProvenance.symbol, 'title');

  const engine = new VisualCommandEngine(resolver);
  await engine.execute({
    kind: 'edit-literal-text',
    nodeId: heading.nodeId,
    text: 'Edited in TSX',
  });
  assert.match(await readFile(file, 'utf8'), /<h2>Edited in TSX<\/h2>/);

  const refreshedHeading = resolver.listNodes(file).find(({ tagName }) => tagName === 'h2');
  assert.ok(refreshedHeading);
  await engine.execute({
    kind: 'set-literal-prop',
    nodeId: resolver.listNodes(file).find(({ tagName }) => tagName === 'section').nodeId,
    prop: 'data-tone',
    value: 'mint',
  });
  assert.match(await readFile(file, 'utf8'), /data-tone="mint"/);

  const refreshedFirst = resolver.listNodes(file).find(({ textValue }) => textValue === 'First detail');
  assert.ok(refreshedFirst);
  await engine.execute({ kind: 'reorder-sibling', nodeId: refreshedFirst.nodeId, direction: 'next' });
  const reordered = await readFile(file, 'utf8');
  assert.ok(reordered.indexOf('Second detail') < reordered.indexOf('First detail'));

  await engine.transactions.undo();
  assert.ok((await readFile(file, 'utf8')).indexOf('First detail') < (await readFile(file, 'utf8')).indexOf('Second detail'));
});

test('parses React JSX literal props without treating expressions as editable text', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'astro-ai-react-jsx-'));
  const file = join(directory, 'Badge.jsx');
  const source = `export const Badge = ({ label }) => (
  <div aria-label="Badge" data-active={true}>
    <strong>JSX badge</strong>
    <span>{label}</span>
  </div>
);
`;
  await writeFile(file, source, 'utf8');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const resolver = new AstroResolver(directory);
  resolver.indexFile(file, source);

  const root = resolver.listNodes(file).find(({ tagName }) => tagName === 'div');
  const dynamic = resolver.listNodes(file).find(({ tagName }) => tagName === 'span');
  assert.ok(root);
  assert.ok(dynamic);
  assert.deepEqual(
    root.literalProps.map(({ name, type, value }) => ({ name, type, value })),
    [
      { name: 'aria-label', type: 'string', value: 'Badge' },
      { name: 'data-active', type: 'boolean', value: true },
    ],
  );
  assert.equal(resolver.resolveSelection(dynamic.nodeId, '/').capabilities.editableText, false);
  assert.equal(dynamic.dataProvenance.kind, 'prop');
});

async function createFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'astro-ai-visual-'));
  const file = join(directory, 'page.astro');
  await writeFile(file, fixture, 'utf8');
  t.after(() => rm(directory, { recursive: true, force: true }));

  const resolver = new AstroResolver(directory);
  resolver.indexFile(file, fixture);
  return {
    file,
    resolver,
    engine: new VisualCommandEngine(resolver),
  };
}
