import test from 'ava';
import { readImageSize } from '../src/io/project-reader.js';

test('image import metadata recognizes WebP and SVG intrinsic dimensions', (t) => {
	const bytes = new Uint8Array(30);
	bytes.set(new TextEncoder().encode('RIFF'), 0);
	bytes.set(new TextEncoder().encode('WEBPVP8X'), 8);
	bytes[20] = 0;
	bytes[24] = 19;
	bytes[27] = 9;
	t.deepEqual(readImageSize(bytes), { width: 20, height: 10 });
	t.deepEqual(
		readImageSize(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"/>')),
		{ width: 32, height: 16 },
	);
	t.deepEqual(readImageSize(new TextEncoder().encode('<svg viewBox="0 0 80 40"/>')), { width: 80, height: 40 });
	t.is(readImageSize(new TextEncoder().encode('<!DOCTYPE svg><svg width="32" height="16"/>')), null);
});
import { Document, applyDocumentEdits, readAuthoringProperties, type MiscResource } from '../src/index.js';

function fixture() {
	const document = new Document();
	document.createPackage('UI').setId('package1');
	return document;
}
test('resource imports and binary replacements preserve identity and isolate source bytes', (t) => {
	const document = fixture();
	const data = new Uint8Array([1, 2, 3]);
	const result = applyDocumentEdits(
		document,
		[
			{
				op: 'import',
				target: { kind: 'resource', packageId: 'package1' },
				inboxPath: 'data.bin',
				props: { name: 'Data', path: '/Data/' },
				clientRef: 'asset',
			},
		],
		{ imports: new Map([['data.bin', { fileName: 'data.bin', data }]]) },
	);
	const ref = result.clientRefs.asset!;
	const resource = result.document
		.getRoot()
		.getPackageById('package1')!
		.getResourceById(ref.resourceId!)! as MiscResource;
	t.is(resource.getName(), 'Data');
	t.is(resource.getPath(), '/Data/');
	t.false('resourceData' in readAuthoringProperties(resource));
	t.is(document.getRoot().listPackages()[0]!.listResources().length, 0);
	data[0] = 9;
	t.deepEqual(resource.getSourceData()!.getData(), new Uint8Array([1, 2, 3]));
	const replaced = applyDocumentEdits(result.document, [{ op: 'replace', target: ref, inboxPath: 'new.dat' }], {
		imports: new Map([['new.dat', { fileName: 'new.dat', data: new Uint8Array([4]) }]]),
	});
	const next = replaced.document.getRoot().listPackages()[0]!.getResourceById(ref.resourceId!)! as MiscResource;
	t.is(next.getId(), resource.getId());
	t.is((next as { getFile(): string }).getFile(), 'Data.dat');
	t.deepEqual(next.getSourceData()!.getData(), new Uint8Array([4]));
});

test('resource imports reject collisions, unsafe paths and incompatible binary types', (t) => {
	const document = fixture();
	const imports = new Map([
		['data.bin', { fileName: 'data.bin', data: new Uint8Array([1]) }],
		['image.png', { fileName: 'image.png', data: new Uint8Array([2]) }],
	]);
	const result = applyDocumentEdits(
		document,
		[
			{
				op: 'import',
				target: { kind: 'resource', packageId: 'package1' },
				inboxPath: 'data.bin',
				props: { name: 'Data' },
				clientRef: 'asset',
			},
		],
		{ imports },
	);
	const resource = result.clientRefs.asset!;
	t.throws(
		() =>
			applyDocumentEdits(
				result.document,
				[
					{
						op: 'import',
						target: { kind: 'resource', packageId: 'package1' },
						inboxPath: 'data.bin',
						props: { name: 'Data' },
					},
				],
				{ imports },
			),
		{ code: 'RESOURCE_CONFLICT' },
	);
	t.throws(
		() =>
			applyDocumentEdits(result.document, [{ op: 'replace', target: resource, inboxPath: 'image.png' }], {
				imports,
			}),
		{ code: 'INVALID_PROPERTY' },
	);
	t.throws(
		() =>
			applyDocumentEdits(
				document,
				[
					{
						op: 'import',
						target: { kind: 'resource', packageId: 'package1' },
						inboxPath: 'data.bin',
						props: { name: '../Data' },
					},
				],
				{ imports },
			),
		{ code: 'INVALID_SOURCE_PATH' },
	);
});
