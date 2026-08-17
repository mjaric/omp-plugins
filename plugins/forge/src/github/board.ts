/**
 * Projects v2 board operations — all GraphQL lives here.
 *
 * The board is a GitHub Projects v2 with a "Status" single-select field
 * (and optionally a "Slice" single-select). Forge reads the board state
 * and moves cards between status options.
 */

import type { ForgeGitHubClient } from "./client";
import { assertBoardOwnership, type OwnerNode } from "./projects";
import type { SingleProjectConfig, StatusOptions } from "../config/forge-toml";

export interface BoardItem {
	issueNumber: number;
	title: string;
	state: "OPEN" | "CLOSED";
	status: string;
	slice: string | null;
	milestone: string | null;
}

export interface BoardState {
	items: BoardItem[];
}

/** Map forge status names to their option IDs from config. */
function statusNameToId(options: StatusOptions, status: string): string {
	const map: Record<string, string> = {
		backlog: options.backlog,
		ready: options.ready,
		"in_progress": options.inProgress,
		"in review": options.inReview,
		"in_review": options.inReview,
		"in progress": options.inProgress,
		done: options.done,
	};
	const normalized = status.toLowerCase().replace("-", " ");
	return map[normalized] ?? status;
}

/** GraphQL fragment for project items — reused by query and item lookup. */
const ITEMS_FRAGMENT = `
items(first: 100) {
  nodes {
    id
    content {
      ... on Issue {
        number
        title
        state
        milestone { title }
      }
    }
    fieldValues(first: 30) {
      nodes {
        ... on ProjectV2ItemFieldSingleSelectValue {
          name
          field { ... on ProjectV2SingleSelectField { name } }
        }
      }
    }
  }
}`;

interface ProjectNode {
	owner: OwnerNode | null;
	items: {
		nodes: Array<{
			id: string;
			content: {
				number: number;
				title: string;
				state: "OPEN" | "CLOSED";
				milestone: { title: string } | null;
			} | null;
			fieldValues: {
				nodes: Array<{
					name?: string;
					field?: { name?: string };
				}>;
			};
		}>;
	};
}

/** Extract status and slice from field value nodes. */
function extractFields(
	nodes: Array<{ name?: string; field?: { name?: string } }>,
): { status: string; slice: string | null } {
	let status = "(none)";
	let slice: string | null = null;
	for (const node of nodes) {
		if (node.field?.name === "Status" && node.name !== undefined) {
			status = node.name;
		}
		if (node.field?.name === "Slice" && node.name !== undefined) {
			slice = node.name;
		}
	}
	return { status, slice };
}

/** Parse a raw project node into a BoardState. */
function parseProjectNode(node: ProjectNode): BoardState {
	const items: BoardItem[] = [];
	for (const raw of node.items.nodes) {
		if (raw.content === null) {
			continue; // draft issues or non-issue content
		}
		const { status, slice } = extractFields(raw.fieldValues.nodes);
		items.push({
			issueNumber: raw.content.number,
			title: raw.content.title,
			state: raw.content.state,
			status,
			slice,
			milestone: raw.content.milestone?.title ?? null,
		});
	}
	return { items };
}

/** Read the full board state from GitHub. */
export async function getBoardState(
	client: ForgeGitHubClient,
	config: SingleProjectConfig,
): Promise<BoardState> {
	const query = `
		query($projectId: ID!) {
			node(id: $projectId) {
				... on ProjectV2 {
					owner {
						__typename
						... on User { login }
						... on Organization { login }
					}
					${ITEMS_FRAGMENT}
				}
			}
		}`;
	const result = await client.graphql<{ node: ProjectNode | null }>(query, {
		projectId: config.projectId,
	});

	assertBoardOwnership(config, result.node?.owner);
	return parseProjectNode(result.node as ProjectNode);
}

/** Status single-select field discovered on a project board. */
export interface StatusFieldInfo {
	fieldId: string;
	options: Array<{ id: string; name: string }>;
}

/** GraphQL query for the Status field of a project board. */
const FIELDS_QUERY = `
	query($id: ID!) {
		node(id: $id) {
			... on ProjectV2 {
				fields(first: 50) {
					nodes {
						... on ProjectV2FieldCommon { id name }
						... on ProjectV2SingleSelectField { options { id name } }
					}
				}
			}
		}
	}`;

/**
 * Find the "Status" single-select field on a Projects v2 board.
 *
 * Non-single-select fields come back without `options` (and, under a
 * SingleSelectField-only fragment, without id/name at all), so nodes with
 * a missing name or options are skipped. Returns `null` when the board is
 * unreachable or has no Status field.
 */
export async function fetchStatusField(
	client: ForgeGitHubClient,
	projectId: string,
): Promise<StatusFieldInfo | null> {
	const result = await client.graphql<{
		node: {
			fields: {
				nodes: Array<{
					id?: string;
					name?: string;
					options?: Array<{ id: string; name: string }>;
				}>;
			};
		} | null;
	}>(FIELDS_QUERY, { id: projectId });

	if (result.node === null) return null;

	for (const field of result.node.fields.nodes) {
		if (
			field.id !== undefined &&
			field.name?.toLowerCase() === "status" &&
			field.options !== undefined
		) {
			return { fieldId: field.id, options: field.options };
		}
	}
	return null;
}

/** Find the project item id for a given issue number. */
async function findItemId(
	client: ForgeGitHubClient,
	config: SingleProjectConfig,
	issueNumber: number,
): Promise<string> {
	const query = `
		query($projectId: ID!) {
			node(id: $projectId) {
				... on ProjectV2 {
					owner {
						__typename
						... on User { login }
						... on Organization { login }
					}
					items(first: 100) {
						nodes {
							id
							content { ... on Issue { number } }
						}
					}
				}
			}
		}`;

	const result = await client.graphql<{
		node: {
			owner: OwnerNode | null;
			items: {
				nodes: Array<{
					id: string;
					content: { number: number } | null;
				}>;
			};
		} | null;
	}>(query, { projectId: config.projectId });

	assertBoardOwnership(config, result.node?.owner);

	for (const item of result.node?.items.nodes ?? []) {
		if (item.content?.number === issueNumber) {
			return item.id;
		}
	}

	throw new Error(`issue #${issueNumber} not found on board`);
}

/** Move a card to a new status. `status` is a forge name (e.g. "ready", "done"). */
export async function moveCard(
	client: ForgeGitHubClient,
	config: SingleProjectConfig,
	issueNumber: number,
	status: string,
): Promise<void> {
	const itemId = await findItemId(client, config, issueNumber);
	const optionId = statusNameToId(config.statusOptions, status);

	const mutation = `
		mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
			updateProjectV2ItemFieldValue(input: {
				projectId: $projectId, itemId: $itemId,
				fieldId: $fieldId, value: $value
			}) { projectV2Item { id } }
		}`;

	await client.graphql(mutation, {
		projectId: config.projectId,
		itemId,
		fieldId: config.statusFieldId,
		value: { singleSelectOptionId: optionId },
	});
}

/** Add an issue to the board (if not already present). Returns the item id. */
export async function addIssueToBoard(
	client: ForgeGitHubClient,
	config: SingleProjectConfig,
	issueNodeId: string,
): Promise<string> {
	const mutation = `
		mutation($projectId: ID!, $contentId: ID!) {
			addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
				item { id }
			}
		}`;

	const result = await client.graphql<{
		addProjectV2ItemById: { item: { id: string } };
	}>(mutation, { projectId: config.projectId, contentId: issueNodeId });

	return result.addProjectV2ItemById.item.id;
}
