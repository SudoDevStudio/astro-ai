# astro-ai

`astro-ai` is a development-only, source-aware visual editing integration for
Astro and React islands. Astro, JavaScript/JSX, and TypeScript/TSX files remain
the only source of truth and Vite HMR remains the only renderer.

## Execution paths

- `VisualCapabilityResolver` exposes controls only when source analysis proves
  that a deterministic edit is safe.
- `VisualCommandEngine` edits original `.astro`, `.js`/`.jsx`, and `.ts`/`.tsx`
  source through reversible patch transactions. It never calls an AI provider.
- `AstroResolver` maps deterministic development node IDs to source ranges,
  local component ancestry, literal props, content provenance, and repeat
  context.
- `AgentFallback` is a separate server-only boundary for rejected operations.
  It runs the configured Codex or Claude CLI only for work that cannot be
  completed by deterministic source transformations.

## Configuration

```js
import { defineConfig } from 'astro/config';
import buildWithAI from 'astro-ai';

export default defineConfig({
  integrations: [
    buildWithAI({
      agent: 'codex',
      excludeDirectories: [
        'vendor',
        'src/generated',
        'public/uploads',
      ],
      skills: ['AGENTS.md', 'docs/frontend-conventions.md'],
      visualComponents: [
        {
          name: 'Card',
          layout: 'flow',
          props: {
            title: { control: 'text' },
            tone: { control: 'enum', values: ['neutral', 'accent'] },
          },
        },
      ],
    }),
  ],
});
```

`excludeDirectories` extends the built-in isolated-workspace exclusions. A
single directory name such as `vendor` is excluded wherever it occurs; a path
such as `src/generated` is relative to the Astro project root. Absolute paths
and parent traversal are rejected.

The agent workspace also honors the project's `.gitignore`, excludes common
framework/build output and log files, and enforces file-count, per-file, and
total-size limits. `skills` contains project-relative convention files that are
attached to agent prompts. Invalid paths are reported by Astro's integration
logger without crashing the development server.

### CLI agent authentication

AI operations use an authenticated local CLI process on the Astro development
server. Credentials stay in the CLI's own credential store and are never sent
to the toolbar browser code.

Toolbar conversations are not mirrored into provider chat applications. The
integration launches isolated non-interactive CLI runs, and Codex currently
uses `--ephemeral`, which deliberately avoids writing provider session files.
The visible transcript is stored in the browser tab's `sessionStorage`.

For Codex:

```sh
codex login
codex login status
```

```js
buildWithAI({ agent: 'codex' })
```

For Claude:

```sh
claude
```

Complete the authentication choice shown on first launch, then exit the
interactive session. The integration checks the CLI authentication state when
the Astro development server connects.

```js
buildWithAI({ agent: 'claude' })
```

An optional provider object can select a custom executable or model:

```js
buildWithAI({
  agent: {
    provider: 'codex',
    command: '/opt/homebrew/bin/codex',
    model: 'your-configured-model',
  },
})
```

The toolbar caches installation/authentication checks briefly. Agent runs use
an isolated, incrementally synchronized temporary workspace that links the
project's existing `node_modules` for type-checking without copying it. The resulting source
changes are reviewed and applied to the live project as one reversible
multi-file patch transaction. Provider tool progress is streamed into the
toolbar, recent turns are supplied to follow-up requests, and configured
`check`, `typecheck`, or `test:types` scripts run before changes are applied.
The integration does not use dangerous CLI sandbox-bypass flags and passes an
allowlisted child-process environment rather than the dev server's complete
environment.

The credentialed agent bridge is disabled when Astro listens beyond loopback
(for example, `--host 0.0.0.0`). On a trusted private network it can be enabled
explicitly with `allowNetworkAgent: true`; never expose that mode to an
untrusted LAN or the public internet.

Registered Astro components can forward development selection metadata by
spreading unconsumed props onto their source-backed root element. Native DOM
elements authored inside React JSX/TSX are instrumented directly; custom React
component calls are not assumed to forward arbitrary attributes. No metadata
is added during production builds.

## Current vertical slice

- Opening Build with AI immediately opens the agent workspace and activates
  source-backed element selection. Closing the workspace exits Build with AI.
- Collapse the agent workspace into a compact header and expand it without
  losing chat, selection context, or an active run.
- The collapsed state is a 56px sparkle launcher with a connection-status dot.
- Keep the workspace as a draggable floating window and connect it to the
  active element with a source-selection arrow. Its viewport-constrained
  position is restored for the current browser-tab session. Page, selection,
  error, and audit contexts use distinct window treatments so an unattached
  prompt is immediately visible.
- Display capability-gated Edit, Props, Move, Ask AI, and Source controls beside
  the selected element (`Shift` + right-click keeps the browser menu).
- Shift-click source-backed elements to add or remove them from a selection, or
  drag a marquee across the page to select up to 50 leaf-most source nodes.
  Multiple selections expose Ask AI and Clear; deterministic Edit, Props, and
  Move controls remain single-node-only until a bulk transform is proven safe.
- Display project-relative source location, component ancestry, content
  provenance, repeat context, and proven-safe capabilities.
- Open a source location through Vite's local editor endpoint.
- Edit literal text.
- Reorder adjacent sibling AST nodes when only whitespace separates them.
- Edit type-compatible literal component props and enforce registered enum or
  token values.
- Undo and redo each source transaction.
- Persist bounded undo/redo history under `.astro/astro-ai`, retain recoverable
  diffs for conflicts, and show a human-readable diff for agent changes.
- Use Undo and Redo from the agent workspace header rather than a second
  floating status panel.
- Render edits through normal Vite HMR.
- Select source nodes by keyboard with Tab and Enter/Space while selection mode
  is active.
- Automatically attach the active source selection to chat while allowing an
  explicit page-level prompt when nothing is selected.
- Offer a development-only **Fix with AI** action for Vite error overlays and
  Astro audit findings. The action opens chat with the diagnostic's file, line,
  and message attached; the audit bridge is feature-detected against Astro's
  open development-toolbar UI and safely does nothing when it is unavailable.
- Open a persistent, collapsible and resizable AI window with immutable
  selection or diagnostic attachments. `AgentFallback`
  supports authenticated Codex and Claude CLI providers, and deterministic
  operations never enter that path.
- Informational agent requests may complete with a rendered text response and
  no source transaction. Change requests return the CLI's final explanation
  alongside the undoable file transaction.
- Enable the provider-neutral **Answer only** composer control to guarantee that
  generated file edits are discarded. Completed answers identify the adapter
  that produced them, such as Codex or Claude.

The toolbar stores at most 20 displayed run summaries, their prompts and
attachments, window position, open/collapsed state, and current context in the
browser tab's `sessionStorage` under `astro-ai:*` keys. It does not create a
chat database or repository file. Each CLI run is currently independent and
receives the current prompt and attachment, not the preceding transcript.

Dynamic local variables, React/Astro prop expressions, API/CMS values, and
generated content do not receive literal-text controls. Literal React content,
literal attributes/props, and compatible JSX siblings use the deterministic
engine. Third-party component internals remain opaque unless their source is
part of the project. Deeper prop tracing, compatible slot moves, and layout
controls are subsequent slices.
