import { resolve } from 'node:path';

import type { Plugin } from 'vite';

/**
 * Adds directories to the dev server's file-serving allow list without
 * replacing Vite's default.
 *
 * Vite allows the workspace root only while no config sets `server.fs.allow`;
 * the first entry anyone writes there drops it. In a pnpm monorepo the
 * dependencies live in the workspace's `node_modules/.pnpm`, above the Astro
 * root, so setting the option ourselves gets every renderer's client script
 * (`@astrojs/react/dist/client.js` and the like) refused with a 403. Appending
 * to the list Vite has already built keeps its default and adds ours.
 */
export function allowServingPlugin(name: string, dirs: () => string[]): Plugin {
  return {
    name,
    apply: 'serve',
    configResolved(config) {
      const allow = config.server.fs.allow;
      for (const dir of dirs()) {
        // Vite stores the entries resolved against the root, with forward
        // slashes, and compares request paths against them as strings.
        const entry = resolve(config.root, dir).replace(/\\/g, '/');
        if (!allow.includes(entry)) allow.push(entry);
      }
    },
  };
}
