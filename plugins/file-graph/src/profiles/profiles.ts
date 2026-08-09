/**
 * Parsing profiles — data, not code branches.
 *
 * A profile controls which bracket namespaces the inline scanner recognises
 * and whether definition-site detection runs. The two built-in profiles match
 * spec §5.3; `generic` is the default with no namespaces and inline scanning
 * off unless the user overrides `namespaces` via `/fg config`.
 */

import type { Profile } from "../types";

/** Reference profile for dogfooding: zksrc domain namespaces. */
export const ZKSRC_PROFILE: Profile = {
	name: "zksrc",
	namespaces: ["C", "RQ", "SP", "D", "S"],
	scanInline: true,
};

/** Default profile: no namespaces, inline scanning off. */
export const GENERIC_PROFILE: Profile = {
	name: "generic",
	namespaces: [],
	scanInline: false,
};

const PROFILES: Record<string, Profile> = {
	generic: GENERIC_PROFILE,
	zksrc: ZKSRC_PROFILE,
};

/**
 * Resolve the effective profile from config values.
 *
 * A non-empty `namespaces` override on `generic` turns on inline scanning for
 * exactly those prefixes, letting a generic workspace opt into bracket IDs
 * without switching profiles.
 */
export function resolveProfile(
	profileName: "generic" | "zksrc",
	namespaceOverride: readonly string[],
): Profile {
	const base = PROFILES[profileName] ?? GENERIC_PROFILE;
	if (namespaceOverride.length > 0) {
		return {
			name: base.name,
			namespaces: namespaceOverride.slice(),
			scanInline: true,
		};
	}
	return base;
}

/** True when `name` matches a known bracket-namespace prefix for the profile. */
export function isKnownNamespace(profile: Profile, name: string): boolean {
	return profile.namespaces.includes(name);
}
