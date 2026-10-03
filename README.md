# @sudodevstudio/astro-ai

[![npm](https://img.shields.io/npm/v/@sudodevstudio/astro-ai)](https://www.npmjs.com/package/@sudodevstudio/astro-ai)
[![license](https://img.shields.io/npm/l/@sudodevstudio/astro-ai)](LICENSE)
[![astro](https://img.shields.io/badge/astro-7.x-BC52EE)](https://astro.build)

Development-only visual editing for Astro, with optional Codex or Claude CLI
support. Source files stay authoritative, changes render through Vite HMR, and
no editor runtime or metadata reaches a production build.

It is a tool for building the site, not one you ship with it: it runs only under
`astro dev`, and is not a CMS, a production page builder, or a hosted service.

https://github.com/user-attachments/assets/b92406dc-c632-496e-9582-7017bea1fa9c

## Install

Requires Node 22.12 or newer, Astro 7, and Vite 7 or 8.

```sh
npm install --save-dev @sudodevstudio/astro-ai
```

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import buildWithAI from '@sudodevstudio/astro-ai';

export default defineConfig({
  integrations: [buildWithAI({ agent: 'codex' })], // or 'claude'
});
```

Authenticate the CLI before starting Astro: `codex login`, or launch `claude`
and complete its login flow. Prereleases ship under the `beta` dist-tag.

## Editing

- Select and inspect source-backed Astro, JSX, and TSX elements.
- Astro templates plus React, Preact, and Solid islands. Vue and Svelte single
  file components are not supported yet.
- Edit literal text and props without using AI.
- Reorder, remove, insert, and move compatible source nodes.
- Multi-select by Shift-click or drag marquee.
- Undo, redo, conflict recovery, and human-readable diffs.
- Click through a selection to drive the running app — open a menu, switch a
  tab — then edit what it reveals.
- Trace an element back to the CMS entry that owns its content, so the agent
  changes the entry instead of hardcoding fetched words into source.

## Agent

- Ask Codex or Claude for explanations and code changes.
- Attach text, code, or screenshots by picker, drag-and-drop, or paste.
- Send Vite errors and Astro audit findings to the agent with **Fix with AI**.

## Audits

The green **SEO** button opens a full-screen reading of the current route.

| Tab | What it shows |
| --- | --- |
| **Previews** | One card per network, each reading the tag chain that network actually reads and truncating where it truncates. |
| **Issues** | What a reader will see go wrong: a relative `og:image` no crawler can fetch, an image loading at 64px despite declaring 1200×630, an `og:url` that disagrees with the canonical. |
| **Schema** | The page's JSON-LD drawn as the things it describes rather than as braces, with what each missing property costs. |
| **AEO** | What an answer engine can take: the subject, facts it can lift verbatim, Q&A pairs, provenance, and how much text survives before JavaScript runs. |
| **Site** | Every route audited at once, findings grouped by cause rather than one row per page, with **Fix everywhere** for a whole class. |
| **Tags** | Every title, meta, link, and `lang` value the page rendered, duplicates included. |

Every finding carries **Fix with AI**. Dynamic routes are listed but never
requested, and the walk stops at a request ceiling. **Re-read page** after an
edit shows the result once Vite has applied it.

Needs no setup — everything comes from the page's own head.

## Chat windows

Windows float over the page, or dock to a column on the right or a strip along
the bottom with tabs across conversations. Up to six, restored on reload.

Each window is an independent conversation with its own turn history,
attachments, and isolated provider workspace. Source history is shared, so undo
and redo act on one stack and stay in sync everywhere. Runs that can change
source are queued so only one applies at a time; answer-only runs run
concurrently.

Limits: five attachments per request, 256 KB per text file, 5 MB per
screenshot. Attachments are sent with that request only and never stored in
chat history. Toolbar history lives in the browser tab's `sessionStorage` and is
not mirrored into the Codex or Claude desktop apps.

## Configuration

```js
buildWithAI({
  agent: { provider: 'codex', model: 'your-model' },
  contentSources: [{ name: 'anycms', attribute: 'data-entry-id', mcp: 'anycms' }],
  skills: ['AGENTS.md'],
  excludeDirectories: ['vendor', 'src/generated'],
  seo: { networks: ['x', 'linkedin', 'google'] },
  chatLayout: 'fixed',
  dockSide: 'bottom',
});
```

Every option, with defaults and worked examples, is in
[CONFIGURATION.md](CONFIGURATION.md).

Credentials stay in the CLI credential store and never reach browser code. The
agent bridge is disabled when Astro listens beyond loopback — see
[`allowNetworkAgent`](CONFIGURATION.md#allownetworkagent).

## Examples

[`examples/`](examples) holds seven Astro apps wired to this repository rather
than to npm: [`basic`](examples/basic) is the broadest tour, one app per island
framework, and [`with-dom-stamp`](examples/with-dom-stamp) for content that
arrives from a fetch rather than from the template.

```sh
npm install
cd examples/basic && npm install && npm run dev
```

See the [examples index](examples/README.md) for what each covers.

## License

MIT
