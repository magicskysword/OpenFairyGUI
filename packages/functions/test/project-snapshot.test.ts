import test from 'ava';
import path from 'node:path';
import { ProjectWriter, Document, type FileSystem } from '@magicskysword/openfairygui-core';
import { captureProjectSnapshot, prepareSnapshotEdits } from '../src/project-snapshot.js';

async function fixture() {
	const files = new Map<string, Uint8Array>();
	const fs: FileSystem = {
		readFile: async (key) =>
			new TextDecoder().decode(
				files.get(key) ??
					(() => {
						throw new Error('missing');
					})(),
			),
		readFileRaw: async (key) =>
			new Uint8Array(
				files.get(key) ??
					(() => {
						throw new Error('missing');
					})(),
			),
		writeFile: async (key, text) => {
			files.set(key, new TextEncoder().encode(text));
		},
		writeFileRaw: async (key, bytes) => {
			files.set(key, new Uint8Array(bytes));
		},
		mkdir: async () => {},
		exists: async (key) => files.has(key) || [...files.keys()].some((file) => file.startsWith(key + '/')),
		readdir: async (key) => [
			...new Set(
				[...files.keys()]
					.filter((file) => file.startsWith(key + '/'))
					.map((file) => file.slice(key.length + 1).split('/')[0]!),
			),
		],
		join: (...parts) => path.posix.join(...parts),
		dirname: path.posix.dirname,
	};
	const document = new Document();
	const pkg = document.createPackage('UI').setId('package1');
	const component = document.createComponent('Panel').setId('panel').setSize(200, 100);
	component.addChild(document.createGTextField('title').setId('n0').setText('Original'));
	pkg.addResource(component);
	await new ProjectWriter(fs).write(document, '/project/project.fairy');
	return { fs, files };
}

test('snapshots isolate source bytes and detect later changes', async (t) => {
	const { fs, files } = await fixture();
	const snapshot = await captureProjectSnapshot(fs, '/project/project.fairy');
	const before = await snapshot.readDocument();
	files.set('/project/assets/UI/Panel.xml', new TextEncoder().encode('<component size="10,10"/>'));
	t.is((await snapshot.readDocument()).getRoot().listPackages()[0]!.listComponents()[0]!.listChildren().length, 1);
	t.is(before.getRoot().listPackages()[0]!.listComponents()[0]!.getWidth(), 200);
	t.true((await snapshot.changedSources(fs)).includes('/project/assets/UI/Panel.xml'));
});

test('mixed native and XML edits prepare a new immutable snapshot without writes', async (t) => {
	const { fs, files } = await fixture();
	const before = await fs.readFile('/project/assets/UI/Panel.xml');
	const snapshot = await captureProjectSnapshot(fs, '/project/project.fairy');
	const result = await prepareSnapshotEdits(snapshot, [
		{
			op: 'update',
			target: { kind: 'node', packageId: 'package1', componentId: 'panel', nodeId: 'n0' },
			props: { text: 'Updated' },
		},
		{
			op: 'xml',
			action: 'insert',
			target: { kind: 'component', packageId: 'package1', componentId: 'panel' },
			xml: '<graph id="box" name="box" xy="4,5" size="30,30"/>',
		},
	]);
	t.is(files.size, snapshot.listFiles().length);
	t.is(await fs.readFile('/project/assets/UI/Panel.xml'), before);
	const component = (await result.snapshot.readDocument()).getRoot().listPackages()[0]!.listComponents()[0]!;
	t.is(component.listChildren().length, 2);
	t.is((component.getChildById('n0') as { getText(): string }).getText(), 'Updated');
	t.not(result.snapshot.fingerprint, snapshot.fingerprint);
});

test('XML changes participate in reference validation', async (t) => {
	const { fs } = await fixture();
	const snapshot = await captureProjectSnapshot(fs, '/project/project.fairy');
	await t.throwsAsync(
		() =>
			prepareSnapshotEdits(snapshot, [
				{
					op: 'xml',
					action: 'insert',
					target: { kind: 'component', packageId: 'package1', componentId: 'panel' },
					xml: '<transition name="broken"><item target="missing" type="Rotation" time="0"/></transition>',
				},
			]),
		{ code: 'REFERENCE_VALIDATION_FAILED' },
	);
});
