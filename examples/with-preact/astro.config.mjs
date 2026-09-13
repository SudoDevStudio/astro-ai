// @ts-check
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import buildWithAI from '@sudodevstudio/astro-ai';

export default defineConfig({
  integrations: [
    preact(),
    buildWithAI({
      // Drop this line if the CLI is not installed. Everything except the chat
      // works without an agent.
      agent: 'codex',
    }),
  ],
});
