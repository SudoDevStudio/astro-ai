# with-react example

An Astro app with a with-react island, wired to this repository rather than to npm.

```sh
npm install              # at the repository root, once
cd examples/with-react
npm install
npm run dev
```

`npm run dev` builds the package first, so a change in `../../src` is picked
up by restarting the dev server.

## What to try

Select the heading inside the card, then edit its text. Select a list item and
the action bar warns that the list is a repeated template, because all three
items come from one `.map()` and one edit rewrites every row.
