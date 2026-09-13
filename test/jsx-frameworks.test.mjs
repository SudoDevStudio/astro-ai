import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AstroResolver } from '../dist/resolver/astro-resolver.js';

// Preact and Solid islands are JSX and TSX, so they reach the same parser as
// React. These lock that in, because "it happens to work" is not support.

test('indexes and edits Preact islands the same as React ones', async (t) => {
  const { resolver, index } = await createFixture(t, {
    'React.jsx': `export function Card() {
  return (<div className="card"><h2>React heading</h2></div>);
}`,
    // Preact uses `class` where React uses `className`, and ships .tsx too.
    'Preact.tsx': `export function Card() {
  return (<div class="card"><h2>Preact heading</h2></div>);
}`,
  });

  for (const [name, text] of [['React.jsx', 'React heading'], ['Preact.tsx', 'Preact heading']]) {
    const heading = index(name).find(({ tagName }) => tagName === 'h2');
    assert.notEqual(heading, undefined, `${name} produced no h2 node`);
    assert.equal(heading.textValue, text);
    assert.notEqual(heading.textRange, undefined, `${name} heading is not text-editable`);

    const context = resolver.resolveSelection(heading.nodeId, '/');
    assert.equal(context.capabilities.editableText, true);
    // The label is framework-neutral: the parser cannot tell these dialects
    // apart, so it must not claim one of them.
    assert.match(context.capabilities.dataProvenance.description, /JSX template/);
  }
});

test('treats Solid list components as repeated templates', async (t) => {
  const { resolver, index } = await createFixture(t, {
    'Map.jsx': `export function L({items}) {
  return (<ul>{items.map((i) => <li>{i.name}</li>)}</ul>);
}`,
    'For.tsx': `import { For } from 'solid-js';
export function L(props) {
  return (<ul><For each={props.items}>{(i) => <li>{i.name}</li>}</For></ul>);
}`,
    'Index.tsx': `import { Index } from 'solid-js';
export function L(props) {
  return (<ul><Index each={props.items}>{(i) => <li>{i().name}</li>}</Index></ul>);
}`,
  });

  // Solid renders lists without .map(), so without this these items would be
  // offered for editing with no warning that one edit rewrites every row.
  for (const [file, expected] of [
    ['Map.jsx', /\.map\(\) template/],
    ['For.tsx', /<For each> template/],
    ['Index.tsx', /<Index each> template/],
  ]) {
    const item = index(file).find(({ tagName }) => tagName === 'li');
    assert.notEqual(item, undefined, `${file} produced no li node`);
    assert.equal(item.sourceKind, 'repeated-template', `${file} is not a repeated template`);
    assert.match(item.repeatContext.description, expected);
    assert.equal(item.repeatContext.affectsAllInstances, true);

    const context = resolver.resolveSelection(item.nodeId, '/');
    assert.notEqual(context.capabilities.repeatContext, undefined);
  }
});

test('does not mistake ordinary components for list templates', async (t) => {
  const { index } = await createFixture(t, {
    // `For` without `each` is not a list, and an unrelated wrapper never is.
    'ForNoEach.tsx': `export function L() { return (<For><li>Not a list</li></For>); }`,
    'Wrapper.tsx': `export function L() { return (<Wrapper><li>Only one</li></Wrapper>); }`,
  });

  for (const file of ['ForNoEach.tsx', 'Wrapper.tsx']) {
    const item = index(file).find(({ tagName }) => tagName === 'li');
    assert.notEqual(item, undefined, `${file} produced no li node`);
    assert.equal(item.repeatContext, undefined, `${file} was wrongly treated as a repeat`);
    assert.equal(item.sourceKind, 'literal-source');
  }
});

async function createFixture(t, files) {
  const directory = await mkdtemp(join(tmpdir(), 'astro-ai-jsx-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const resolver = new AstroResolver(directory);
  const paths = new Map();

  for (const [name, source] of Object.entries(files)) {
    const file = join(directory, name);
    await writeFile(file, source, 'utf8');
    resolver.indexFile(file, source);
    paths.set(name, file);
  }

  return { resolver, index: (name) => resolver.listNodes(paths.get(name)) };
}
