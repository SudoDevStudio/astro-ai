# with-svelte example

An Astro app with a with-svelte island, wired to this repository rather than to npm.

```sh
npm install              # at the repository root, once
cd examples/with-svelte
npm install
npm run dev
```

`npm run dev` builds the package first, so a change in `../../src` is picked
up by restarting the dev server.

## Not supported yet

The editor does not index Svelte components. Selecting inside the card does
nothing, while everything in the surrounding `.astro` page works normally.

`.svelte` currently rejects with `Unsupported source file type: .svelte`,
because the resolver parses Astro with the Astro compiler and JSX with Babel,
and Svelte needs its own compiler plus its own instrumentation.

This example exists as the development fixture for that work.
