// @ts-check
import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';
import buildWithAI from '@sudodevstudio/astro-ai';

export default defineConfig({
  integrations: [
    svelte(),
    buildWithAI({
      // Drop this line if the CLI is not installed. Everything except the chat
      // works without an agent.
      agent: 'codex',
    }),
  ],
});
