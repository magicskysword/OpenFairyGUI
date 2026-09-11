import test from 'ava';
import {
	Document,
	GearType,
	TransitionActionType,
	ControllerActionType,
	applyDocumentEdits,
	buildProjectReferenceGraph,
} from '../src/index.js';

function fixture() {
	const document = new Document();
	const pkg = document.createPackage('UI').setId('package1');
	const component = document.createComponent('Panel').setId('panel');
	pkg.addResource(component);
	const node = document.createGTextField('title').setId('n0');
	component.addChild(node);
	const controller = document.createController('mode');
	component.addController(controller);
	for (const id of ['a', 'b']) controller.addPage(document.createControllerPage(id).setId(id));
	return { document, pkg, component, node, controller };
}

test('page dependencies include source controller overrides and related button pages', (t) => {
	const f = fixture();
	const host = f.document.createComponent('Host').setId('host');
	f.pkg.addResource(host);
	const instance = f.document
		.createGComponent('instance')
		.setId('instance')
		.setSrc('panel')
		.setControllerOverrides('mode,a');
	host.addChild(instance);
	f.component.addChild(
		f.document.createGComponent('button').setId('button').setInstanceController('mode').setInstancePage('a'),
	);
	const target = {
		kind: 'page' as const,
		packageId: 'package1',
		componentId: 'panel',
		controllerName: 'mode',
		pageId: 'a',
	};
	t.throws(() => applyDocumentEdits(f.document, [{ op: 'remove', target }]), { code: 'DEPENDENCY_EXISTS' });
	const result = applyDocumentEdits(f.document, [{ op: 'remove', target, cascade: true }]);
	const components = result.document.getRoot().listPackages()[0]!.listComponents();
	t.is((components.find((c) => c.getId() === 'host')!.getChildById('instance') as any).getControllerOverrides(), '');
	t.is((components.find((c) => c.getId() === 'panel')!.getChildById('button') as any).getInstancePage(), '');
	t.deepEqual(buildProjectReferenceGraph(result.document).diagnostics, []);
});

test('historical errors block edits only when their component scope is affected', (t) => {
	const f = fixture();
	f.component.setMask('missing');
	const other = f.document.createComponent('Other').setId('other');
	f.pkg.addResource(other);
	t.notThrows(() =>
		applyDocumentEdits(f.document, [
			{
				op: 'update',
				target: { kind: 'component', packageId: 'package1', componentId: 'other' },
				props: { width: 100 },
			},
		]),
	);
	t.throws(
		() =>
			applyDocumentEdits(f.document, [
				{
					op: 'update',
					target: { kind: 'node', packageId: 'package1', componentId: 'panel', nodeId: 'n0' },
					props: { x: 10 },
				},
			]),
		{ code: 'REFERENCE_VALIDATION_FAILED' },
	);
});
test('page cascading preserves other Gear pages and removes each controller action once', (t) => {
	const f = fixture();
	f.node.addGear(
		f.document
			.createGear()
			.setGearType(GearType.XY)
			.setController(f.controller)
			.setPages('a,b')
			.setValues('1,2|3,4')
			.setPageValues({ a: '1,2', b: '3,4' }),
	);
	const transition = f.document.createTransition('enter');
	f.component.addTransition(transition);
	f.controller.addAction(
		f.document
			.createControllerAction()
			.setActionType(ControllerActionType.PlayTransition)
			.setTransitionName('enter')
			.setFromPage(['a'])
			.setToPage(['a']),
	);
	f.controller.addAction(
		f.document
			.createControllerAction()
			.setActionType(ControllerActionType.PlayTransition)
			.setTransitionName('enter')
			.setFromPage(['b']),
	);
	const result = applyDocumentEdits(f.document, [
		{
			op: 'remove',
			target: { kind: 'page', packageId: 'package1', componentId: 'panel', controllerName: 'mode', pageId: 'a' },
			cascade: true,
		},
	]);
	const component = result.document.getRoot().listPackages()[0]!.listComponents()[0]!;
	t.is(component.getChildById('n0')!.listGears().length, 1);
	t.is(component.getChildById('n0')!.listGears()[0]!.getPages(), 'b');
	t.is(component.getChildById('n0')!.listGears()[0]!.getValues(), '3,4');
	t.deepEqual(component.getChildById('n0')!.listGears()[0]!.getPageValues(), { b: '3,4' });
	t.is(component.getController('mode')!.listActions().length, 1);
	t.deepEqual(component.getController('mode')!.listActions()[0]!.getFromPage(), ['b']);
});

test('package removal traverses external resource dependencies and their local dependents', (t) => {
	const f = fixture();
	const assets = f.document.createPackage('Assets').setId('assets01');
	assets.addResource(f.document.createImageResource('Icon').setId('icon1'));
	const image = f.document.createGImage('icon').setId('n1').setPackageId('assets01').setSrc('icon1');
	f.component.addChild(image);
	f.node.setRelations([{ target: 'n1', type: 0, usePercent: false }]);
	f.component.setMask('n1');
	const operation = { op: 'remove' as const, target: { kind: 'package' as const, packageId: 'assets01' } };
	t.throws(() => applyDocumentEdits(f.document, [operation]), { code: 'DEPENDENCY_EXISTS' });
	const result = applyDocumentEdits(f.document, [{ ...operation, cascade: true }]);
	const component = result.document.getRoot().listPackages()[0]!.listComponents()[0]!;
	t.falsy(component.getChildById('n1'));
	t.is(component.getMask(), '');
	t.deepEqual(component.getChildById('n0')!.getRelations(), []);
	t.deepEqual(buildProjectReferenceGraph(result.document).diagnostics, []);
});

test('resource references validate native type and expose clearable Gear and Transition owners', (t) => {
	const f = fixture();
	f.pkg.addResource(f.document.createSoundResource('Sound').setId('sound'));
	f.component.addChild(f.document.createGImage('bad').setId('n1').setSrc('sound'));
	t.true(buildProjectReferenceGraph(f.document).diagnostics.some((item) => item.code === 'REFERENCE_TYPE_MISMATCH'));
	f.component.removeChild(f.component.getChildById('n1')!);
	f.node.addGear(
		f.document
			.createGear()
			.setController(f.controller)
			.setGearType(GearType.Icon)
			.setPages('a')
			.setValues('ui://package1sound')
			.setDefaultValue('ui://package1sound'),
	);
	const transition = f.document.createTransition('sound');
	f.component.addTransition(transition);
	transition.addItem(
		f.document
			.createTransitionItem()
			.setActionType(TransitionActionType.Sound)
			.setStartValue(['ui://package1sound', 1]),
	);
	const result = applyDocumentEdits(f.document, [
		{ op: 'remove', target: { kind: 'resource', packageId: 'package1', resourceId: 'sound' }, cascade: true },
	]);
	const component = result.document.getRoot().listPackages()[0]!.listComponents()[0]!;
	t.is(component.getTransition('sound')!.listItems().length, 0);
	t.is(component.getChildById('n0')!.listGears().length, 0);
});
