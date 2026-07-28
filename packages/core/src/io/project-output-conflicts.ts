import type { Document } from '../document.js';
import type { Package } from '../properties/package.js';

type PackageResource = ReturnType<Package['listResources']>[number];

type OutputResource = PackageResource & {
	getId?(): string;
	getPath?(): string;
	getBranch?(): string;
	getFileName?(): string;
	getFile?(): string;
};

export interface ProjectOutputProducer {
	kind: 'package-descriptor' | 'component' | 'resource';
	packageId: string;
	packageName: string;
	branch: string;
	resourceId?: string;
	resourceType?: string;
	resourceName?: string;
	resourcePath?: string;
}

export interface ProjectOutputConflict {
	packageId: string;
	packageName: string;
	branch: string;
	outputPath: string;
	first: ProjectOutputProducer;
	conflicting: ProjectOutputProducer;
}

function assertSafePathSegment(value: string, label: string): void {
	if (!value || value === '.' || value === '..' || /[\\/:]/.test(value)) {
		throw new Error(`Invalid ${label} "${value}".`);
	}
}

function normalizeSourceRelativePath(value: string): string {
	const segments = value.replace(/\\/g, '/').split('/').filter(Boolean);
	if (segments.some((segment) => segment === '.' || segment === '..' || segment.includes(':'))) {
		throw new Error(`Invalid project source path "${value}".`);
	}
	return segments.join('/');
}

export function projectResourceFileName(resource: OutputResource): string {
	const name = resource.getName?.() ?? '';
	const type = resource.propertyType as string;
	if (type === 'Component') return `${name}.xml`;
	if (type === 'ImageResource' || type === 'FontResource') {
		const fileName = resource.getFileName?.() ?? '';
		if (fileName) return fileName;
	}
	if (
		type === 'SoundResource'
		|| type === 'MiscResource'
		|| type === 'SpineResource'
		|| type === 'DragonBonesResource'
	) {
		const fileName = resource.getFile?.() ?? '';
		if (fileName) return fileName;
	}
	if (type === 'MovieClipResource') {
		const fileName = resource.getFileName?.() ?? '';
		if (fileName) return fileName;
		return `${name}.jta`;
	}
	return name;
}

function resourceOutputPath(resource: OutputResource): string {
	const fileName = projectResourceFileName(resource);
	if (!fileName) return '';
	assertSafePathSegment(fileName, resource.propertyType === 'Component' ? 'component name' : 'resource file name');
	const resourcePath = resource.getPath?.() ?? '/';
	return normalizeSourceRelativePath([resourcePath, fileName].filter(Boolean).join('/'));
}

function resourceProducer(
	pkg: Package,
	resource: OutputResource,
	branch: string,
): ProjectOutputProducer {
	return {
		kind: resource.propertyType === 'Component' ? 'component' : 'resource',
		packageId: pkg.getId(),
		packageName: pkg.getName(),
		branch,
		resourceId: resource.getId?.() ?? '',
		resourceType: resource.propertyType as string,
		resourceName: resource.getName(),
		resourcePath: resource.getPath?.() ?? '/',
	};
}

export function inspectPackageOutputConflicts(pkg: Package): ProjectOutputConflict[] {
	assertSafePathSegment(pkg.getName(), 'package name');
	const resourcesByBranch = new Map<string, OutputResource[]>();
	for (const resource of pkg.listResources() as OutputResource[]) {
		const branch = resource.getBranch?.() ?? '';
		const bucket = resourcesByBranch.get(branch) ?? [];
		bucket.push(resource);
		resourcesByBranch.set(branch, bucket);
	}

	const conflicts: ProjectOutputConflict[] = [];
	for (const [branch, resources] of resourcesByBranch) {
		if (branch) assertSafePathSegment(branch, 'branch name');
		const descriptorName = branch ? 'package_branch.xml' : 'package.xml';
		const descriptor: ProjectOutputProducer = {
			kind: 'package-descriptor',
			packageId: pkg.getId(),
			packageName: pkg.getName(),
			branch,
		};
		const producers = new Map<string, ProjectOutputProducer>([[descriptorName, descriptor]]);
		for (const resource of resources) {
			const outputPath = resourceOutputPath(resource);
			if (!outputPath) continue;
			const current = resourceProducer(pkg, resource, branch);
			const first = producers.get(outputPath);
			if (first) {
				conflicts.push({
					packageId: pkg.getId(),
					packageName: pkg.getName(),
					branch,
					outputPath,
					first,
					conflicting: current,
				});
			} else {
				producers.set(outputPath, current);
			}
		}
	}
	return conflicts;
}

export function inspectProjectOutputConflicts(doc: Document): ProjectOutputConflict[] {
	return doc.getRoot().listPackages().flatMap((pkg) => inspectPackageOutputConflicts(pkg));
}

function outputProducerLabel(producer: ProjectOutputProducer): string {
	if (producer.kind === 'package-descriptor') return 'package descriptor';
	return `resource "${producer.resourceId || producer.resourceName || 'unknown'}"`;
}

export class ProjectOutputConflictError extends Error {
	readonly code = 'PROJECT_OUTPUT_CONFLICT';
	readonly packageId: string;
	readonly packageName: string;
	readonly branch: string;
	readonly outputPath: string;
	readonly first: ProjectOutputProducer;
	readonly conflicting: ProjectOutputProducer;

	constructor(conflict: ProjectOutputConflict) {
		super(
			`Package "${conflict.packageName}" output "${conflict.outputPath}" conflicts with `
				+ `${outputProducerLabel(conflict.first)}; conflicting producer is `
				+ `${outputProducerLabel(conflict.conflicting)}.`,
		);
		this.name = 'ProjectOutputConflictError';
		this.packageId = conflict.packageId;
		this.packageName = conflict.packageName;
		this.branch = conflict.branch;
		this.outputPath = conflict.outputPath;
		this.first = conflict.first;
		this.conflicting = conflict.conflicting;
	}
}
