// @ts-check
import { defineConfig } from 'astro/config';
import solid from '@astrojs/solid-js';
import buildWithAI from '@sudodevstudio/astro-ai';

export default defineConfig({
  integrations: [
    solid(),
    buildWithAI({
      // Drop this line if the CLI is not installed. Everything except the chat
      // works without an agent.
      agent: 'codex',
    }),
  ],
});
