import test from 'ava';
import {
	Document,
	GearType,
	applyDocumentEdits,
	buildProjectReferenceGraph,
	type AuthoringTarget,
} from '../src/index.js';

function fixture() {
	const document = new Document();
	const first = document.createPackage('First').setId('package1');
	const second = document.createPackage('Second').setId('package2');
	const source = document.createComponent('Source').setId('source');
	const destination = document.createComponent('Destination').setId('destination');
	first.addResource(source);
	second.addResource(destination);
	first.addResource(document.createImageResource('Icon').setId('icon').setFileName('Icon.png'));
	source.addChild(document.createGImage('image').setId('n0').setSrc('icon'));
	const target: AuthoringTarget = { kind: 'node', packageId: 'package1', componentId: 'source', nodeId: 'n0' };
	const into: AuthoringTarget = { kind: 'component', packageId: 'package2', componentId: 'destination' };
	return { document, source, destination, target, into };
}

test('cross-package clones retain relative resources and remap root relations', (t) => {
	const { document, source } = fixture();
	source.getChildById('n0')!.setId('custom');
	source.setRelations([{ target: 'custom', type: 0, usePercent: false }]);
	const result = applyDocumentEdits(document, [
		{
			op: 'clone',
			target: { kind: 'component', packageId: 'package1', componentId: 'source' },
			destination: { kind: 'package', packageId: 'package2' },
			props: { name: 'Copy' },
			clientRef: 'copy',
		},
	]);
	const copy = result.document
		.getRoot()
		.getPackageById('package2')!
		.listComponents()
		.find((c) => c.getId() === result.clientRefs.copy!.componentId)!;
	t.is(copy.getRelations()[0]!.target, 'n0');
	t.is((copy.listChildren()[0] as any).getPackageId(), 'package1');
	t.deepEqual(buildProjectReferenceGraph(result.document).diagnostics, []);
});

test('cross-component copies require explicit local mappings even when names coincide', (t) => {
	const { document, source, destination, target, into } = fixture();
	const oldController = document.createController('state');
	oldController.addPage(document.createControllerPage('old').setId('old'));
	const newController = document.createController('state');
	newController.addPage(document.createControllerPage('new').setId('new'));
	source.addController(oldController);
	destination.addController(newController);
	source.addChild(document.createGGroup('group').setId('group'));
	destination.addChild(document.createGGroup('group').setId('other'));
	(source.getChildById('n0') as any).setGroup('group');
	source
		.getChildById('n0')!
		.addGear(
			document
				.createGear()
				.setGearType(GearType.XY)
				.setController(oldController)
				.setPages('old')
				.setValues('10,20'),
		);
	t.throws(() => applyDocumentEdits(document, [{ op: 'clone', target, destination: into }]), {
		code: 'UNSAFE_REFERENCE',
	});
	const result = applyDocumentEdits(document, [
		{
			op: 'clone',
			target,
			destination: into,
			bindings: { nodes: { group: 'other' }, controllers: { state: 'state' }, pages: { 'state/old': 'new' } },
			clientRef: 'copy',
		},
	]);
	const dest = result.document.getRoot().getPackageById('package2')!.listComponents()[0]!;
	const copied = dest.getChildById(result.clientRefs.copy!.nodeId!)!;
	t.is(copied.listGears()[0]!.getController(), dest.getController('state'));
	t.is(copied.listGears()[0]!.getPages(), 'new');
	t.is((copied as any).getGroup(), 'other');
});

test('moving resources rewrites incoming local and URL references and reallocates collisions', (t) => {
	const { document, source, destination } = fixture();
	document
		.getRoot()
		.getPackageById('package2')!
		.addResource(document.createImageResource('Other').setId('icon').setFileName('Other.png'));
	destination.addChild(document.createGLoader().setId('loader').setUrl('ui://package1icon'));
	const result = applyDocumentEdits(document, [
		{
			op: 'move',
			target: { kind: 'resource', packageId: 'package1', resourceId: 'icon' },
			destination: { kind: 'package', packageId: 'package2' },
		},
	]);
	const moved = result.operationResults[0]!.targets[0]!;
	t.not(moved.resourceId, 'icon');
	const updated = result.document
		.getRoot()
		.getPackageById('package1')!
		.listComponents()[0]!
		.getChildById('n0') as any;
	t.is(updated.getPackageId(), 'package2');
	t.is(updated.getSrc(), moved.resourceId);
	const loader = result.document
		.getRoot()
		.getPackageById('package2')!
		.listComponents()[0]!
		.getChildById('loader') as any;
	t.is(loader.getUrl(), `ui://package2${moved.resourceId}`);
	t.true(result.affected.some((f) => f.kind === 'component' && f.componentId === source.getId()));
	t.deepEqual(buildProjectReferenceGraph(result.document).diagnostics, []);
});

test('node moves reject inbound dependencies and update both component sources', (t) => {
	const { document, source, target, into } = fixture();
	source.setMask('n0');
	t.throws(() => applyDocumentEdits(document, [{ op: 'move', target, destination: into }]), {
		code: 'DEPENDENCY_EXISTS',
	});
	source.setMask('');
	const result = applyDocumentEdits(document, [{ op: 'move', target, destination: into }]);
	t.is(result.document.getRoot().getPackageById('package1')!.listComponents()[0]!.listChildren().length, 0);
	t.true(result.affected.some((f) => f.kind === 'component' && f.componentId === 'source'));
	t.true(result.affected.some((f) => f.kind === 'component' && f.componentId === 'destination'));
});

test('batch properties resolve forward local references without rewriting ordinary text', (t) => {
	const { document } = fixture();
	const base = { packageId: 'package1', componentId: 'source' };
	const result = applyDocumentEdits(document, [
		{
			op: 'create',
			target: { ...base, kind: 'node' },
			type: 'GTextField',
			props: {
				name: 'label',
				text: '@group',
				group: '@group',
				relations: [{ target: '@group', type: 0, usePercent: false }],
			},
			clientRef: 'label',
		},
		{
			op: 'create',
			target: { ...base, kind: 'node' },
			type: 'GGroup',
			props: { name: 'group' },
			clientRef: 'group',
		},
	]);
	const label = result.document
		.getRoot()
		.getPackageById('package1')!
		.listComponents()[0]!
		.getChildById(result.clientRefs.label!.nodeId!) as any;
	t.is(label.getGroup(), result.clientRefs.group!.nodeId);
	t.is(label.getRelations()[0]!.target, result.clientRefs.group!.nodeId);
	t.is(label.getText(), '@group');
});
