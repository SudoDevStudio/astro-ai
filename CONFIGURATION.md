# Configuration

Every option passed to `buildWithAI()` in `astro.config.mjs`. The integration is
development-only: it does nothing during `astro build`, and no editor runtime or
metadata reaches a production bundle.

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

## Options at a glance

| Option | Type | Default |
| --- | --- | --- |
| `agent` | `'codex' \| 'claude' \| object \| false` | none |
| `contentSources` | `ContentSource[]` | `[]` |
| `visualComponents` | `VisualComponent[]` | `[]` |
| `skills` | `string[]` | `[]` |
| `excludeDirectories` | `string[]` | see below |
| `maxRecoveryFiles` | `number` | `20` |
| `allowNetworkAgent` | `boolean` | `false` |

Nothing is required. `buildWithAI()` with no arguments gives you selection,
inspection, literal text and prop editing, reordering, insertion, removal, undo
and redo. Only the chat needs an agent.

## `agent`

Which CLI answers questions and writes code. Authenticate it before starting
Astro: `codex login`, or launch `claude` and complete its login flow.

```js
// Shorthand.
buildWithAI({ agent: 'codex' });

// Full form.
buildWithAI({
  agent: {
    provider: 'claude',
    model: 'your-model',
    command: '/custom/path/to/claude',
    agentTimeoutMs: 300_000,
    diagnosticsTimeoutMs: 120_000,
  },
});

// Deterministic editing only, no chat. Both of these do the same thing.
buildWithAI({ agent: false });
buildWithAI({});
```

| Field | Meaning | Default |
| --- | --- | --- |
| `provider` | `'codex'` or `'claude'` | required |
| `command` | Path to the executable when it is not on `PATH` | the provider name |
| `model` | Model passed through to the CLI | the CLI's own default |
| `agentTimeoutMs` | Ceiling for one agent run | `300_000` (5 minutes) |
| `diagnosticsTimeoutMs` | Ceiling for the diagnostics run afterwards | `120_000` (2 minutes) |

A misconfigured agent is reported in the terminal and the chat says it is
unavailable. The rest of the editor keeps working.

## `contentSources`

Maps rendered DOM back to the system that owns the words. Declare the attribute
your CMS client already renders, and selecting an element resolves the entry
behind it.

```js
buildWithAI({
  contentSources: [
    {
      name: 'contentful',
      attribute: 'data-entry-id',
      entryUrl: 'https://app.contentful.com/spaces/SPACE/entries/{id}',
      docs: 'https://www.contentful.com/developers/docs/',
      mcp: 'contentful',
      instructions: 'Long-form fields are Markdown. Do not paste HTML.',
    },
    // No entryUrl, so this one resolves to the raw id.
    { name: 'catalog', attribute: 'data-sku' },
  ],
});
```

| Field | Meaning |
| --- | --- |
| `name` | Names the source in agent context and on the selection chip |
| `attribute` | DOM attribute holding the entry id |
| `entryUrl` | Entry address template; `{id}` is replaced with the encoded id |
| `docs` | Documentation the agent consults before proposing a content change |
| `mcp` | MCP server already connected to your CLI that can read and write entries |
| `instructions` | Extra guidance appended to the agent's content policy |

Only `name` and `attribute` are required, and at most 12 sources may be
declared. The attribute name is yours to choose; a `data-` prefix is a
convention of CMS clients, not a requirement.

The id is read from the selected element or its nearest ancestor carrying the
attribute, because CMS clients usually mark the wrapper rather than the heading
inside it. Every source whose attribute is present resolves, so one element can
belong to a CMS entry, a product record, and a translation key at once.

An invalid declaration is reported in the terminal and content sources are
skipped; the dev server still starts. `entryUrl` must contain `{id}` and must be
an `http` or `https` URL.

## `visualComponents`

Declares what the editor may change on your own components. Registering a
component narrows prop editing to the props you list, which is how a component
keeps control of its own contract.

```js
buildWithAI({
  visualComponents: [
    {
      name: 'Card',
      layout: 'flow',
      props: {
        title: { control: 'text' },
        count: { control: 'number' },
        featured: { control: 'boolean' },
        tone: { control: 'enum', values: ['neutral', 'accent'] },
        spacing: { control: 'design-token' },
      },
      slots: [
        { name: 'content', accepts: ['p', 'Button'] },
        { name: 'footer', accepts: ['*'] },
      ],
    },
  ],
});
```

| Field | Meaning |
| --- | --- |
| `name` | Component name as written in your templates |
| `props` | Editable props, keyed by prop name |
| `slots` | Named slots and the child types each accepts |
| `layout` | `'flow'`, `'flex'`, `'grid'`, or `'freeform'` |

Controls are `'text'`, `'number'`, `'boolean'`, `'enum'`, or `'design-token'`.
An `enum` uses `values` to render a select instead of a free text field.

Two behaviours are worth knowing. A component you do **not** register exposes
all of its literal props for editing. A component you **do** register exposes
only the props you declared, so listing a component is how you restrict it.
A slot's `accepts` list gates which nodes may be moved into it; `'*'` accepts
anything.

## `skills`

Project-relative convention files included with every agent request, so the
agent follows your house rules.

```js
buildWithAI({ skills: ['AGENTS.md', 'docs/component-conventions.md'] });
```

Paths must be relative to the project root. Absolute paths and `..` segments
are rejected.

## `excludeDirectories`

Extra directories kept out of the isolated workspace the agent sees. The
workspace already honours `.gitignore` and always excludes:

```
.astro  .git  .next  .output  .svelte-kit  .turbo  .vercel
coverage  dist  node_modules  storybook-static  .astro-ai-attachments
```

```js
buildWithAI({ excludeDirectories: ['vendor', 'src/generated', 'fixtures'] });
```

A bare name excludes a directory of that name anywhere in the tree. A path with
a slash excludes only that location and everything under it.

Globs are not supported, and an entry containing `*` matches nothing rather
than raising an error. Use a bare name to reach every copy:

```js
// Excludes packages/ui/snapshots, packages/api/snapshots, and any other.
excludeDirectories: ['snapshots'];

// Excludes only this one.
excludeDirectories: ['packages/ui/snapshots'];
```

Paths must be project-relative. Absolute paths and `..` segments are rejected.

## `maxRecoveryFiles`

How many recovery snapshots to keep for conflict recovery before the oldest are
pruned. Raise it on a large project where you want deeper undo history on disk.

```js
buildWithAI({ maxRecoveryFiles: 50 });
```

## `allowNetworkAgent`

The agent bridge is disabled when Astro listens beyond loopback, because
reaching it would mean anyone on the network could drive a credentialed CLI
against your source. Set this only on a trusted private network.

```js
buildWithAI({ agent: 'codex', allowNetworkAgent: true });
```

Credentials always stay in the CLI's own credential store and are never sent to
browser code.

## Recipes

### A site backed by a headless CMS

```js
buildWithAI({
  agent: 'claude',
  contentSources: [
    {
      name: 'sanity',
      attribute: 'data-sanity-id',
      entryUrl: 'https://my.sanity.studio/desk/__edit__{id}',
      mcp: 'sanity',
    },
  ],
  skills: ['AGENTS.md'],
});
```

The agent is told which text is fetched data, pointed at the entry, and asked to
change the entry or the template rather than hardcoding the words into source.

### A monorepo with generated code

```js
buildWithAI({
  agent: { provider: 'codex', agentTimeoutMs: 600_000 },
  excludeDirectories: ['generated', 'apps/web/public/vendor', 'fixtures'],
  skills: ['AGENTS.md', 'packages/ui/CONVENTIONS.md'],
  maxRecoveryFiles: 50,
});
```

A longer timeout suits a large workspace, where mirroring and reading take
longer before any edit begins.

### A design system with locked-down props

```js
buildWithAI({
  visualComponents: [
    { name: 'Button', props: { variant: { control: 'enum', values: ['primary', 'ghost'] } } },
    { name: 'Stack', layout: 'flex', slots: [{ name: 'default', accepts: ['*'] }] },
  ],
});
```

No agent, so nothing calls out to a CLI. `Button` exposes only `variant`, so no
one can retype a class name or a size through the editor.

### A shared or remote dev machine

```js
buildWithAI({ agent: false });
```

Editing still works. Nothing can reach a credentialed CLI, which is the safe
default when the dev server is not only yours.
