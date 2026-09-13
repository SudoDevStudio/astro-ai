# @sudodevstudio/astro-ai

Development-only visual editing for Astro, with optional Codex or Claude CLI
support. Source files stay authoritative and all changes render through Vite
HMR. No editor runtime or metadata is included in production builds.


## Install

```sh
npm install --save-dev @sudodevstudio/astro-ai
```

Prereleases are published under the `beta` dist-tag:

```sh
npm install --save-dev @sudodevstudio/astro-ai@beta
```

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import buildWithAI from '@sudodevstudio/astro-ai';

export default defineConfig({
  integrations: [
    buildWithAI({
      agent: 'codex', // or 'claude'
    }),
  ],
});
```

Authenticate the selected CLI before starting Astro:

```sh
codex login
# or launch `claude` and complete its login flow
```

## Features

- Select and inspect source-backed Astro, JSX, and TSX elements.
- **Click** a selected element to drive the running app while selection mode
  stays on — open a menu or switch a tab, then edit what it reveals.
- Edit literal text and props without using AI.
- Reorder, remove, insert, and move compatible source nodes.
- Multi-select by Shift-click or drag marquee.
- Undo, redo, conflict recovery, and human-readable diffs.
- Trace a selected element back to the CMS entry that owns its content.
- Ask Codex or Claude for explanations and code changes.
- Attach text, code, or screenshots by picker, drag-and-drop, or clipboard paste.
- Attach Vite errors and Astro audit findings with **Fix with AI**.

## Options

```js
buildWithAI({
  agent: {
    provider: 'codex', // claude
    model: 'your-model',
    // command: '/custom/path/to/codex',
    agentTimeoutMs: 300_000,
    diagnosticsTimeoutMs: 120_000,
  },
  contentSources: [
    {
      name: 'anycms',
      attribute: 'data-entry-id',
      entryUrl: 'https://app.anycms.com/spaces/SPACE/entries/{id}',
      docs: 'https://www.anyanycms.com/developers/docs/',
      mcp: 'anycms',
    },
  ],
  excludeDirectories: ['vendor', 'src/generated'],
  skills: ['AGENTS.md'],
  maxRecoveryFiles: 20,
  visualComponents: [
    {
      name: 'Card',
      layout: 'flow',
      props: {
        tone: { control: 'enum', values: ['neutral', 'accent'] },
      },
      slots: [{ name: 'content', accepts: ['p', 'Button'] }],
    },
  ],
});
```

The isolated agent workspace honors `.gitignore` and the additional
`excludeDirectories`. `skills` are project-relative convention files included
with agent context.

Every option, with defaults and worked examples, is in
[CONFIGURATION.md](CONFIGURATION.md).

Toolbar history is stored in the browser tab's `sessionStorage`; it is not
mirrored into Codex or Claude chat applications. Credentials remain in the CLI
credential store and are never sent to browser code.

### Content sources

A page built from a CMS renders words that no source edit can change. Ask the
agent to shorten a heading and it edits the template, the page looks right, and
the next fetch puts the old text back. `contentSources` closes that gap.

Nothing about the attribute is fixed. You name it in `astro.config.mjs`, and
the editor looks for exactly that name — whatever your CMS client already
renders, `data-` prefixed or not:

```js
contentSources: [
  { name: 'storyblok', attribute: 'data-blok-uid', entryUrl: '…/stories/{id}' },
  { name: 'pim', attribute: 'sku' },
],
```

```html
<section data-blok-uid="uid-991" sku="SKU-77">
  <h2>Pricing that scales</h2>
</section>
```

The id is read off the selected element or its nearest marked ancestor, so
selecting the heading resolves it to both entries. With `entryUrl`
configured you get the entry's address; without one you get the raw id. Either
way the reference reaches the agent, which is told the text is fetched data, is
pointed at the entry, and is instructed to change the entry or the template's
structure rather than hardcoding the words into source.

| Field | Purpose |
| --- | --- |
| `name` | Names the source in agent context and on the selection chip. |
| `attribute` | DOM attribute holding the entry id. |
| `entryUrl` | Entry address template. `{id}` is replaced with the encoded id. |
| `docs` | Documentation the agent consults before proposing a content change. |
| `mcp` | MCP server already connected to your Codex or Claude CLI that can read and write these entries. |
| `instructions` | Extra guidance appended to the agent's content policy. |

Declare as many sources as the page mixes. Each needs its own attribute, and
every source whose attribute is present resolves, so one element can carry a
CMS entry, a product id, and a translation key at once. The selection bar shows
a chip per resolved entry: clicking opens the entry, or copies the id when the
source has no `entryUrl`.

Entry ids exist only in the rendered page, so the browser reads them and the
server resolves them. URLs are always built from your configured template,
never from anything the page supplied, and an id carrying a line break or
control character is dropped rather than passed into the agent prompt. A
`mcp` server is named to the agent, not called by this integration: the agent
uses the connection your CLI already has.

### Multiple chat windows

Use `＋` in a chat header to open another window, and rename a window by
editing its title — for example one for building and one for reviewing. Up to
six windows can be open at once, and they are restored on reload.

Each window is an independent conversation: it keeps its own turn history,
attachments, and isolated provider workspace, so context never leaks between
them. Source history is deliberately shared, because every window edits the
same project — undo and redo act on one stack and stay in sync everywhere.

Runs that can change source are queued so only one applies at a time; a waiting
window shows a `Queued` step. Answer-only runs never commit, so they continue
to run concurrently.

On a client-side navigation with `<ClientRouter />`, the editor re-establishes
itself against the new page: the selection is cleared because its elements no
longer exist, each window drops its stale attachment, insertion zones are
re-requested for the new route, and the windows are restored and re-fitted to
the viewport. Conversations and source history are kept.

Attached contents are sent only with that CLI request and are not stored in
chat history. Up to five attachments are supported. Text files are limited to
256 KB each and screenshots to 5 MB each.

For safety, the agent bridge is disabled when Astro listens beyond loopback.
Only set `allowNetworkAgent: true` on a trusted private network.

## Example

[`examples/basic`](examples/basic) is a small Astro app wired to this
repository rather than to npm, covering selection, editing, reordering, a
registered visual component, and content sources.

```sh
npm install
cd examples/basic && npm install && npm run dev
```

## Demo

https://github.com/user-attachments/assets/b92406dc-c632-496e-9582-7017bea1fa9c

## License

MIT