# with-solid example

An Astro app with a with-solid island, wired to this repository rather than to npm.

```sh
npm install              # at the repository root, once
cd examples/with-solid
npm install
npm run dev
```

`npm run dev` builds the package first, so a change in `../../src` is picked
up by restarting the dev server.

## What to try

Select a list item in either list. Solid renders lists through `<For each>`
and `<Index each>` instead of `.map()`, and the action bar warns that the
item is a repeated template in both cases. Without that detection an edit would
silently rewrite every row.
