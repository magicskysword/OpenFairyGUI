import {
	ProjectReader,
	applyDocumentEdits,
	assertAuthoringOperations,
	readAuthoringProperties,
	buildProjectReferenceGraph,
	compareProjectDiagnostics,
	DocumentEditError,
	editComponentXml,
	serializeAffectedProjectFiles,
	projectResourceFileName,
	type AuthoringImportData,
	type Document,
	type DocumentEditOperation,
	type XmlFragmentOperation,
	type FileSystem,
	type AuthoringTarget,
	type ProjectFileTarget,
	type Property,
} from '@magicskysword/openfairygui-core';

export type SnapshotEditOperation = DocumentEditOperation | XmlFragmentOperation;
export interface SnapshotFile {
	path: string;
	data: Uint8Array;
}
export interface SnapshotChange {
	relativePath: string;
	content?: Uint8Array;
}

const keyOf = (value: string) => value.replace(/\\/g, '/');
const encoder = new TextEncoder();
const decoder = new TextDecoder();
async function hash(data: Uint8Array): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(data));
	return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

/**
 * Read-only captured source files and directory observations for a project version.
 */
export class ProjectSnapshot {
	private constructor(
		public readonly projectPath: string,
		public readonly fingerprint: string,
		private readonly files: Map<string, Uint8Array>,
		private readonly directories: Map<string, string[]>,
		private readonly existence: Map<string, boolean>,
		private readonly paths: Pick<FileSystem, 'join' | 'dirname'>,
	) {}

	public static async fromFiles(
		projectPath: string,
		files: Map<string, Uint8Array>,
		directories: Map<string, string[]>,
		existence: Map<string, boolean>,
		paths: Pick<FileSystem, 'join' | 'dirname'>,
	): Promise<ProjectSnapshot> {
		const copied = new Map([...files].map(([key, data]) => [keyOf(key), new Uint8Array(data)]));
		const fingerprints = await Promise.all(
			[...copied].sort(([a], [b]) => a.localeCompare(b)).map(async ([key, data]) => [key, await hash(data)]),
		);
		const fingerprint = await hash(encoder.encode(JSON.stringify(fingerprints)));
		return new ProjectSnapshot(
			projectPath,
			fingerprint,
			copied,
			new Map([...directories].map(([key, names]) => [keyOf(key), [...names]])),
			new Map(existence),
			paths,
		);
	}

	public listFiles(): SnapshotFile[] {
		return [...this.files].map(([path, data]) => ({ path, data: new Uint8Array(data) }));
	}

	public fileSystem(): FileSystem {
		const unavailable = async (): Promise<never> => {
			throw new Error('Project snapshot is read-only.');
		};
		const read = async (path: string) => {
			const value = this.files.get(keyOf(path));
			if (!value) throw new Error(`Snapshot file not found: ${path}`);
			return new Uint8Array(value);
		};
		return {
			readFile: async (path) => decoder.decode(await read(path)),
			readFileRaw: read,
			writeFile: unavailable,
			writeFileRaw: unavailable,
			mkdir: unavailable,
			readdir: async (path) => {
				const key = keyOf(path);
				const names = new Set(this.directories.get(key) ?? []);
				for (const file of this.files.keys())
					if (file.startsWith(key + '/')) names.add(file.slice(key.length + 1).split('/')[0]!);
				return [...names].sort();
			},
			exists: async (path) =>
				this.files.has(keyOf(path)) ||
				this.directories.has(keyOf(path)) ||
				this.existence.get(keyOf(path)) === true ||
				[...this.files.keys()].some((key) => key.startsWith(keyOf(path) + '/')),
			join: (...parts) => this.paths.join(...parts),
			dirname: (path) => this.paths.dirname(path),
		};
	}

	public readDocument(): Promise<Document> {
		return new ProjectReader(this.fileSystem()).read(this.projectPath, { hydrateResourceBytes: true });
	}

	public async withChanges(changes: readonly SnapshotChange[]): Promise<ProjectSnapshot> {
		const files = new Map(this.files);
		const exists = new Map(this.existence);
		const base = keyOf(this.paths.dirname(this.projectPath));
		for (const change of changes) {
			const segments = change.relativePath.replace(/\\/g, '/').split('/');
			if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes(':')))
				throw new DocumentEditError('INVALID_SOURCE_PATH', '快照路径无效');
			const path = keyOf(this.paths.join(base, ...segments));
			if (!path.startsWith(base + '/'))
				throw new DocumentEditError('INVALID_SOURCE_PATH', '快照路径越过工程目录');
			if (change.content === undefined) files.delete(path);
			else files.set(path, new Uint8Array(change.content));
			exists.set(path, change.content !== undefined);
		}
		return ProjectSnapshot.fromFiles(this.projectPath, files, this.directories, exists, this.paths);
	}

	public async changedSources(fs: FileSystem): Promise<string[]> {
		const changed = new Set<string>();
		for (const [path, expected] of this.files) {
			try {
				if ((await hash(await fs.readFileRaw(path))) !== (await hash(expected))) changed.add(path);
			} catch {
				changed.add(path);
			}
		}
		for (const [path, names] of this.directories) {
			try {
				if (JSON.stringify([...(await fs.readdir(path))].sort()) !== JSON.stringify([...names].sort()))
					changed.add(path);
			} catch {
				changed.add(path);
			}
		}
		for (const [path, expected] of this.existence) if ((await fs.exists(path)) !== expected) changed.add(path);
		return [...changed];
	}
}

export async function captureProjectSnapshot(fs: FileSystem, projectPath: string): Promise<ProjectSnapshot> {
	const files = new Map<string, Uint8Array>();
	const directories = new Map<string, string[]>();
	const existence = new Map<string, boolean>();
	const base = keyOf(fs.join(fs.dirname(projectPath)));
	const assertPath = (path: string) => {
		const resolved = keyOf(fs.join(path));
		if (resolved !== base && !resolved.startsWith(base + '/'))
			throw new DocumentEditError('INVALID_SOURCE_PATH', '工程来源路径越过工程目录');
		return resolved;
	};
	const read = async (path: string) => {
		const key = assertPath(path);
		if (!files.has(key)) files.set(key, new Uint8Array(await fs.readFileRaw(path)));
		return new Uint8Array(files.get(key)!);
	};
	const recording: FileSystem = {
		readFile: async (path) => decoder.decode(await read(path)),
		readFileRaw: read,
		writeFile: async () => {
			throw new Error('Capture is read-only.');
		},
		writeFileRaw: async () => {
			throw new Error('Capture is read-only.');
		},
		mkdir: async () => {
			throw new Error('Capture is read-only.');
		},
		readdir: async (path) => {
			assertPath(path);
			const names = await fs.readdir(path);
			directories.set(keyOf(path), [...names]);
			return names;
		},
		exists: async (path) => {
			assertPath(path);
			const exists = await fs.exists(path);
			existence.set(keyOf(path), exists);
			return exists;
		},
		join: (...parts) => fs.join(...parts),
		dirname: (path) => fs.dirname(path),
	};
	await new ProjectReader(recording).read(projectPath, { hydrateResourceBytes: true });
	const snapshot = await ProjectSnapshot.fromFiles(projectPath, files, directories, existence, {
		join: (...parts) => fs.join(...parts),
		dirname: (path) => fs.dirname(path),
	});
	const changed = await snapshot.changedSources(fs);
	if (changed.length) throw new DocumentEditError('SOURCE_CONFLICT', '读取期间工程发生变化', undefined, changed);
	return snapshot;
}

function existingTargets(document: Document, targets: ProjectFileTarget[]): ProjectFileTarget[] {
	return targets.filter((target) =>
		target.kind === 'setting'
			? Boolean(document.getRoot().getSettings()[target.setting])
			: !('packageId' in target) ||
				(target.kind === 'component'
					? document.getRoot().getPackageById(target.packageId)?.getResourceById(target.componentId) != null
					: document.getRoot().getPackageById(target.packageId) != null),
	);
}

function canonicalState(value: unknown): unknown {
	if (typeof value === 'string' && /^#[a-f\d]{6,8}$/i.test(value)) return value.toLowerCase();
	if (Array.isArray(value)) return value.map(canonicalState);
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, child]) => [key, canonicalState(child)]),
		);
	return value;
}

function modelState(owner: Property): unknown {
	const props = readAuthoringProperties(owner);
	// 空发布名与包名回退在工程格式中具有相同的有效值。
	if (owner.propertyType === 'Package' && !props.publishName) props.publishName = owner.getName();
	const state: Record<string, unknown> = { type: owner.propertyType, props };
	const object = owner as unknown as Record<string, unknown>;
	if (typeof object.getId === 'function') state.id = object.getId.call(owner);
	for (const method of [
		'listPackages',
		'listResources',
		'listChildren',
		'listControllers',
		'listPages',
		'listGears',
		'listActions',
		'listTransitions',
		'listItems',
	]) {
		if (typeof object[method] !== 'function') continue;
		const values = (object[method] as () => Property[]).call(owner).map(modelState);
		if (method === 'listPackages' || method === 'listResources')
			values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
		state[method] = values;
	}
	return canonicalState(state);
}

function firstDifference(
	expected: unknown,
	actual: unknown,
	path = 'document',
): { path: string; expected: unknown; actual: unknown } | undefined {
	if (Object.is(expected, actual)) return;
	if (!expected || !actual || typeof expected !== 'object' || typeof actual !== 'object')
		return { path, expected, actual };
	for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
		const diff = firstDifference(
			(expected as Record<string, unknown>)[key],
			(actual as Record<string, unknown>)[key],
			`${path}.${key}`,
		);
		if (diff) return diff;
	}
}

function binarySources(document: Document): Map<string, Uint8Array> {
	const files = new Map<string, Uint8Array>();
	for (const pkg of document.getRoot().listPackages())
		for (const resource of pkg.listResources()) {
			if (resource.propertyType === 'Component') continue;
			const fileName = projectResourceFileName(resource);
			const branch = resource.getBranch();
			const relativePath = [branch ? `assets_${branch}` : 'assets', pkg.getName(), resource.getPath(), fileName]
				.join('/')
				.replace(/\/{2,}/g, '/');
			const bytes = resource.getSourceData()?.getData();
			if (bytes) files.set(relativePath, bytes);
		}
	return files;
}
function binaryChanges(before: Document, after: Document): SnapshotChange[] {
	const oldFiles = binarySources(before);
	const newFiles = binarySources(after);
	const changes: SnapshotChange[] = [];
	for (const relativePath of oldFiles.keys()) if (!newFiles.has(relativePath)) changes.push({ relativePath });
	for (const [relativePath, content] of newFiles) {
		const previous = oldFiles.get(relativePath);
		if (
			!previous ||
			previous.length !== content.length ||
			previous.some((value, index) => value !== content[index])
		)
			changes.push({ relativePath, content });
	}
	return changes;
}

export async function prepareSnapshotEdits(
	source: ProjectSnapshot,
	operations: readonly SnapshotEditOperation[],
): Promise<{
	snapshot: ProjectSnapshot;
	changes: SnapshotChange[];
	clientRefs: Record<string, AuthoringTarget>;
	operationResults: Array<{ index: number; op: string; targets: AuthoringTarget[] }>;
	diagnostics: ReturnType<typeof compareProjectDiagnostics>;
}> {
	if (!operations.length || operations.length > 200)
		throw new DocumentEditError('INVALID_EDIT', '编辑批次必须包含 1 至 200 项操作');
	assertAuthoringOperations(operations);
	let snapshot = source;
	let document = await snapshot.readDocument();
	const baseline = buildProjectReferenceGraph(document).diagnostics;
	const clientRefs: Record<string, AuthoringTarget> = {};
	const changes = new Map<string, SnapshotChange>();
	const operationResults: Array<{ index: number; op: string; targets: AuthoringTarget[] }> = [];
	const imports = new Map<string, AuthoringImportData>();
	const inboxPaths = new Set<string>();
	for (const [index, operation] of operations.entries()) {
		if (operation.op === 'xml' || !operation.inboxPath) continue;
		const segments = operation.inboxPath.split('/');
		if (segments.some((segment) => !segment || segment === '.' || segment === '..' || /[\\:]/.test(segment)))
			throw new DocumentEditError(
				'IMPORT_PATH_INVALID',
				'收件箱路径必须是规范相对路径',
				`operations[${index}].inboxPath`,
			);
		const relativePath = `.fairygui-mcp/import-inbox/${operation.inboxPath}`;
		const fs = source.fileSystem();
		imports.set(operation.inboxPath, {
			fileName: segments.at(-1)!,
			data: await fs.readFileRaw(fs.join(fs.dirname(source.projectPath), relativePath)),
		});
		inboxPaths.add(relativePath);
	}
	const sourceName = keyOf(source.projectPath).split('/').pop()!;
	const sourcePath = (file: { kind: string; relativePath: string }) =>
		file.kind === 'project' ? sourceName : file.relativePath;
	for (let index = 0; index < operations.length; ) {
		const operation = operations[index]!;
		if (operation.op === 'xml') {
			const file = (
				await serializeAffectedProjectFiles(document, [
					{
						kind: 'component',
						packageId: operation.target.packageId!,
						componentId: operation.target.componentId!,
					},
				])
			)[0]!;
			const result = editComponentXml(file.content, operation);
			const change = { relativePath: file.relativePath, content: encoder.encode(result.xml) };
			changes.set(change.relativePath, change);
			snapshot = await snapshot.withChanges([change]);
			for (const [label, nodeId] of Object.entries(result.idMap))
				clientRefs[label] = { ...operation.target, kind: 'node', nodeId };
			operationResults.push({ index, op: 'xml', targets: [operation.target] });
			index++;
		} else {
			const start = index;
			const batch: DocumentEditOperation[] = [];
			while (index < operations.length && operations[index]!.op !== 'xml') {
				const item = structuredClone(operations[index]) as DocumentEditOperation;
				for (const field of ['packageId', 'componentId', 'nodeId', 'resourceId', 'pageId'] as const) {
					const value = item.target[field];
					if (value?.startsWith('@') && clientRefs[value.slice(1)]?.[field])
						item.target[field] = clientRefs[value.slice(1)]![field];
				}
				batch.push(item);
				index++;
			}
			const result = applyDocumentEdits(document, batch, { imports });
			const before = await serializeAffectedProjectFiles(document, existingTargets(document, result.affected));
			const after = await serializeAffectedProjectFiles(
				result.document,
				existingTargets(result.document, result.affected),
			);
			const afterPaths = new Set(after.map(sourcePath));
			const updates: SnapshotChange[] = [
				...binaryChanges(document, result.document),
				...before
					.filter((file) => !afterPaths.has(sourcePath(file)))
					.map((file) => ({ relativePath: sourcePath(file) })),
				...after.map((file) => ({ relativePath: sourcePath(file), content: encoder.encode(file.content) })),
			];
			for (const change of updates) changes.set(change.relativePath, change);
			snapshot = await snapshot.withChanges(updates);
			const reread = await snapshot.readDocument();
			const difference = firstDifference(modelState(result.document.getRoot()), modelState(reread.getRoot()));
			if (difference)
				throw new DocumentEditError(
					'SERIALIZATION_FAILED',
					'编辑模型在序列化回读后发生语义变化',
					difference.path,
					difference,
				);
			Object.assign(clientRefs, result.clientRefs);
			operationResults.push(...result.operationResults.map((item) => ({ ...item, index: item.index + start })));
		}
		document = await snapshot.readDocument();
	}
	const diagnostics = compareProjectDiagnostics(baseline, buildProjectReferenceGraph(document).diagnostics);
	if (diagnostics.added.some((item) => item.severity === 'error'))
		throw new DocumentEditError(
			'REFERENCE_VALIDATION_FAILED',
			'编辑产生了无效引用或身份冲突',
			undefined,
			diagnostics.added,
		);
	const consumed = [...inboxPaths].map((relativePath) => ({ relativePath }));
	for (const change of consumed) changes.set(change.relativePath, change);
	if (consumed.length) snapshot = await snapshot.withChanges(consumed);
	return { snapshot, changes: [...changes.values()], clientRefs, operationResults, diagnostics };
}
