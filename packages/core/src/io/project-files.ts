import type { Document } from '../document.js';
import type { Package } from '../properties/package.js';
import type { Component } from '../properties/component.js';
import type { FileSystem } from './project-reader.js';
import { ProjectWriter } from './project-writer.js';

export type SerializedProjectFileKind = 'project' | 'setting' | 'package' | 'component';

export interface SerializedProjectFile {
	kind: SerializedProjectFileKind;
	/** Project-relative logical path. Always uses `/`, on every host platform. */
	relativePath: string;
	content: string;
	packageId?: string;
	componentId?: string;
	branch?: string;
	setting?: 'publish' | 'common' | 'adaptation';
}

export type ProjectFileTarget =
	| { kind: 'project' }
	| { kind: 'setting'; setting: 'publish' | 'common' | 'adaptation' }
	| { kind: 'package'; packageId: string; branch?: string }
	| { kind: 'component'; packageId: string; componentId: string };

interface WritableResource {
	propertyType: string;
	getId?(): string;
	getName(): string;
	getPath?(): string;
	getBranch?(): string;
}

const VIRTUAL_PROJECT_ROOT = '/fairygui-project';
const VIRTUAL_PROJECT_PATH = `${VIRTUAL_PROJECT_ROOT}/project.fairy`;

function normalizeLogicalPath(value: string): string {
	const leadingSlash = value.startsWith('/') || value.startsWith('\\');
	const segments = value
		.replace(/\\/g, '/')
		.split('/')
		.filter((segment) => segment && segment !== '.');
	const normalized = segments.join('/');
	return leadingSlash ? `/${normalized}` : normalized;
}

function joinLogicalPath(...values: string[]): string {
	return normalizeLogicalPath(values.join('/'));
}

function dirnameLogicalPath(value: string): string {
	const normalized = normalizeLogicalPath(value);
	const index = normalized.lastIndexOf('/');
	if (index <= 0) return index === 0 ? '/' : '.';
	return normalized.slice(0, index);
}

function relativeLogicalPath(value: string): string {
	const normalized = normalizeLogicalPath(value);
	const prefix = `${VIRTUAL_PROJECT_ROOT}/`;
	if (!normalized.startsWith(prefix)) {
		throw new Error(`Captured project file is outside the virtual root: "${normalized}".`);
	}
	return normalized.slice(prefix.length);
}

class CaptureFileSystem implements FileSystem {
	readonly files = new Map<string, string>();

	async readFile(): Promise<string> {
		throw new Error('CaptureFileSystem does not support reads.');
	}

	async readFileRaw(): Promise<Uint8Array> {
		throw new Error('CaptureFileSystem does not support reads.');
	}

	async writeFile(filePath: string, content: string): Promise<void> {
		this.files.set(normalizeLogicalPath(filePath), content);
	}

	async writeFileRaw(): Promise<void> {
		throw new Error('Project XML serialization emitted an unexpected binary file.');
	}

	async mkdir(): Promise<void> {}

	async readdir(): Promise<string[]> {
		return [];
	}

	async exists(): Promise<boolean> {
		return false;
	}

	join(...paths: string[]): string {
		return joinLogicalPath(...paths);
	}

	dirname(filePath: string): string {
		return dirnameLogicalPath(filePath);
	}
}

function componentRelativePath(pkg: Package, component: Component): string {
	const writable = component as Component & WritableResource;
	const branch = writable.getBranch?.() ?? '';
	const assetsDirectory = branch ? `assets_${branch}` : 'assets';
	const componentDirectory = (writable.getPath?.() ?? '/')
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '');
	return joinLogicalPath(
		assetsDirectory,
		pkg.getName(),
		componentDirectory,
		`${component.getName()}.xml`,
	);
}

function describeProjectFiles(doc: Document): SerializedProjectFile[] {
	const files: SerializedProjectFile[] = [{
		kind: 'project',
		relativePath: 'project.fairy',
		content: '',
	}];
	const settings = doc.getRoot().getSettings();
	const settingFiles = [
		['publish', 'Publish.json'],
		['common', 'Common.json'],
		['adaptation', 'Adaptation.json'],
	] as const;
	for (const [setting, fileName] of settingFiles) {
		if (settings[setting]) {
			files.push({
				kind: 'setting',
				relativePath: `settings/${fileName}`,
				content: '',
				setting,
			});
		}
	}

	for (const pkg of doc.getRoot().listPackages()) {
		const resources = pkg.listResources() as WritableResource[];
		const branches = new Set(resources.map((resource) => resource.getBranch?.() ?? ''));
		branches.add('');
		for (const branch of branches) {
			files.push({
				kind: 'package',
				relativePath: branch
					? `assets_${branch}/${pkg.getName()}/package_branch.xml`
					: `assets/${pkg.getName()}/package.xml`,
				content: '',
				packageId: pkg.getId(),
				branch,
			});
		}

		for (const resource of resources) {
			if (resource.propertyType !== 'Component') continue;
			const component = resource as Component & WritableResource;
			files.push({
				kind: 'component',
				relativePath: componentRelativePath(pkg, component),
				content: '',
				packageId: pkg.getId(),
				componentId: component.getId(),
				branch: component.getBranch?.() ?? '',
			});
		}
	}
	return files;
}

async function captureProjectFiles(doc: Document): Promise<Map<string, string>> {
	const capture = new CaptureFileSystem();
	const writer = new ProjectWriter(capture);
	await writer.write(doc, VIRTUAL_PROJECT_PATH);
	return new Map(
		Array.from(capture.files, ([filePath, content]) => [relativeLogicalPath(filePath), content]),
	);
}

/** Serializes every model-owned project XML/JSON file without writing to disk. */
export async function serializeProjectFiles(doc: Document): Promise<SerializedProjectFile[]> {
	const descriptors = describeProjectFiles(doc);
	const captured = await captureProjectFiles(doc);
	return descriptors
		.filter((descriptor) => captured.has(descriptor.relativePath))
		.map((descriptor) => ({
			...descriptor,
			content: captured.get(descriptor.relativePath) ?? '',
		}));
}

function resolveTarget(
	doc: Document,
	descriptors: SerializedProjectFile[],
	target: ProjectFileTarget,
): SerializedProjectFile {
	if (target.kind === 'project') {
		return descriptors.find((file) => file.kind === 'project')!;
	}
	if (target.kind === 'setting') {
		const descriptor = descriptors.find(
			(file) => file.kind === 'setting' && file.setting === target.setting,
		);
		if (!descriptor) throw new Error(`Unknown or empty FairyGUI setting "${target.setting}".`);
		return descriptor;
	}

	const pkg = doc.getRoot().getPackageById(target.packageId);
	if (!pkg) throw new Error(`Unknown FairyGUI package id "${target.packageId}".`);

	if (target.kind === 'package') {
		const branch = target.branch ?? '';
		const descriptor = descriptors.find(
			(file) => (
				file.kind === 'package'
				&& file.packageId === target.packageId
				&& (file.branch ?? '') === branch
			),
		);
		if (!descriptor) {
			throw new Error(`Unknown branch "${branch}" for FairyGUI package id "${target.packageId}".`);
		}
		return descriptor;
	}

	const resource = pkg.getResourceById(target.componentId);
	if (!resource || resource.propertyType !== 'Component') {
		throw new Error(
			`Unknown component id "${target.componentId}" in FairyGUI package id "${target.packageId}".`,
		);
	}
	return descriptors.find(
		(file) => (
			file.kind === 'component'
				&& file.packageId === target.packageId
				&& file.componentId === target.componentId
		),
	)!;
}

/**
 * Serializes only the explicitly targeted complete project files.
 *
 * Targets are validated before serialization, deduplicated by resolved path,
 * and returned in caller order.
 */
export async function serializeAffectedProjectFiles(
	doc: Document,
	targets: ProjectFileTarget[],
): Promise<SerializedProjectFile[]> {
	const descriptors = describeProjectFiles(doc);
	const selected: SerializedProjectFile[] = [];
	const selectedPaths = new Set<string>();
	for (const target of targets) {
		const descriptor = resolveTarget(doc, descriptors, target);
		if (selectedPaths.has(descriptor.relativePath)) continue;
		selectedPaths.add(descriptor.relativePath);
		selected.push(descriptor);
	}

	const captured = await captureProjectFiles(doc);
	return selected.map((descriptor) => {
		const content = captured.get(descriptor.relativePath);
		if (content === undefined) {
			throw new Error(`Project writer did not emit expected file "${descriptor.relativePath}".`);
		}
		return { ...descriptor, content };
	});
}
