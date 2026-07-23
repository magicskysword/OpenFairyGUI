const FAIRY_ID_CHARACTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';

export interface GenerateUniqueIdOptions {
	/** Random source used to generate characters. Primarily useful for deterministic tests. */
	random?: () => number;
	/** Maximum number of candidates generated before failing explicitly. */
	maxAttempts?: number;
}

function generateCandidate(length: number, random: () => number): string {
	if (!Number.isSafeInteger(length) || length <= 0) {
		throw new RangeError('FairyGUI ID length must be a positive safe integer.');
	}

	let result = '';
	for (let i = 0; i < length; i++) {
		const value = random();
		if (!Number.isFinite(value) || value < 0 || value >= 1) {
			throw new RangeError('FairyGUI ID random source must return a number in the range [0, 1).');
		}
		result += FAIRY_ID_CHARACTERS.charAt(Math.floor(value * FAIRY_ID_CHARACTERS.length));
	}
	return result;
}

/**
 * Generates an alphanumeric ID compatible with FairyGUI conventions.
 *
 * This compatibility helper does not check for conflicts. Prefer one of the
 * typed helpers when creating package, resource, or component-child IDs.
 */
export function generateId(length = 8): string {
	return generateCandidate(length, Math.random);
}

/**
 * Generates a conflict-free lowercase alphanumeric FairyGUI ID.
 */
export function generateUniqueId(
	length: number,
	existingIds: Iterable<string>,
	options: GenerateUniqueIdOptions = {},
): string {
	const existing = new Set(existingIds);
	const random = options.random ?? Math.random;
	const maxAttempts = options.maxAttempts ?? 1_000;
	if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
		throw new RangeError('FairyGUI ID maxAttempts must be a positive safe integer.');
	}

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const candidate = generateCandidate(length, random);
		if (!existing.has(candidate)) return candidate;
	}

	throw new Error(
		`Unable to generate a unique ${length}-character FairyGUI ID after ${maxAttempts} attempts.`,
	);
}

/** Generates an 8-character project-wide package ID. */
export function generatePackageId(
	existingIds: Iterable<string>,
	options?: GenerateUniqueIdOptions,
): string {
	return generateUniqueId(8, existingIds, options);
}

/** Generates a 5-character package-wide resource or component-definition ID. */
export function generateResourceId(
	existingIds: Iterable<string>,
	options?: GenerateUniqueIdOptions,
): string {
	return generateUniqueId(5, existingIds, options);
}

/**
 * Generates a component child ID using FairyGUI's `n<next decimal>` convention.
 *
 * Existing legacy or custom IDs are preserved and ignored when calculating the
 * next numeric suffix.
 */
export function generateChildId(existingIds: Iterable<string>): string {
	let maxId = -1;
	for (const id of existingIds) {
		const match = /^n(\d+)$/.exec(id);
		if (!match) continue;
		const value = Number(match[1]);
		if (!Number.isSafeInteger(value)) {
			throw new RangeError('FairyGUI child ID exceeds the safe integer range.');
		}
		maxId = Math.max(maxId, value);
	}

	if (maxId >= Number.MAX_SAFE_INTEGER) {
		throw new RangeError('FairyGUI child ID exceeds the safe integer range.');
	}
	return `n${maxId + 1}`;
}

/**
 * Parses a FairyGUI URL: `ui://[packageId][resourceId]`.
 */
export function parseURL(url: string): { packageId: string; resourceId: string } | null {
	if (!url.startsWith('ui://')) return null;
	const body = url.substring(5);
	if (body.length < 8) return null;
	return {
		packageId: body.substring(0, 8),
		resourceId: body.substring(8),
	};
}

/**
 * Builds a FairyGUI URL from package and resource IDs.
 */
export function buildURL(packageId: string, resourceId: string): string {
	return `ui://${packageId}${resourceId}`;
}
