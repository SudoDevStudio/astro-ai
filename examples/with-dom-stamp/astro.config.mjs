// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import buildWithAI from '@sudodevstudio/astro-ai';

// Stamping is decided at build time, so the edit build and the production
// build are separate runs. `npm run dev` sets this; `npm run dev:plain` does
// not, and then nothing is stamped and no marker reaches the page.
const editing = process.env.ASTRO_DOM_STAMP_EDIT === 'true';

export default defineConfig({
  // The page fetches its own API route at request time, which is what gives
  // dom-stamp a `.json()` call to wrap. A static build has nothing to fetch.
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [
    buildWithAI({
      // Drop this line if the CLI is not installed. Everything except the
      // chat works without an agent.
      agent: 'codex',

      // One declaration for both halves. The editor registers dom-stamp with
      // these options and derives the content source from the same object, so
      // `data-stamp-id` and its facets are never written out twice and cannot
      // drift apart.
      domStamp: {
        // `_type` becomes data-stamp-type, `id` becomes data-stamp-id, and
        // `sku` becomes data-stamp-sku.
        read: ['_type', 'id', 'sku'],
        // Also name the field each element renders, as data-stamp-field. This
        // is what turns "this text belongs to product p0" into "this is the
        // title of product p0".
        deepStamps: true,
        enabled: editing,
      },
    }),
  ],
});
