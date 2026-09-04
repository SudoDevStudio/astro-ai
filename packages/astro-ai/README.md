# @sudodevstudio/astro-ai

Development-only visual editing for Astro, with optional Codex or Claude CLI
support. Source files stay authoritative and all changes render through Vite
HMR. No editor runtime or metadata is included in production builds.

## Install

```sh
npm install --save-dev @sudodevstudio/astro-ai
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

Toolbar history is stored in the browser tab's `sessionStorage`; it is not
mirrored into Codex or Claude chat applications. Credentials remain in the CLI
credential store and are never sent to browser code.

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

## License

MIT © 2026 Maninderpreet Singh. Free to use, modify, and redistribute when the
copyright and license notice are retained. Provided as-is, without warranty.
See [LICENSE](./LICENSE).
