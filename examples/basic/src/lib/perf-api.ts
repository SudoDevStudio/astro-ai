/**
 * The kind of shared fetch helper most codebases grow. Every call through it
 * still lands on the component that made it, because the Perf panel attributes
 * a fetch to whichever frontmatter was running, not to this file.
 *
 * Failures come back as `undefined` rather than throwing: `/perf/` fetches a
 * missing endpoint on purpose, and a static build has no dev server to reach.
 */
export async function getJson<T>(path: string, origin: URL): Promise<T | undefined> {
	try {
		const response = await fetch(new URL(path, origin));
		if (!response.ok) return undefined;
		return (await response.json()) as T;
	} catch {
		return undefined;
	}
}
