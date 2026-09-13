// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import buildWithAI from '@sudodevstudio/astro-ai';

export default defineConfig({
  integrations: [
    react(),
    buildWithAI({
      // Drop this line if the CLI is not installed. Everything except the chat
      // works without an agent.
      agent: 'codex',
    }),
  ],
});
