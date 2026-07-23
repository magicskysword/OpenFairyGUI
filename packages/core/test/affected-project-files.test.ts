import test from 'ava';
import {
	Document,
	serializeAffectedProjectFiles,
	serializeProjectFiles,
} from '../src/index.js';

function createDocument(): Document {
	const doc = new Document();
	doc.getRoot()
		.setProjectId('affected-project')
		.setProjectType(0)
		.setVersion('3.0')
		.setSettings({ publish: { binaryFormat: true }, common: {}, adaptation: {} });

	const firstPackage = doc.createPackage('First').setId('first001');
	const firstComponent = doc.createComponent('Main')
		.setId('main1')
		.setPath('/views/')
		.setSize(200, 100);
	firstComponent.addChild(
		doc.createGTextField('title')
			.setId('n0')
			.setText('first')
			.setSize(80, 20),
	);
	firstPackage.addResource(firstComponent);

	const secondPackage = doc.createPackage('Second').setId('second01');
	const secondComponent = doc.createComponent('Panel')
		.setId('panel')
		.setPath('/')
		.setSize(300, 120);
	secondPackage.addResource(secondComponent);

	return doc;
}

test('serializeProjectFiles emits logical POSIX paths without touching disk', async (t) => {
	const files = await serializeProjectFiles(createDocument());
	const paths = files.map((file) => file.relativePath);

	t.true(paths.includes('project.fairy'));
	t.true(paths.includes('settings/Publish.json'));
	t.true(paths.includes('assets/First/package.xml'));
	t.true(paths.includes('assets/First/views/Main.xml'));
	t.true(paths.includes('assets/Second/Panel.xml'));
	t.false(paths.some((filePath) => filePath.includes('\\')));
});

test('serializeAffectedProjectFiles returns only requested complete files', async (t) => {
	const files = await serializeAffectedProjectFiles(createDocument(), [
		{ kind: 'component', packageId: 'first001', componentId: 'main1' },
		{ kind: 'package', packageId: 'second01' },
	]);

	t.deepEqual(
		files.map((file) => ({ kind: file.kind, path: file.relativePath })),
		[
			{ kind: 'component', path: 'assets/First/views/Main.xml' },
			{ kind: 'package', path: 'assets/Second/package.xml' },
		],
	);
	t.regex(files[0]?.content ?? '', /text="first"/);
	t.regex(files[1]?.content ?? '', /id="second01"/);
});

test('serializeAffectedProjectFiles deduplicates identical targets in caller order', async (t) => {
	const files = await serializeAffectedProjectFiles(createDocument(), [
		{ kind: 'project' },
		{ kind: 'component', packageId: 'first001', componentId: 'main1' },
		{ kind: 'project' },
		{ kind: 'component', packageId: 'first001', componentId: 'main1' },
	]);

	t.deepEqual(files.map((file) => file.relativePath), [
		'project.fairy',
		'assets/First/views/Main.xml',
	]);
});

test('serializeAffectedProjectFiles rejects unknown package and component ids', async (t) => {
	await t.throwsAsync(
		() => serializeAffectedProjectFiles(createDocument(), [
			{ kind: 'package', packageId: 'missing' },
		]),
		{ message: /Unknown FairyGUI package id "missing"/ },
	);
	await t.throwsAsync(
		() => serializeAffectedProjectFiles(createDocument(), [
			{ kind: 'component', packageId: 'first001', componentId: 'missing' },
		]),
		{ message: /Unknown component id "missing"/ },
	);
});
