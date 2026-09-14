// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import buildWithAI from '@sudodevstudio/astro-ai';

export default defineConfig({
  integrations: [
    react(),
    buildWithAI({
      // Drop this line, or set it to 'claude', if the CLI is not installed.
      // Everything except the chat still works without an agent.
      agent: 'codex',

      // Open docked in a column on the right, with tabs across the
      // conversations, rather than as windows floating over the page. This is
      // the starting point only: the Dock and Float buttons switch layouts, and
      // the toolbar remembers that choice for the rest of the session.
      chatLayout: 'fixed',

      // No `seo` option here on purpose. The share preview reads the head of
      // whatever page you are on, so it needs nothing declared. The only
      // setting, `seo: { networks: [...] }`, narrows which cards are drawn —
      // and this example wants all eight.

      // Two sources with deliberately different shapes. `data-entry-id`
      // resolves to an entry URL because `entryUrl` is configured; `sku` has no
      // entry address, so selecting it hands back the id itself.
      contentSources: [
        {
          name: 'demo-cms',
          attribute: 'data-entry-id',
          entryUrl: 'https://cms.example/entries/{id}',
          docs: 'https://cms.example/docs/content-model',
        },
        {
          name: 'catalog',
          attribute: 'data-sku',
        },
      ],

      visualComponents: [
        {
          name: 'Callout',
          layout: 'flow',
          props: {
            tone: { control: 'enum', values: ['neutral', 'accent'] },
            title: { control: 'text' },
          },
        },
        {
          name: 'StatTile',
          layout: 'grid',
          props: {
            label: { control: 'text' },
            value: { control: 'text' },
            tone: { control: 'enum', values: ['neutral', 'good', 'warning'] },
          },
        },

        // A React island registers the same way an Astro component does. The
        // props are declared where the island is *used*, in the Astro page, so
        // the action bar can edit them without parsing the framework's own
        // prop types.
        {
          name: 'ProductPicker',
          layout: 'flow',
          props: {
            heading: { control: 'text' },
            cta: { control: 'text' },
            tone: { control: 'enum', values: ['neutral', 'accent'] },
          },
        },
        {
          name: 'BuildStatus',
          layout: 'flow',
          props: {
            label: { control: 'text' },
          },
        },
      ],
    }),
  ],
});
