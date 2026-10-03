import type { APIRoute } from 'astro';

import { catalogue } from '../../lib/catalog.ts';

/** The endpoint the page fetches, so there is a real response to stamp. */
export const GET: APIRoute = () => Response.json(catalogue());
