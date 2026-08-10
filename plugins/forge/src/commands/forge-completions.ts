/**
 * Argument autocomplete for the `/forge` slash command.
 *
 * Registered via `getArgumentCompletions` on `pi.registerCommand`; the omp
 * TUI's `CombinedAutocompleteProvider` calls this with the text typed after
 * `/forge ` and renders the returned items in the suggestion popup.
 *
 * Contract: when the popup is open, accepting an item replaces the ENTIRE
 * text after `/forge ` with the item's `value` (pi-tui
 * `CombinedAutocompleteProvider.applyCompletion`). Values for extras must
 * therefore re-embed the subcommand token — same scheme as omp's built-in
 * `/mcp` completion (`enable myserver `) — or the subcommand is wiped.
 */

import type { AutocompleteItem } from "@oh-my-pi/pi-tui";

interface ExtraSpec {
	value: string;
	description: string;
}

interface SubcommandSpec {
	name: string;
	description: string;
	/** Inline usage hint shown after the subcommand name. */
	hint: string;
	/** Extra items suggested once the subcommand is complete (flags etc.). */
	extras?: ExtraSpec[];
}

const SUBCOMMANDS: SubcommandSpec[] = [
	{ name: "setup", description: "Interactive setup — writes .forge.toml", hint: "" },
	{ name: "board", description: "Show the board table", hint: "[filter]", extras: [
		{ value: "backlog", description: "Only Backlog items" },
		{ value: "ready", description: "Only Ready items" },
		{ value: "in_progress", description: "Only In progress items" },
		{ value: "in_review", description: "Only In review items" },
		{ value: "done", description: "Only Done items" },
	] },
	{ name: "decompose", description: "Turn a spec slice into GitHub issues", hint: "<slice>" },
	{ name: "dispatch", description: "Move an unblocked issue to In progress and emit a worker prompt", hint: "<issue>", extras: [
		{ value: "--project ", description: "Project name (multi-repo .forge.toml)" },
	] },
	{ name: "review", description: "Emit a review prompt for a PR/issue", hint: "<pr-or-issue>" },
	{ name: "decide", description: "Close an issue with a decision comment", hint: "<issue> <decision text>" },
	{ name: "round", description: "Dispatch Ready, mark merged Done, promote unblocked backlog", hint: "", extras: [
		{ value: "--project ", description: "Project name (multi-repo .forge.toml)" },
	] },
	{ name: "promote", description: "Move eligible backlog items to Ready", hint: "" },
	{ name: "status", description: "One-line board counts", hint: "" },
	{ name: "thinking-report", description: "Per-turn thinking-level metrics (self_improvement)", hint: "" },
	{ name: "retrospect", description: "LLM retrospective from telemetry (self_improvement)", hint: "", extras: [
		{ value: "--milestone ", description: "Limit the retrospective to one milestone" },
	] },
	{ name: "doctor", description: "Environment + board sync diagnostics", hint: "" },
];

function subcommandItems(lowerPrefix: string): AutocompleteItem[] {
	const items: AutocompleteItem[] = [];
	for (const spec of SUBCOMMANDS) {
		if (lowerPrefix.length > 0 && !spec.name.toLowerCase().startsWith(lowerPrefix)) continue;
		const item: AutocompleteItem = { value: spec.name, label: spec.name, description: spec.description };
		if (spec.hint.length > 0) item.hint = spec.hint;
		items.push(item);
	}
	return items;
}

function extraItems(sub: SubcommandSpec, rest: string): AutocompleteItem[] {
	if (sub.extras === undefined || rest.includes(" ")) return [];
	const lower = rest.toLowerCase();
	const items: AutocompleteItem[] = [];
	for (const extra of sub.extras) {
		if (lower.length > 0 && !extra.value.trim().toLowerCase().startsWith(lower)) continue;
		items.push({
			value: `${sub.name} ${extra.value}`,
			label: extra.value.trim(),
			description: extra.description,
		});
	}
	return items;
}

/** Build argument completions for the text after `/forge `. */
export function getForgeArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
	const spaceIndex = argumentPrefix.indexOf(" ");
	const firstToken = spaceIndex === -1 ? argumentPrefix : argumentPrefix.slice(0, spaceIndex);

	if (spaceIndex === -1) {
		const items = subcommandItems(firstToken.toLowerCase());
		return items.length > 0 ? items : null;
	}

	const sub = SUBCOMMANDS.find((spec) => spec.name === firstToken);
	if (sub === undefined) return null;

	const items = extraItems(sub, argumentPrefix.slice(spaceIndex + 1));
	return items.length > 0 ? items : null;
}
