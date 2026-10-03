import type { Product } from './catalog.ts';

/**
 * A hand-rolled client, the way a house codebase usually has one.
 *
 * The edit build wraps the `.json()` call in here, so every caller is covered
 * without anything being listed in `sources`. This is the whole reason the
 * page fetches rather than importing the catalogue directly: a module import
 * is not a response, and there is nothing in it to mark.
 */
async function get<T>(path: string, origin: URL): Promise<T> {
  const response = await fetch(new URL(path, origin));
  if (!response.ok) throw new Error(`${path} responded ${response.status}`);
  return (await response.json()) as T;
}

export const listProducts = (origin: URL): Promise<Product[]> =>
  get<Product[]>('/api/products.json', origin);
