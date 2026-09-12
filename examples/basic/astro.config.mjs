// @ts-check
import { defineConfig } from 'astro/config';
import buildWithAI from '@sudodevstudio/astro-ai';

export default defineConfig({
  integrations: [
    buildWithAI({
      // Drop this line, or set it to 'claude', if the CLI is not installed.
      // Everything except the chat still works without an agent.
      agent: 'codex',

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
      ],
    }),
  ],
});
