import type { Document } from '../document.js';
import type { Component, Gear, GObject, Package, TransitionItem } from '../properties/index.js';
import { parseURL } from '../utils/id-utils.js';

export type ResourceReferenceCascadeAction = 'clear-field' | 'remove-owner' | 'unsupported';

export interface ResourceReferenceTarget {
	packageId: string;
	resourceId: string;
}

export interface ResourceReferenceSource {
	packageId: string;
	resourceId: string;
	componentId: string;
	objectId?: string;
	ownerType: string;
	field: string;
}

/**
 * A resource dependency together with enough provenance for callers to explain
 * and, where supported, cascade a deletion.
 */
export interface ResourceReference {
	target: ResourceReferenceTarget;
	source: ResourceReferenceSource;
	value: string;
	cascadeAction: ResourceReferenceCascadeAction;
}

type GetterOwner = Record<string, unknown> & {
	propertyType?: string;
	getId?: () => string;
	getPackageId?: () => string;
	getSrc?: () => string;
	getUrl?: () => string;
	getFont?: () => string;
	getDefaultItem?: () => string;
	getListItems?: () => Array<Record<string, unknown>>;
	listGears?: () => Gear[];
};

const URL_PATTERN = /ui:\/\/([a-zA-Z0-9]{8})([a-zA-Z0-9_./-]+)/g;

function compareReferences(a: ResourceReference, b: ResourceReference): number {
	return [
		a.source.packageId.localeCompare(b.source.packageId),
		a.source.resourceId.localeCompare(b.source.resourceId),
		(a.source.objectId ?? '').localeCompare(b.source.objectId ?? ''),
		a.source.field.localeCompare(b.source.field),
		a.target.packageId.localeCompare(b.target.packageId),
		a.target.resourceId.localeCompare(b.target.resourceId),
	].find((value) => value !== 0) ?? 0;
}

function extractReferences(value: string): ResourceReferenceTarget[] {
	const targets: ResourceReferenceTarget[] = [];
	for (const match of value.matchAll(URL_PATTERN)) {
		const packageId = match[1];
		const resourceId = match[2];
		if (packageId && resourceId) targets.push({ packageId, resourceId });
	}
	if (targets.length > 0) return targets;

	const exact = parseURL(value);
	return exact?.resourceId ? [exact] : [];
}

function ownerId(owner: GetterOwner): string | undefined {
	const id = owner.getId?.();
	return id || undefined;
}

/**
 * Immutable index of references found in one document snapshot.
 */
export class ResourceReferenceIndex {
	private readonly references: readonly ResourceReference[];
	private readonly byTarget: ReadonlyMap<string, readonly ResourceReference[]>;

	public constructor(references: Iterable<ResourceReference>) {
		const ordered = [...references].sort(compareReferences);
		const byTarget = new Map<string, ResourceReference[]>();
		for (const reference of ordered) {
			const key = ResourceReferenceIndex.targetKey(reference.target.packageId, reference.target.resourceId);
			const bucket = byTarget.get(key) ?? [];
			bucket.push(reference);
			byTarget.set(key, bucket);
		}
		this.references = Object.freeze(ordered);
		this.byTarget = byTarget;
	}

	public list(): ResourceReference[] {
		return [...this.references];
	}

	public find(packageId: string, resourceId: string): ResourceReference[] {
		return [...(this.byTarget.get(ResourceReferenceIndex.targetKey(packageId, resourceId)) ?? [])];
	}

	private static targetKey(packageId: string, resourceId: string): string {
		return `${packageId}\0${resourceId}`;
	}
}

class ReferenceCollector {
	private readonly references: ResourceReference[] = [];
	private readonly seen = new Set<string>();

	public add(
		target: ResourceReferenceTarget,
		source: ResourceReferenceSource,
		value: string,
		cascadeAction: ResourceReferenceCascadeAction,
	): void {
		if (!target.packageId || !target.resourceId) return;
		const key = [
			target.packageId,
			target.resourceId,
			source.packageId,
			source.resourceId,
			source.objectId ?? '',
			source.ownerType,
			source.field,
			value,
		].join('\0');
		if (this.seen.has(key)) return;
		this.seen.add(key);
		this.references.push({ target, source, value, cascadeAction });
	}

	public addUrl(
		value: unknown,
		source: ResourceReferenceSource,
		cascadeAction: ResourceReferenceCascadeAction,
	): void {
		if (typeof value !== 'string' || !value) return;
		for (const target of extractReferences(value)) {
			this.add(target, source, value, cascadeAction);
		}
	}

	public finish(): ResourceReferenceIndex {
		return new ResourceReferenceIndex(this.references);
	}
}

function sourceFor(
	pkg: Package,
	component: Component,
	owner: GetterOwner,
	field: string,
): ResourceReferenceSource {
	return {
		packageId: pkg.getId(),
		resourceId: component.getId(),
		componentId: component.getId(),
		objectId: owner === component ? undefined : ownerId(owner),
		ownerType: String(owner.propertyType ?? 'Unknown'),
		field,
	};
}

function callGetter(owner: GetterOwner, getter: string): unknown {
	const candidate = owner[getter];
	return typeof candidate === 'function' ? candidate.call(owner) : undefined;
}

function scanUrlGetters(
	collector: ReferenceCollector,
	pkg: Package,
	component: Component,
	owner: GetterOwner,
	getters: ReadonlyArray<readonly [getter: string, field: string]>,
): void {
	for (const [getter, field] of getters) {
		collector.addUrl(
			callGetter(owner, getter),
			sourceFor(pkg, component, owner, field),
			'clear-field',
		);
	}
}

function scanUnknownValue(
	collector: ReferenceCollector,
	value: unknown,
	source: ResourceReferenceSource,
	visited = new Set<unknown>(),
): void {
	if (typeof value === 'string') {
		collector.addUrl(value, source, 'unsupported');
		return;
	}
	if (!value || typeof value !== 'object' || visited.has(value)) return;
	visited.add(value);
	if (Array.isArray(value)) {
		for (const item of value) scanUnknownValue(collector, item, source, visited);
		return;
	}
	for (const item of Object.values(value as Record<string, unknown>)) {
		scanUnknownValue(collector, item, source, visited);
	}
}

function scanGears(
	collector: ReferenceCollector,
	pkg: Package,
	component: Component,
	owner: GetterOwner,
): void {
	for (const gear of owner.listGears?.() ?? []) {
		for (const [field, value] of [
			['gear.values', gear.getValues()],
			['gear.defaultValue', gear.getDefaultValue()],
			['gear.pageValues', gear.getPageValues()],
		] as const) {
			scanUnknownValue(collector, value, sourceFor(pkg, component, owner, field));
		}
	}
}

function scanTransitionItem(
	collector: ReferenceCollector,
	pkg: Package,
	component: Component,
	item: TransitionItem,
	itemIndex: number,
): void {
	for (const [suffix, value] of [
		['startValue', item.getStartValue()],
		['endValue', item.getEndValue()],
	] as const) {
		scanUnknownValue(collector, value, {
			...sourceFor(pkg, component, component, `transitions.items[${itemIndex}].${suffix}`),
			ownerType: item.propertyType,
		});
	}
}

const COMPONENT_URL_GETTERS = [
	['getVtScrollBarRes', 'vtScrollBarRes'],
	['getHzScrollBarRes', 'hzScrollBarRes'],
	['getHeaderRes', 'headerRes'],
	['getFooterRes', 'footerRes'],
	['getSound', 'sound'],
	['getAddedToStageSound', 'addedToStageSound'],
	['getRemovedFromStageSound', 'removedFromStageSound'],
	['getDropdown', 'dropdown'],
] as const;

const OBJECT_URL_GETTERS = [
	['getUrl', 'url'],
	['getFont', 'font'],
	['getDefaultItem', 'defaultItem'],
	['getIcon', 'icon'],
	['getSelectedIcon', 'selectedIcon'],
	['getDropdown', 'dropdown'],
	['getSound', 'sound'],
	['getInstanceIcon', 'instanceIcon'],
	['getInstanceSelectedIcon', 'instanceSelectedIcon'],
	['getVtScrollBarRes', 'vtScrollBarRes'],
	['getHzScrollBarRes', 'hzScrollBarRes'],
	['getHeaderRes', 'headerRes'],
	['getFooterRes', 'footerRes'],
] as const;

function scanObject(
	collector: ReferenceCollector,
	pkg: Package,
	component: Component,
	child: GObject,
): void {
	const owner = child as unknown as GetterOwner;
	const src = owner.getSrc?.();
	if (src) {
		const target = parseURL(src) ?? {
			packageId: owner.getPackageId?.() || pkg.getId(),
			resourceId: src,
		};
		collector.add(target, sourceFor(pkg, component, owner, 'src'), src, 'remove-owner');
	}

	scanUrlGetters(collector, pkg, component, owner, OBJECT_URL_GETTERS);

	for (const [index, item] of (owner.getListItems?.() ?? []).entries()) {
		for (const field of ['icon', 'selectedIcon', 'url'] as const) {
			collector.addUrl(
				item[field],
				sourceFor(pkg, component, owner, `listItems[${index}].${field}`),
				'clear-field',
			);
		}
	}

	const comboItems = callGetter(owner, 'getInstanceComboItems');
	if (Array.isArray(comboItems)) {
		for (const [index, item] of comboItems.entries()) {
			if (!item || typeof item !== 'object') continue;
			collector.addUrl(
				(item as Record<string, unknown>).icon,
				sourceFor(pkg, component, owner, `instanceComboItems[${index}].icon`),
				'clear-field',
			);
		}
	}

	scanGears(collector, pkg, component, owner);
}

function scanComponent(
	collector: ReferenceCollector,
	pkg: Package,
	component: Component,
): void {
	const owner = component as unknown as GetterOwner;
	scanUrlGetters(collector, pkg, component, owner, COMPONENT_URL_GETTERS);
	for (const child of component.listChildren()) scanObject(collector, pkg, component, child);
	for (const transition of component.listTransitions()) {
		transition.listItems().forEach((item, index) => {
			scanTransitionItem(collector, pkg, component, item, index);
		});
	}
}

/**
 * Builds a project-wide index without mutating the document.
 *
 * Known scalar/list references are marked as safely clearable, display-list
 * instance references are marked for owner removal, and references embedded in
 * gears or transitions remain visible but explicitly unsupported for cascading.
 */
export function buildResourceReferenceIndex(document: Document): ResourceReferenceIndex {
	const collector = new ReferenceCollector();
	for (const pkg of document.getRoot().listPackages()) {
		for (const component of pkg.listComponents()) scanComponent(collector, pkg, component);
	}
	return collector.finish();
}
