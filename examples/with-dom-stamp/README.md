# with-dom-stamp example

An Astro app whose content arrives from a fetch, marked up by
`@sudodevstudio/astro-dom-stamp` and read back by the editor. Wired to this
repository rather than to npm.

```sh
npm install              # at the repository root, once
cd examples/with-dom-stamp
npm install
npm run dev
```

`npm run dev` builds the package first, so a change in `../../src` is picked
up by restarting the dev server. It also sets `ASTRO_DOM_STAMP_EDIT=true`,
because stamping is decided at build time; `npm run dev:plain` starts the same
app with nothing stamped.

## What this example is for

Every other example declares `contentSources` by hand. This one declares
nothing about attributes at all:

```js
buildWithAI({
  domStamp: { read: ['_type', 'id', 'sku'], deepStamps: true, enabled: editing },
});
```

The editor registers dom-stamp with those options and asks it which attributes
it will write, then builds the content source from the answer. `data-stamp-id`
becomes the entry id and `data-stamp-type`, `data-stamp-sku`, and
`data-stamp-field` become its facets, without any of those names being written
twice.

The page fetches `/api/products.json` rather than importing the catalogue,
because a module import is not a response and there is nothing in it to mark.
That is also why the app runs `output: 'server'`.

## What to try

Select a product heading. The selection reports the entry it belongs to and
the field it renders — the `title` of product `p0`, not merely that the text
belongs to `p0`.

Then select a variant label. It reports the **variant** and its own type, and
does not borrow the product's field, because a facet counts only when it sits
on the entry's own element or inside it. Nested records are the case this
rule exists for.

Ask AI about either selection and the agent is told which part of which entry
it is looking at, so it changes the entry rather than hardcoding the words
into the template.
