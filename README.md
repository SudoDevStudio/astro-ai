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
- Works with native Astro templates and React, Preact, and Solid islands.
  Vue and Svelte single-file components are not supported yet.
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
- Preview the current route as a shared link on X, Facebook, LinkedIn,
  Instagram, Discord, Slack, WhatsApp, and Google, with an audit of what will
  be wrong and **Fix with AI** on each finding.
- Read the page's JSON-LD as rendered entities, see the rich result it produces,
  and be told what each missing property costs.
- See what an answer engine can take from the page — its subject, quotable
  facts, Q&A pairs, provenance, and how much text survives without JavaScript.
- Float the chat windows over the page or dock them to a side column with tabs.

## Share preview

The green **SEO** button on a chat window's toolbar opens a full-screen reading
of the current route's head metadata.

**Previews** renders one card per network. Each reads the tag chain that network
actually reads — X prefers `twitter:*` and falls back to `og:*`, Google ignores
both and reads `<title>` — and truncates where that network truncates, so a
title that fits on LinkedIn can be visibly cut on Google. Instagram appears as a
direct message link card, because Instagram has no feed link previews.

**Issues** reports what a reader will see go wrong, not a checklist score: a
relative `og:image` no crawler can fetch, an image that loads at 64px despite
declaring 1200×630, an `og:url` that disagrees with the canonical link. Each
finding names the networks it affects, and **Fix with AI** sends it to the agent
with the current tag values.

**Schema** draws the page's JSON-LD as the things it describes — a Product with
its price and stars, an Article with its byline and date, a breadcrumb trail as a
trail — rather than as braces to read. A type with no shape of its own falls back
to labelled fields instead of being guessed at, and the raw JSON stays one click
away. It reads the page's JSON-LD. Structured data is the half of SEO meta
tags cannot express — it is what turns a blue link into a result with
breadcrumbs, stars, a price, or expandable questions — and the half that fails
silently, since a missing `offers.price` costs the price and says nothing. The
Google card renders what the schema actually produces, and the findings say what
each gap costs: an unparseable block, a `Product` with no price or rating, a
`BreadcrumbList` crumb with no name, a `FAQPage` question with no answer, a
headline past the length Google reads, or a schema that describes a different
page than the one it sits on.

**AEO** is the other half. Search shows your page; an answer engine reads it,
states what it says, and cites you if it can. Those are different jobs, and a
page can be excellent at the first and useless at the second. The tab shows what
an engine has to work with: the subject it can name, the facts it can lift
verbatim (marked by whether they came from structured data or from a meta tag),
the question and answer pairs it can quote, the provenance that makes a citation
possible, and how much of the text exists *before* JavaScript runs — the page is
fetched again as served, because most answer engines are not browsers.

Alongside it is the answer the page affords, assembled from those extracted
values by a template. It is not a model's output and says so: every clause is
something the page states, so a thin sentence there means a thin page.

**Tags** lists every title, meta, link, and `lang` value the page rendered,
including duplicates that crawlers ignore.

The sheet reads the live page, so **Re-read page** after an edit shows the
result once Vite has applied it.

It needs no setup — everything comes from the page's own head. The one setting
narrows it to the networks you ship to:

```js
buildWithAI({
  seo: { networks: ['x', 'linkedin', 'google', 'slack'] },
});
```

`seo: false` hides the button. See [CONFIGURATION.md](CONFIGURATION.md#seo).

## Chat layout

Chat windows float over the page by default: drag them by the header, resize
from the left edge, collapse one to a badge, and open up to six.

Each conversation owns its own selection. Switching to another window or tab
restores the element that conversation was working on — the outline, the action
bar, and the arrow all move with it — and opening a new chat while something is
selected inherits that selection.

The **Dock** button moves them all into a column on the right instead, where tabs
switch between the same conversations and a tab marks one with a run in flight.
The page reflows into the remaining width rather than sitting behind the panel.
**Float** undocks them again. Switching moves no state, so a run in flight keeps
running, and the choice is remembered for the session.

Set the layout the editor opens in with `chatLayout: 'fixed'`. It applies until
someone switches layouts themselves, after which their choice wins for the rest
of the session.

A root margin reflows normal flow but cannot move your app's own
`position: fixed` elements, which are laid out against the viewport. The dock
publishes its width as `--astro-ai-dock-width` on the root element so you can
offset them yourself:

```css
.my-fixed-header {
  right: var(--astro-ai-dock-width, 0px);
}
```

The variable is only set while the dock holds a column. Below 720px the dock
becomes a bottom sheet and takes no column at all.

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
  chatLayout: 'fixed', // or 'floating'; the user can switch either way
  seo: { networks: ['x', 'linkedin', 'google', 'slack'] },
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

## Examples

[`examples/`](examples) holds six Astro apps wired to this repository rather
than to npm. [`basic`](examples/basic) is the broadest tour, and there is one
app per framework island: React, Preact, Solid, Vue, and Svelte.

```sh
npm install
cd examples/basic && npm install && npm run dev
```

See the [examples index](examples/README.md) for what each one covers and which
frameworks the editor indexes.

## Demo

https://github.com/user-attachments/assets/b92406dc-c632-496e-9582-7017bea1fa9c

## License

MIT