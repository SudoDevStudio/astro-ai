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
        const file = sourceFileFromId(id);
        if (file === undefined || !resolver.ownsFile(file)) {
          return null;
        }
        return resolver.instrumentFile(file, source);
      },
    },
    configureServer(server) {
      server.watcher.on('unlink', (file) => {
        if (isSupportedSourceId(file) && resolver.ownsFile(file)) resolver.removeFile(file);
      });
    },
  };
}

export function sourceFileFromId(id: string): string | undefined {
  const [file, query = ''] = id.split('?', 2);
  if (file === undefined || file.split(/[\\/]/).includes('node_modules')) return undefined;
  if (!/\.(?:astro|jsx?|tsx?)$/.test(file)) return undefined;
  if (file.endsWith('.astro') && query !== '') return undefined;
  if (query !== '' && /(?:^|&)(?:astro|type|lang)\b/.test(query)) return undefined;
  return file;
}

function isSupportedSourceId(id: string): boolean {
  return sourceFileFromId(id) !== undefined;
}
