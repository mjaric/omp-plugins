import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import { resolveGhToken } from "./auth";

/**
 * Shared GitHub client: one Octokit REST + GraphQL instance per session.
 * Created lazily from resolved auth; cached in module scope.
 */

export interface ForgeGitHubClient {
	rest: Octokit["rest"];
	graphql: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;
}

let cachedClient: ForgeGitHubClient | null = null;

/** Create or return the shared GitHub client. Returns null if unauthenticated. */
export function getGitHubClient(): ForgeGitHubClient | null {
	if (cachedClient !== null) {
		return cachedClient;
	}

	const auth = resolveGhToken();
	if (auth === null) {
		return null;
	}

	const octokit = new Octokit({ auth: auth.token });
	const graphQLWithAuth = graphql.defaults({
		headers: { authorization: `token ${auth.token}` },
	});

	cachedClient = {
		rest: octokit.rest,
		// Wrap graphql to accept our simpler signature
		graphql: <T>(query: string, variables?: Record<string, unknown>): Promise<T> =>
			graphQLWithAuth<T>(query, variables),
	};

	return cachedClient;
}

/** Reset the cached client (for tests). */
export function resetGitHubClient(): void {
	cachedClient = null;
}
