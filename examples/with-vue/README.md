# with-vue example

An Astro app with a with-vue island, wired to this repository rather than to npm.

```sh
npm install              # at the repository root, once
cd examples/with-vue
npm install
npm run dev
```

`npm run dev` builds the package first, so a change in `../../src` is picked
up by restarting the dev server.

## Not supported yet

The editor does not index Vue single-file components. Selecting inside the card
does nothing, while everything in the surrounding `.astro` page works normally.

`.vue` currently rejects with `Unsupported source file type: .vue`, because
the resolver parses Astro with the Astro compiler and JSX with Babel, and an SFC
needs `@vue/compiler-sfc` plus its own instrumentation.

This example exists as the development fixture for that work.
