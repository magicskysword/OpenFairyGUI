export interface HighResolutionResourceLike {
	propertyType: string;
	getId(): string;
	getName(): string | null;
	getPath?(): string | null;
	getBranch?(): string;
}

function resourceKey(
	resource: HighResolutionResourceLike,
	baseName: string,
): string {
	return JSON.stringify([
		resource.propertyType,
		resource.getBranch?.() ?? '',
		resource.getPath?.() || '/',
		baseName,
	]);
}

/**
 * Infers FairyGUI @2x/@3x/@4x item links from source resource names.
 *
 * The returned arrays represent scale levels 2 through the highest declared
 * level. Missing intermediate levels reuse the closest lower available
 * variant, while a missing first level remains null and falls back to 1x.
 */
export function inferHighResolutionItemIds<
	T extends HighResolutionResourceLike,
>(resources: readonly T[]): Map<string, Array<string | null>> {
	const baseResources = new Map<string, T>();
	const variants = new Map<string, Map<number, T>>();

	for (const resource of resources) {
		const name = resource.getName();
		if (!name) continue;
		const match = /^(.*)@([234])x$/.exec(name);
		if (!match) {
			baseResources.set(resourceKey(resource, name), resource);
			continue;
		}

		const baseName = match[1] ?? '';
		const scale = Number(match[2]);
		const key = resourceKey(resource, baseName);
		let byScale = variants.get(key);
		if (!byScale) {
			byScale = new Map();
			variants.set(key, byScale);
		}
		const existing = byScale.get(scale);
		if (existing) {
			throw new Error(
				`High-resolution resource conflict for "${baseName}@${scale}x": `
				+ `"${existing.getId()}" and "${resource.getId()}".`,
			);
		}
		byScale.set(scale, resource);
	}

	const result = new Map<string, Array<string | null>>();
	for (const [key, byScale] of variants) {
		const base = baseResources.get(key);
		if (!base) continue;
		const highestScale = Math.max(...byScale.keys());
		const itemIds: Array<string | null> = [];
		let fallbackId: string | null = null;
		for (let scale = 2; scale <= highestScale; scale++) {
			const exact = byScale.get(scale);
			if (exact) fallbackId = exact.getId();
			itemIds.push(fallbackId);
		}
		result.set(base.getId(), itemIds);
	}
	return result;
}
