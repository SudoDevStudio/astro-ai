# Examples

Each example is a standalone Astro app that depends on this repository through
`file:../..`, so it runs your working tree rather than the published package.

```sh
npm install              # at the repository root, once
cd examples/<name>
npm install
npm run dev
```

`npm run dev` builds the package first, so a change in `../../src` is picked up
by restarting the dev server.

| Example | Island | Editor support |
| --- | --- | --- |
| [basic](basic) | React JSX | full |
| [with-react](with-react) | React JSX | full |
| [with-preact](with-preact) | Preact JSX | full |
| [with-solid](with-solid) | Solid JSX | full |
| [with-vue](with-vue) | Vue SFC | Astro pages only |
| [with-svelte](with-svelte) | Svelte | Astro pages only |

## What "full" means

Selecting inside the island resolves it to its own source file, and text, props,
reordering, and removal all work there. Verified by counting instrumented nodes
served by each dev server:

| Example | Astro page nodes | Island nodes |
| --- | --- | --- |
| with-react | 10 | 8 |
| with-preact | 10 | 8 |
| with-solid | 10 | 12 |
| with-vue | 12 | 0 |
| with-svelte | 11 | 0 |

Solid reports more because its example renders two lists, one with `<For each>`
and one with `<Index each>`.

## Vue and Svelte

Their islands are not indexed. The surrounding `.astro` page is fully editable,
but selecting inside the component does nothing, and the resolver rejects those
files with `Unsupported source file type`.

The resolver parses Astro with the Astro compiler and JSX with Babel. A single
file component needs its own compiler and its own instrumentation, which is why
React, Preact and Solid came almost free while these two did not. Both examples
exist as the development fixture for that work.

## Which example to start from

`basic` is the broadest tour and the one to open when testing a change to the
editor: content sources, registered components, repeated templates, a React
island, share preview fixtures, and client-side navigation across nine pages.

The framework examples are deliberately small and near-identical to each other,
so they are the ones to copy when starting a project or comparing behaviour
between frameworks. `basic` carries React too, but only as one page of a larger
tour — it is not the place to compare frameworks.
