import type { Document } from '@magicskysword/openfairygui-core';
import { publish, type PublishOptions } from './publish.js';
import type { PublishFileSystem } from './shared-types.js';

const MEMORY_OUTPUT_ROOT = '/fairygui-runtime';

export interface MemoryPublishArtifact {
	fileName: string;
	data: Uint8Array;
}

export type PublishToMemoryOptions = Omit<PublishOptions, 'output' | 'fs' | 'generateCode'>;

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
	const artifacts = new Map<string, Uint8Array>();
	const fs: PublishFileSystem = {
		join: joinMemoryPath,
		mkdir: async () => undefined,
		writeFileRaw: async (filePath, data) => {
			const fileName = basename(filePath);
			if (artifacts.has(fileName)) {
				throw new Error(`publishToMemory: Duplicate artifact file name "${fileName}".`);
			}
			artifacts.set(fileName, data.slice());
		},
		...(options.atlas?.readFileRaw ? { readFileRaw: options.atlas.readFileRaw } : {}),
	};

	await publish({
		...options,
		output: MEMORY_OUTPUT_ROOT,
		fs,
		generateCode: false,
	})(doc);

	return [...artifacts.entries()]
		.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
		.map(([fileName, data]) => ({ fileName, data }));
}
