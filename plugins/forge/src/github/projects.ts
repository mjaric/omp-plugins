/**
 * Ownership-aware Projects v2 discovery.
 *
 * A repo's board must be owned by the same account that owns the repo —
 * org repos use org boards, personal repos use the owner's personal boards.
 * `discoverProjectsForRepo` powers `/forge setup`; `assertBoardOwnership`
 * guards every board read and mutation against config drift.
 */

import type { SingleProjectConfig } from "../config/forge-toml";
import type { ForgeGitHubClient } from "./client";

/** Which kind of GitHub account owns a repo or board. */
export type OwnerKind = "user" | "org";

/** Resolved owner of a repo or board. */
export interface ProjectOwnership {
	login: string;
	kind: OwnerKind;
}

/** A Projects v2 board offered by `/forge setup`. */
export interface DiscoveredProject {
	id: string;
	title: string;
	/** True when the board is linked to the repo being set up. */
	linked: boolean;
}

/** Raw GraphQL owner node (`__typename` is "User" or "Organization"). */
export type OwnerNode = { __typename: string; login?: string };

/** Inline fragment selecting the owner login from User or Organization. */
const OWNER_FIELDS = `
	owner {
		__typename
		... on User { login }
		... on Organization { login }
	}
`;

/** Parse a raw owner node; null when absent or malformed. */
export function parseOwner(raw: OwnerNode | null | undefined): ProjectOwnership | null {
	if (raw?.login === undefined || raw.login.length === 0) return null;
	return { login: raw.login, kind: raw.__typename === "Organization" ? "org" : "user" };
}

/** True when the board owner matches the configured repo owner (case-insensitive). */
export function ownershipMatches(repo: string, ownerLogin: string): boolean {
	const slash = repo.indexOf("/");
	const repoOwner = (slash === -1 ? repo : repo.slice(0, slash)).toLowerCase();
	return repoOwner === ownerLogin.toLowerCase();
}

/**
 * Throw when the board owner does not match the repo owner in config.
 *
 * Called on every board read and mutation path, so a stale or hand-edited
 * `.forge.toml` can never mix org and personal interference.
 */
export function assertBoardOwnership(
	config: SingleProjectConfig,
	rawOwner: OwnerNode | null | undefined,
): void {
	const owner = parseOwner(rawOwner);
	if (owner === null) {
		throw new Error(
			`board ${config.projectId} not reachable — check project_id or token access.`,
		);
	}
	if (!ownershipMatches(config.repo, owner.login)) {
		throw new Error(
			`board ownership mismatch: project is owned by "${owner.login}" but ` +
				`.forge.toml repo is "${config.repo}". A repo must use a board ` +
				`owned by the same account or org — re-run /forge setup.`,
		);
	}
}

interface ProjectSummaryNode {
	id: string;
	title: string;
}

interface OwnerWithProjects extends OwnerNode {
	projectsV2?: { nodes: ProjectSummaryNode[] | null } | null;
}

interface DiscoveryResponse {
	repository: {
		name: string;
		owner: OwnerWithProjects | null;
		projectsV2: { nodes: ProjectSummaryNode[] | null } | null;
	} | null;
}

/**
 * Discover the boards a repo may use: those owned by the repo's owner,
 * linked-to-repo boards first. One round trip — the owner's project list is
 * selected through inline fragments on User and Organization, so the query
 * works for personal and org-owned repos alike. `repo` is the canonical
 * `owner/name` as GitHub reports it.
 */
export async function discoverProjectsForRepo(
	client: ForgeGitHubClient,
	owner: string,
	name: string,
): Promise<{
	ownership: ProjectOwnership | null;
	repo: string | null;
	projects: DiscoveredProject[];
}> {
	const query = `
		query($owner: String!, $name: String!) {
			repository(owner: $owner, name: $name) {
				name
				owner {
					__typename
					... on User {
						login
						projectsV2(first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { id title } }
					}
					... on Organization {
						login
						projectsV2(first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { id title } }
					}
				}
				projectsV2(first: 100) { nodes { id title } }
			}
		}`;

	const result = await client.graphql<DiscoveryResponse>(query, { owner, name });

	if (result.repository === null) {
		return { ownership: null, repo: null, projects: [] };
	}
	const ownership = parseOwner(result.repository.owner);
	const canonicalRepo = ownership !== null
		? `${ownership.login}/${result.repository.name}`
		: null;
	const ownerProjects = result.repository.owner?.projectsV2?.nodes ?? [];
	const linkedIds = new Set(
		(result.repository.projectsV2?.nodes ?? []).map((p) => p.id),
	);
	const projects = ownerProjects.map((p) => ({
		id: p.id,
		title: p.title,
		linked: linkedIds.has(p.id),
	}));
	projects.sort((a, b) => Number(b.linked) - Number(a.linked));

	return { ownership, repo: canonicalRepo, projects };
}

/** Fetch the owner of a Projects v2 board by node id (null when unreachable). */
export async function fetchProjectOwner(
	client: ForgeGitHubClient,
	projectId: string,
): Promise<ProjectOwnership | null> {
	const query = `
		query($projectId: ID!) {
			node(id: $projectId) {
				... on ProjectV2 { ${OWNER_FIELDS} }
			}
		}`;

	const result = await client.graphql<{ node: { owner: OwnerNode | null } | null }>(
		query,
		{ projectId },
	);
	return parseOwner(result.node?.owner ?? null);
}
