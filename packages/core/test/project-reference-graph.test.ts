import test from 'ava';
import { Document, GearType, TransitionActionType } from '../src/index.js';
import { buildProjectReferenceGraph, compareProjectDiagnostics } from '../src/references/project-reference-graph.js';

function fixture() {
	const document = new Document();
	const pkg = document.createPackage('UI').setId('package1');
	const component = document.createComponent('Panel').setId('panel');
	pkg.addResource(component);
	const target = document.createGGraph('target').setId('n0');
	const label = document.createGTextField('label').setId('n1');
	component.addChild(target).addChild(label);
	const controller = document.createController('state');
	controller.addPage(document.createControllerPage('open').setId('0'));
	component.addController(controller);
	label.addGear(
		document.createGear('visibility').setGearType(GearType.Display).setController(controller).setPages('0'),
	);
	const transition = document.createTransition('enter');
	transition.addItem(
		document.createTransitionItem('rotation').setActionType(TransitionActionType.Rotation).setTargetId('n0'),
	);
	component.addTransition(transition);
	return { document, pkg, component, target, label, controller, transition };
}

test('reference graph indexes local transition and gear dependencies', (t) => {
	const { document } = fixture();
	const graph = buildProjectReferenceGraph(document);
	t.deepEqual(graph.diagnostics, []);
	t.is(graph.find({ kind: 'node', packageId: 'package1', componentId: 'panel', id: 'n0' })[0]?.field, 'targetId');
	t.is(
		graph.find({ kind: 'page', packageId: 'package1', componentId: 'panel', controller: 'state', id: '0' }).length,
		1,
	);
});

test('missing transition targets and controller pages are validation errors', (t) => {
	const { document, component, target, controller } = fixture();
	component.removeChild(target);
	controller.removePage(controller.listPages()[0]!);
	const diagnostics = buildProjectReferenceGraph(document).diagnostics;
	t.true(diagnostics.some((d) => d.code === 'BROKEN_NODE_REFERENCE' && d.reference?.source.transition === 'enter'));
	t.true(diagnostics.some((d) => d.code === 'BROKEN_PAGE_REFERENCE'));
});

test('relations, mask and group references include type constraints', (t) => {
	const { document, component, label } = fixture();
	label.setRelations([{ target: 'absent', type: 0, usePercent: false }]);
	label.setGroup('n0');
	component.setMask('missing');
	const graph = buildProjectReferenceGraph(document);
	t.true(graph.diagnostics.some((d) => d.code === 'REFERENCE_TYPE_MISMATCH' && d.reference?.field === 'group'));
	t.is(graph.diagnostics.filter((d) => d.code === 'BROKEN_NODE_REFERENCE').length, 2);
});

test('reference comparison distinguishes existing and new diagnostics', (t) => {
	const { document, component, target, label } = fixture();
	component.removeChild(target);
	const before = buildProjectReferenceGraph(document).diagnostics;
	label.setRelations([{ target: 'missing', type: 0, usePercent: false }]);
	const result = compareProjectDiagnostics(before, buildProjectReferenceGraph(document).diagnostics);
	t.is(result.existing.length, 1);
	t.is(result.added.length, 1);
	t.deepEqual(result.resolved, []);
});

test('controller name collisions and invalid selection are diagnosed', (t) => {
	const { document, component, controller } = fixture();
	component.addController(document.createController('state'));
	controller.setSelectedIndex(10);
	const codes = buildProjectReferenceGraph(document).diagnostics.map((d) => d.code);
	t.true(codes.includes('DUPLICATE_CONTROLLER_NAME'));
	t.true(codes.includes('INVALID_CONTROLLER_SELECTION'));
});

test('cross-package resource references remain part of the graph', (t) => {
	const { document, component } = fixture();
	component.addChild(document.createGImage('image').setId('n2').setSrc('missing').setPackageId('another1'));
	const graph = buildProjectReferenceGraph(document);
	t.true(graph.diagnostics.some((d) => d.code === 'BROKEN_RESOURCE_REFERENCE'));
	t.is(graph.find({ kind: 'resource', packageId: 'another1', id: 'missing' }).length, 1);
});

test('empty relation and transition targets refer to their component owner', (t) => {
	const { document, label, transition } = fixture();
	label.setRelations([{ target: '', type: 0, usePercent: false }]);
	transition.listItems()[0]!.setTargetId('');
	t.deepEqual(buildProjectReferenceGraph(document).diagnostics, []);
});
