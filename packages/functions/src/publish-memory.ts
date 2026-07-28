import type { Document } from '@magicskysword/openfairygui-core';
import { publish, type PublishOptions } from './publish.js';
import type { PublishFileSystem } from './shared-types.js';
import type {
	AtlasRasterBackend,
	AtlasRasterCompositeInput,
	AtlasRasterInput,
	AtlasRasterMetadata,
	AtlasRasterPipeline,
	AtlasRasterResolvedBuffer,
} from './publish/contracts.js';

const MEMORY_OUTPUT_ROOT = '/fairygui-runtime';

export interface MemoryPublishArtifact {
	fileName: string;
	data: Uint8Array;
}

export type MemoryArtifactProducer = 'atlas' | 'publish-output';

export interface MemoryArtifactWrite {
	producer: MemoryArtifactProducer;
	path: string;
	byteLength: number;
}

export class MemoryArtifactConflictError extends Error {
	public readonly code = 'DUPLICATE_MEMORY_ARTIFACT';

	constructor(
		public readonly fileName: string,
		public readonly first: MemoryArtifactWrite,
		public readonly conflicting: MemoryArtifactWrite,
	) {
		super(
			`publishToMemory: Artifact file name "${fileName}" conflicts; ` +
			`first producer ${first.producer} wrote "${first.path}" (${first.byteLength} bytes), ` +
			`conflicting producer ${conflicting.producer} attempted "${conflicting.path}" ` +
			`(${conflicting.byteLength} bytes).`,
		);
		this.name = 'MemoryArtifactConflictError';
	}
}

export type PublishToMemoryOptions = Omit<
	PublishOptions,
	'output' | 'fs' | 'codeGeneration' | 'generateCode'
>;

class MemoryOutputRasterPipeline implements AtlasRasterPipeline {
	constructor(
		private pipeline: AtlasRasterPipeline,
		private readonly writeFileRaw: (path: string, data: Uint8Array) => Promise<void>,
	) {}

	ensureAlpha(): this {
		this.pipeline = this.pipeline.ensureAlpha();
		return this;
	}

	resize(options: { width: number; height: number; fit?: 'fill' }): this {
		this.pipeline = this.pipeline.resize(options);
		return this;
	}

	raw(): this {
		this.pipeline = this.pipeline.raw();
		return this;
	}

	extract(options: { left: number; top: number; width: number; height: number }): this {
		this.pipeline = this.pipeline.extract(options);
		return this;
	}

	png(): this {
		this.pipeline = this.pipeline.png();
		return this;
	}

	rotate(angle: number): this {
		this.pipeline = this.pipeline.rotate(angle);
		return this;
	}

	composite(inputs: AtlasRasterCompositeInput[]): this {
		this.pipeline = this.pipeline.composite(inputs);
		return this;
	}

	metadata(): Promise<AtlasRasterMetadata> {
		return this.pipeline.metadata();
	}

	toBuffer(options: { resolveWithObject: true }): Promise<AtlasRasterResolvedBuffer>;
	toBuffer(options?: { resolveWithObject?: false }): Promise<Uint8Array>;
	toBuffer(
		options?: { resolveWithObject?: boolean },
	): Promise<Uint8Array | AtlasRasterResolvedBuffer> {
		if (options?.resolveWithObject) {
			return this.pipeline.toBuffer({ resolveWithObject: true });
		}
		return this.pipeline.toBuffer();
	}

	async toFile(path: string): Promise<void> {
		const output = /\.png$/i.test(path) ? this.pipeline.png() : this.pipeline;
		await this.writeFileRaw(path, await output.toBuffer());
	}
}

function createMemoryOutputBackend(
	encoder: AtlasRasterBackend,
	writeFileRaw: (path: string, data: Uint8Array) => Promise<void>,
): AtlasRasterBackend {
	return (input: AtlasRasterInput) =>
		new MemoryOutputRasterPipeline(encoder(input), writeFileRaw);
}

function joinMemoryPath(...parts: string[]): string {
	return parts
		.filter((part) => part.length > 0)
		.join('/')
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/');
}

function basename(filePath: string): string {
	const normalized = filePath.replace(/\\/g, '/');
	return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/**
 * Compiles FairyGUI runtime artifacts entirely in memory.
 *
 * Publishing derives atlas and dependency metadata on the supplied document.
 * Callers that retain an immutable authoring snapshot should pass an isolated
 * document instance dedicated to preview compilation.
 */
export async function publishToMemory(
	doc: Document,
	options: PublishToMemoryOptions = {},
): Promise<MemoryPublishArtifact[]> {
	const artifacts = new Map<string, { data: Uint8Array; write: MemoryArtifactWrite }>();
	const addArtifact = (
		filePath: string,
		data: Uint8Array,
		producer: MemoryArtifactProducer,
	): void => {
		const fileName = basename(filePath);
		const write: MemoryArtifactWrite = {
			producer,
			path: filePath,
			byteLength: data.byteLength,
		};
		const existing = artifacts.get(fileName);
		if (existing) {
			throw new MemoryArtifactConflictError(fileName, existing.write, write);
		}
		artifacts.set(fileName, { data: data.slice(), write });
	};
	const fs: PublishFileSystem = {
		join: joinMemoryPath,
		mkdir: async () => undefined,
		writeFileRaw: async (filePath, data) => {
			addArtifact(filePath, data, 'publish-output');
		},
		...(options.atlas?.readFileRaw ? { readFileRaw: options.atlas.readFileRaw } : {}),
	};
	const encoder = options.encoder
		? createMemoryOutputBackend(options.encoder, async (filePath, data) => {
			addArtifact(filePath, data, 'atlas');
		})
		: undefined;

	await publish({
		...options,
		encoder,
		output: MEMORY_OUTPUT_ROOT,
		fs,
		codeGeneration: false,
	})(doc);

	return [...artifacts.entries()]
		.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
		.map(([fileName, artifact]) => ({ fileName, data: artifact.data }));
}
