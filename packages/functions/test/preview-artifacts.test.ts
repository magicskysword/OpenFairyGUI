import test from 'ava';
import { Document, ProjectWriter, type FileSystem } from '@magicskysword/openfairygui-core';
import path from 'node:path';
import { captureProjectSnapshot } from '../src/project-snapshot.js';
import { buildPreviewArtifacts } from '../src/preview-artifacts.js';

test('preview artifacts compile a captured document without rereading mutable sources', async (t) => {
	const files = new Map<string, Uint8Array>();
	const fs: FileSystem = {
		readFile: async (p) => new TextDecoder().decode(files.get(p)),
		readFileRaw: async (p) => files.get(p)!,
		writeFile: async (p, data) => {
			files.set(p, new TextEncoder().encode(data));
		},
		writeFileRaw: async (p, data) => {
			files.set(p, data);
		},
		mkdir: async () => {},
		exists: async (p) => files.has(p) || [...files.keys()].some((k) => k.startsWith(p + '/')),
		readdir: async (p) => [
			...new Set(
				[...files.keys()].filter((k) => k.startsWith(p + '/')).map((k) => k.slice(p.length + 1).split('/')[0]!),
			),
		],
		join: path.posix.join,
		dirname: path.posix.dirname,
	};
	const document = new Document();
	const pkg = document.createPackage('UI').setId('package1');
	pkg.addResource(document.createComponent('Panel').setId('panel').setSize(80, 40).setExported(false));
	await new ProjectWriter(fs).write(document, '/source/test.fairy');
	const snapshot = await captureProjectSnapshot(fs, '/source/test.fairy');
	files.clear();
	const first = await buildPreviewArtifacts(snapshot);
	const second = await buildPreviewArtifacts(snapshot);
	t.deepEqual(first, second);
	t.is(first.snapshotFingerprint, snapshot.fingerprint);
	t.deepEqual(first.packages, [{ packageId: 'package1', packageName: 'UI', fileName: 'UI.fui' }]);
	t.true(first.artifacts.some((file) => file.fileName === 'UI.fui' && file.data.length > 0));
	t.false((await snapshot.readDocument()).getRoot().listPackages()[0]!.listComponents()[0]!.getExported());
});
