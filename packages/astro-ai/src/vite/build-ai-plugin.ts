import type { Plugin } from 'vite';

import type { AstroResolver } from '../resolver/astro-resolver.js';

export const BUILD_AI_VITE_PLUGIN_NAME = 'astro-ai:dev' as const;

/**
 * Instruments original Astro and React JSX source before framework compiler
 * transforms. The ordered pre-hook keeps source ranges aligned with the files
 * that deterministic operations edit.
 */
export function buildAIVitePlugin(resolver: AstroResolver): Plugin {
  return {
    name: BUILD_AI_VITE_PLUGIN_NAME,
    apply: 'serve',
    enforce: 'pre',
    transform: {
      order: 'pre',
      handler(source, id) {
        if (!isSupportedSourceId(id) || !resolver.ownsFile(id)) {
          return null;
        }
        return resolver.instrumentFile(id, source);
      },
    },
    configureServer(server) {
      server.watcher.on('unlink', (file) => {
        if (isSupportedSourceId(file) && resolver.ownsFile(file)) resolver.removeFile(file);
      });
    },
  };
}

function isSupportedSourceId(id: string): boolean {
  return (
    !id.includes('?') &&
    !id.split(/[\\/]/).includes('node_modules') &&
    /\.(?:astro|jsx?|tsx?)$/.test(id)
  );
}
