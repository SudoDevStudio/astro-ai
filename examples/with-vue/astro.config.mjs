// @ts-check
import { defineConfig } from 'astro/config';
import vue from '@astrojs/vue';
import buildWithAI from '@sudodevstudio/astro-ai';

export default defineConfig({
  integrations: [
    vue(),
    buildWithAI({
      // Drop this line if the CLI is not installed. Everything except the chat
      // works without an agent.
      agent: 'codex',
    }),
  ],
});
