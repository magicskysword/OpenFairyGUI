import test from 'ava';
import path from 'node:path';
import { ProjectWriter, Document, type FileSystem, type GTextField } from '@magicskysword/openfairygui-core';
import { captureProjectSnapshot, prepareSnapshotEdits } from '../src/project-snapshot.js';

test('XML edits also reject errors within their affected component scope', async (t) => {
	const { fs, files } = await fixture();
	const componentPath = '/project/assets/UI/Panel.xml';
	files.set(
		componentPath,
		new TextEncoder().encode(
			(await fs.readFile(componentPath)).replace('<component ', '<component mask="missing" '),
		),
	);
	const snapshot = await captureProjectSnapshot(fs, '/project/project.fairy');
	await t.throwsAsync(
		() =>
			prepareSnapshotEdits(snapshot, [
				{
					op: 'xml',
					action: 'attributes',
					target: { kind: 'node', packageId: 'package1', componentId: 'panel', nodeId: 'n0' },
					attributes: { text: 'changed' },
				},
			]),
		{ code: 'REFERENCE_VALIDATION_FAILED' },
	);
});

test('native controllers, gears, transitions and XML batch references roundtrip together', async (t) => {
	const { fs } = await fixture();
	const snapshot = await captureProjectSnapshot(fs, '/project/project.fairy');
	const common = { packageId: 'package1', componentId: 'panel' };
	const result = await prepareSnapshotEdits(snapshot, [
		{ op: 'create', target: { ...common, kind: 'controller' }, props: { name: 'state' }, clientRef: 'state' },
		{
			op: 'create',
			target: { ...common, kind: 'page', controllerName: '@state' },
			props: { name: 'up' },
			clientRef: 'up',
		},
		{
			op: 'create',
			target: { ...common, kind: 'page', controllerName: '@state' },
			props: { name: 'down' },
			clientRef: 'down',
		},
		{
			op: 'create',
			target: { ...common, kind: 'gear', nodeId: 'n0', controllerName: '@state' },
			props: {
				gearType: 1,
				pages: '@up,@down',
				values: '0,0|100,20',
				defaultValue: '0,0',
				tween: true,
				tweenDuration: 0.5,
			},
		},
		{ op: 'create', target: { ...common, kind: 'transition' }, props: { name: 'enter' }, clientRef: 'enter' },
		{
			op: 'create',
			target: { ...common, kind: 'transition-item', transitionName: '@enter' },
			props: { targetId: 'n0', actionType: 5, startValue: [0], endValue: [90], tween: true, duration: 0.5 },
		},
		{
			op: 'xml',
			action: 'insert',
			target: { ...common, kind: 'component' },
			xml: '<graph id="box" name="box" size="20,20"/>',
		},
		{ op: 'update', target: { ...common, kind: 'node', nodeId: '@box' }, props: { x: 40 } },
	]);
	const component = (await result.snapshot.readDocument()).getRoot().listPackages()[0]!.listComponents()[0]!;
	t.is(component.getController('state')!.listPages().length, 2);
	t.is(component.getChildById('n0')!.listGears()[0]!.getValues(), '0,0|100,20');
	t.is(component.getTransition('enter')!.listItems()[0]!.getTargetId(), 'n0');
	t.is(component.getChildById(result.clientRefs.box!.nodeId!)!.getX(), 40);
});

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
	t.is((component.getChildById('n0') as GTextField).getText(), 'Updated');
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

test('project settings and non-default project filenames persist in prepared snapshots', async (t) => {
	const { fs, files } = await fixture();
	files.set('/project/custom.fairy', files.get('/project/project.fairy')!);
	files.delete('/project/project.fairy');
	const snapshot = await captureProjectSnapshot(fs, '/project/custom.fairy');
	const result = await prepareSnapshotEdits(snapshot, [
		{
			op: 'update',
			target: { kind: 'project' },
			props: { version: '6.0', settings: { common: { font: 'Arial' }, publish: { path: 'release' } } },
		},
	]);
	t.is((await result.snapshot.readDocument()).getRoot().getVersion(), '6.0');
	t.is((await result.snapshot.readDocument()).getRoot().getSettings().common?.font, 'Arial');
	t.true(result.changes.some((file) => file.relativePath === 'custom.fairy'));
	t.false(result.changes.some((file) => file.relativePath === 'project.fairy'));
});

test('component rename and deletion update package metadata and source paths', async (t) => {
	const { fs } = await fixture();
	const snapshot = await captureProjectSnapshot(fs, '/project/project.fairy');
	const renamed = await prepareSnapshotEdits(snapshot, [
		{
			op: 'update',
			target: { kind: 'component', packageId: 'package1', componentId: 'panel' },
			props: { name: 'Renamed' },
		},
	]);
	t.is(
		(await renamed.snapshot.readDocument()).getRoot().listPackages()[0]!.listComponents()[0]!.getName(),
		'Renamed',
	);
	t.true(renamed.changes.some((file) => file.relativePath === 'assets/UI/Panel.xml' && file.content === undefined));
	const removed = await prepareSnapshotEdits(renamed.snapshot, [
		{ op: 'remove', target: { kind: 'component', packageId: 'package1', componentId: 'panel' } },
	]);
	t.is((await removed.snapshot.readDocument()).getRoot().listPackages()[0]!.listComponents().length, 0);
	t.true(removed.changes.some((file) => file.relativePath === 'assets/UI/Renamed.xml' && file.content === undefined));
});

test('model values lost by serialization reject the prepared edit', async (t) => {
	const { fs } = await fixture();
	const snapshot = await captureProjectSnapshot(fs, '/project/project.fairy');
	await t.throwsAsync(
		() =>
			prepareSnapshotEdits(snapshot, [
				{
					op: 'update',
					target: { kind: 'node', packageId: 'package1', componentId: 'panel', nodeId: 'n0' },
					props: { shadowOffsetX: 7 },
				},
			]),
		{ code: 'SERIALIZATION_FAILED' },
	);
});

test('new packages and components preserve effective publishing defaults on roundtrip', async (t) => {
	const { fs } = await fixture();
	const snapshot = await captureProjectSnapshot(fs, '/project/project.fairy');
	const result = await prepareSnapshotEdits(snapshot, [
		{ op: 'create', target: { kind: 'package' }, props: { name: 'Widgets' }, clientRef: 'widgets' },
		{
			op: 'create',
			target: { kind: 'component', packageId: '@widgets' },
			props: { name: 'Dialog', width: 640, height: 360 },
			clientRef: 'dialog',
		},
	]);
	const pkg = (await result.snapshot.readDocument())
		.getRoot()
		.listPackages()
		.find((item) => item.getName() === 'Widgets')!;
	t.is(pkg.getPublishName(), 'Widgets');
	t.is(pkg.listComponents()[0]!.getWidth(), 640);
	t.is(result.changes.length, 2);
});

test('prepared resource imports, replacements and renames carry source bytes and inbox consumption', async (t) => {
	const { fs } = await fixture();
	let source = await captureProjectSnapshot(fs, '/project/project.fairy');
	source = await source.withChanges([
		{ relativePath: '.fairygui-mcp/import-inbox/data.bin', content: new Uint8Array([1, 2, 3]) },
	]);
	const imported = await prepareSnapshotEdits(source, [
		{
			op: 'import',
			target: { kind: 'resource', packageId: 'package1' },
			inboxPath: 'data.bin',
			props: { name: 'Data', path: '/Data/' },
			clientRef: 'asset',
		},
	]);
	t.deepEqual(
		await imported.snapshot.fileSystem().readFileRaw('/project/assets/UI/Data/Data.bin'),
		new Uint8Array([1, 2, 3]),
	);
	t.false(await imported.snapshot.fileSystem().exists('/project/.fairygui-mcp/import-inbox/data.bin'));
	t.true(await source.fileSystem().exists('/project/.fairygui-mcp/import-inbox/data.bin'));
	const target = imported.clientRefs.asset!;
	const renamed = await prepareSnapshotEdits(imported.snapshot, [
		{ op: 'update', target, props: { name: 'Renamed', path: '/' } },
	]);
	t.false(await renamed.snapshot.fileSystem().exists('/project/assets/UI/Data/Data.bin'));
	t.deepEqual(
		await renamed.snapshot.fileSystem().readFileRaw('/project/assets/UI/Renamed.bin'),
		new Uint8Array([1, 2, 3]),
	);
	const replacement = await renamed.snapshot.withChanges([
		{ relativePath: '.fairygui-mcp/import-inbox/new.dat', content: new Uint8Array([4]) },
	]);
	const replaced = await prepareSnapshotEdits(replacement, [{ op: 'replace', target, inboxPath: 'new.dat' }]);
	t.deepEqual(
		await replaced.snapshot.fileSystem().readFileRaw('/project/assets/UI/Renamed.dat'),
		new Uint8Array([4]),
	);
	t.false(await replaced.snapshot.fileSystem().exists('/project/assets/UI/Renamed.bin'));
	const removed = await prepareSnapshotEdits(replaced.snapshot, [{ op: 'remove', target }]);
	t.false(await removed.snapshot.fileSystem().exists('/project/assets/UI/Renamed.dat'));
});
