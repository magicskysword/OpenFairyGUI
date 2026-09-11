import test from 'ava';
import { Document, GearType, PropertyType } from '../src/index.js';
import { applyDocumentEdits, cloneDocument, readAuthoringProperties } from '../src/authoring/document-edit.js';

function fixture() {
	const document = new Document();
	const pkg = document.createPackage('UI').setId('package1');
	const component = document.createComponent('Panel').setId('panel').setSize(300, 200);
	pkg.addResource(component);
	component.addChild(document.createGTextField('title').setId('n0').setText('Title').setXY(5, 10));
	component.setExtras({ opaque: { value: [1, 2] } });
	return { document, component };
}

test('document copies preserve opaque data and isolate graph references', (t) => {
	const { document, component } = fixture();
	const copy = cloneDocument(document);
	const cloned = copy.getRoot().getPackageById('package1')!.listComponents()[0]!;
	cloned.getChildById('n0')!.setName('other');
	(cloned.getExtras().opaque as { value: number[] }).value.push(3);
	t.is(component.getChildById('n0')!.getName(), 'title');
	t.deepEqual(component.getExtras(), { opaque: { value: [1, 2] } });
	t.not(copy.getGraph(), document.getGraph());
});

test('native edits preserve source input and use native property names', (t) => {
	const { document, component } = fixture();
	const result = applyDocumentEdits(document, [
		{
			op: 'update',
			target: { kind: 'node', packageId: 'package1', componentId: 'panel', nodeId: 'n0' },
			props: { x: 20, alpha: 0.5, text: 'Updated' },
		},
	]);
	t.is(
		readAuthoringProperties(
			result.document.getRoot().getPackageById('package1')!.listComponents()[0]!.getChildById('n0')!,
		).x,
		20,
	);
	t.is(readAuthoringProperties(component.getChildById('n0')!).x, 5);
	t.deepEqual(result.affected, [{ kind: 'component', packageId: 'package1', componentId: 'panel' }]);
});

test('create operations allocate ids and resolve references within a batch', (t) => {
	const { document } = fixture();
	const result = applyDocumentEdits(document, [
		{
			op: 'create',
			target: { kind: 'node', packageId: 'package1', componentId: 'panel' },
			type: 'GGraph',
			clientRef: 'box',
			props: { name: 'box', width: 100, height: 20 },
		},
		{
			op: 'update',
			target: { kind: 'node', packageId: 'package1', componentId: 'panel', nodeId: '@box' },
			props: { x: 50 },
		},
	]);
	t.is(result.clientRefs.box?.nodeId, 'n1');
	t.is(
		readAuthoringProperties(
			result.document.getRoot().getPackageById('package1')!.listComponents()[0]!.getChildById('n1')!,
		).x,
		50,
	);
});

test('controlled properties require an explicit edit scope', (t) => {
	const { document, component } = fixture();
	const controller = document.createController('state');
	controller.addPage(document.createControllerPage('up').setId('0'));
	component.addController(controller);
	component
		.getChildById('n0')!
		.addGear(
			document
				.createGear('xy')
				.setGearType(GearType.XY)
				.setController(controller)
				.setPages('0')
				.setValues('5,10'),
		);
	const target = { kind: 'node' as const, packageId: 'package1', componentId: 'panel', nodeId: 'n0' };
	t.throws(() => applyDocumentEdits(document, [{ op: 'update', target, props: { x: 20 } }]), {
		code: 'GEAR_SCOPE_REQUIRED',
	});
	const result = applyDocumentEdits(document, [
		{ op: 'update', target, scope: { controller: 'state', pageId: '0' }, props: { x: 20 } },
	]);
	const node = result.document.getRoot().getPackageById('package1')!.listComponents()[0]!.getChildById('n0')!;
	t.is(node.listGears()[0]!.getValues(), '20,10');
	t.is(readAuthoringProperties(node).x, 5);
});

test('removal rejects dependencies and supports explicit cascades', (t) => {
	const { document, component } = fixture();
	component.setMask('n0');
	const target = { kind: 'node' as const, packageId: 'package1', componentId: 'panel', nodeId: 'n0' };
	t.throws(() => applyDocumentEdits(document, [{ op: 'remove', target }]), { code: 'DEPENDENCY_EXISTS' });
	const result = applyDocumentEdits(document, [{ op: 'remove', target, cascade: true }]);
	t.is(result.document.getRoot().getPackageById('package1')!.listComponents()[0]!.getMask(), '');
	t.is(component.getMask(), 'n0');
});

test('invalid properties and identities fail without changing the source', (t) => {
	const { document, component } = fixture();
	const target = { kind: 'node' as const, packageId: 'package1', componentId: 'panel', nodeId: 'n0' };
	for (const props of [{ id: 'other' }, { x: '20px' }, { alpha: 2 }, { notAProperty: true }, { width: -1 }]) {
		t.throws(() => applyDocumentEdits(document, [{ op: 'update', target, props }]));
	}
	t.is(component.getChildById('n0')!.getId(), 'n0');
});

test('replacement preserves identity and validates inbound reference types', (t) => {
	const { document } = fixture();
	const target = { kind: 'node' as const, packageId: 'package1', componentId: 'panel', nodeId: 'n0' };
	const result = applyDocumentEdits(document, [
		{ op: 'replace', target, type: 'GGraph', props: { name: 'box', width: 40, height: 20 } },
	]);
	const node = result.document.getRoot().getPackageById('package1')!.listComponents()[0]!.getChildById('n0')!;
	t.is(node.propertyType, PropertyType.G_GRAPH);
	t.is(node.getName(), 'box');
});

test('component cloning remaps local identities while retaining resource references', (t) => {
	const { document, component } = fixture();
	component.addChild(
		document
			.createGGraph('box')
			.setId('custom')
			.setRelations([{ target: 'n0', type: 0, usePercent: false }]),
	);
	component.setMask('custom');
	const result = applyDocumentEdits(document, [
		{
			op: 'clone',
			target: { kind: 'component', packageId: 'package1', componentId: 'panel' },
			props: { name: 'Copy' },
			clientRef: 'copy',
		},
	]);
	const copied = result.document
		.getRoot()
		.getPackageById('package1')!
		.listComponents()
		.find((c) => c.getId() === result.clientRefs.copy?.componentId)!;
	t.not(copied.getId(), 'panel');
	t.is(copied.getMask(), 'n1');
	t.is(copied.getChildById('n1')!.getRelations()[0]!.target, 'n0');
	t.is(component.getMask(), 'custom');
});

test('controller, gear and transition creation survive serialization', async (t) => {
	const { serializeAffectedProjectFiles } = await import('../src/index.js');
	const { document } = fixture();
	const common = { packageId: 'package1', componentId: 'panel' };
	const result = applyDocumentEdits(document, [
		{ op: 'create', target: { ...common, kind: 'controller' }, props: { name: 'state' } },
		{ op: 'create', target: { ...common, kind: 'page', controllerName: 'state' }, props: { name: 'up' } },
		{
			op: 'create',
			target: { ...common, kind: 'gear', nodeId: 'n0', controllerName: 'state' },
			props: { gearType: 1, pages: '0', values: '5,10' },
		},
		{ op: 'create', target: { ...common, kind: 'transition' }, props: { name: 'enter' } },
		{
			op: 'create',
			target: { ...common, kind: 'transition-item', transitionName: 'enter' },
			props: { targetId: 'n0', actionType: 5, startValue: [0], endValue: [90], tween: true, duration: 0.5 },
		},
	]);
	const files = await serializeAffectedProjectFiles(result.document, result.affected);
	t.true(files[0]!.content.includes('<controller name="state"'));
	t.true(files[0]!.content.includes('<gearXY'));
	t.true(files[0]!.content.includes('target="n0"'));
});
