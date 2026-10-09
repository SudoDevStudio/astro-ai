import type { APIRoute, GetStaticPaths } from 'astro';

/**
 * Stand-in upstream APIs for `/perf/`, each with its own latency, so the Perf
 * panel has a slow call, a fast call, and everything between to rank.
 *
 * The delay only applies in dev, where the panel runs; a static build writes
 * these files out without waiting. A name missing from `getStaticPaths`
 * answers 404, which is how `/perf/` gets a failing fetch to show.
 */
const RESPONSES = {
	inventory: { delayMs: 450, body: { inStock: 1284, warehouses: 3 } },
	prices: { delayMs: 260, body: { currency: 'USD', from: '4.80' } },
	reviews: { delayMs: 120, body: { rating: 4.4, count: 312 } },
	categories: { delayMs: 25, body: ['Fasteners', 'Hand tools', 'Safety'] },
} as const;

type Name = keyof typeof RESPONSES;

export const getStaticPaths = (() =>
	Object.keys(RESPONSES).map((name) => ({ params: { name } }))) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ params }) => {
	const response = RESPONSES[params.name as Name];
	if (import.meta.env.DEV) await new Promise((resolve) => setTimeout(resolve, response.delayMs));
	return new Response(JSON.stringify(response.body), {
		headers: { 'content-type': 'application/json' },
	});
};
