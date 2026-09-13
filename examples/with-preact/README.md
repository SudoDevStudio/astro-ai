# with-preact example

An Astro app with a with-preact island, wired to this repository rather than to npm.

```sh
npm install              # at the repository root, once
cd examples/with-preact
npm install
npm run dev
```

`npm run dev` builds the package first, so a change in `../../src` is picked
up by restarting the dev server.

## What to try

Preact reaches the same parser as React, so selection, text editing, prop
editing and repeat detection behave identically. The one visible difference is
`class` instead of `className`, which is indexed either way.
