import test from 'ava';
import {
	Document,
	inspectProjectOutputConflicts,
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

function addUnrelatedImageOutputConflict(doc: Document): void {
	const pkg = doc.getRoot().getPackageById('second01');
	if (!pkg) throw new Error('missing Second package');

	pkg.addResource(
		doc.createImageResource('CollisionFirst')
			.setId('image-a')
			.setFileName('collision.png')
			.setPath('/images/'),
	);
	pkg.addResource(
		doc.createImageResource('CollisionSecond')
			.setId('image-b')
			.setFileName('collision.png')
			.setPath('/images/'),
	);
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

test('serializeAffectedProjectFiles ignores output conflicts unrelated to requested files', async (t) => {
	const doc = createDocument();
	addUnrelatedImageOutputConflict(doc);

	const files = await serializeAffectedProjectFiles(doc, [
		{ kind: 'component', packageId: 'first001', componentId: 'main1' },
	]);

	t.deepEqual(files.map((file) => file.relativePath), [
		'assets/First/views/Main.xml',
	]);
	t.regex(files[0]?.content ?? '', /text="first"/);
});

test('serializeProjectFiles reports both producers for a complete-project output conflict', async (t) => {
	const doc = createDocument();
	addUnrelatedImageOutputConflict(doc);

	const error = await t.throwsAsync(() => serializeProjectFiles(doc)) as Error & {
		code?: string;
		packageId?: string;
		packageName?: string;
		outputPath?: string;
		first?: Record<string, unknown>;
		conflicting?: Record<string, unknown>;
	};

	t.is(error.code, 'PROJECT_OUTPUT_CONFLICT');
	t.is(error.packageId, 'second01');
	t.is(error.packageName, 'Second');
	t.is(error.outputPath, 'images/collision.png');
	t.like(error.first, {
		kind: 'resource',
		resourceId: 'image-a',
		resourceType: 'ImageResource',
		resourceName: 'CollisionFirst',
		resourcePath: '/images/',
	});
	t.like(error.conflicting, {
		kind: 'resource',
		resourceId: 'image-b',
		resourceType: 'ImageResource',
		resourceName: 'CollisionSecond',
		resourcePath: '/images/',
	});
});

test('inspectProjectOutputConflicts returns every producer pair without throwing', (t) => {
	const doc = createDocument();
	addUnrelatedImageOutputConflict(doc);
	const pkg = doc.getRoot().getPackageById('second01');
	if (!pkg) throw new Error('missing Second package');
	pkg.addResource(
		doc.createComponent('Duplicate')
			.setId('dup-a')
			.setPath('/views/'),
	);
	pkg.addResource(
		doc.createComponent('Duplicate')
			.setId('dup-b')
			.setPath('/views/'),
	);

	t.deepEqual(inspectProjectOutputConflicts(doc), [
		{
			packageId: 'second01',
			packageName: 'Second',
			branch: '',
			outputPath: 'images/collision.png',
			first: {
				kind: 'resource',
				packageId: 'second01',
				packageName: 'Second',
				branch: '',
				resourceId: 'image-a',
				resourceType: 'ImageResource',
				resourceName: 'CollisionFirst',
				resourcePath: '/images/',
			},
			conflicting: {
				kind: 'resource',
				packageId: 'second01',
				packageName: 'Second',
				branch: '',
				resourceId: 'image-b',
				resourceType: 'ImageResource',
				resourceName: 'CollisionSecond',
				resourcePath: '/images/',
			},
		},
		{
			packageId: 'second01',
			packageName: 'Second',
			branch: '',
			outputPath: 'views/Duplicate.xml',
			first: {
				kind: 'component',
				packageId: 'second01',
				packageName: 'Second',
				branch: '',
				resourceId: 'dup-a',
				resourceType: 'Component',
				resourceName: 'Duplicate',
				resourcePath: '/views/',
			},
			conflicting: {
				kind: 'component',
				packageId: 'second01',
				packageName: 'Second',
				branch: '',
				resourceId: 'dup-b',
				resourceType: 'Component',
				resourceName: 'Duplicate',
				resourcePath: '/views/',
			},
		},
	]);
});

test('serializeAffectedProjectFiles rejects a requested component whose own output is ambiguous', async (t) => {
	const doc = createDocument();
	const pkg = doc.getRoot().getPackageById('second01');
	if (!pkg) throw new Error('missing Second package');
	pkg.addResource(
		doc.createComponent('Duplicate')
			.setId('dup-a')
			.setPath('/views/'),
	);
	pkg.addResource(
		doc.createComponent('Duplicate')
			.setId('dup-b')
			.setPath('/views/'),
	);

	const error = await t.throwsAsync(() => serializeAffectedProjectFiles(doc, [
		{ kind: 'component', packageId: 'second01', componentId: 'dup-a' },
	])) as Error & {
		code?: string;
		outputPath?: string;
		first?: Record<string, unknown>;
		conflicting?: Record<string, unknown>;
	};

	t.is(error.code, 'PROJECT_OUTPUT_CONFLICT');
	t.is(error.outputPath, 'views/Duplicate.xml');
	t.like(error.first, {
		kind: 'component',
		resourceId: 'dup-a',
		resourceType: 'Component',
		resourceName: 'Duplicate',
		resourcePath: '/views/',
	});
	t.like(error.conflicting, {
		kind: 'component',
		resourceId: 'dup-b',
		resourceType: 'Component',
		resourceName: 'Duplicate',
		resourcePath: '/views/',
	});
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
