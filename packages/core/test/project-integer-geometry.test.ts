import test from 'ava';
import { Document, serializeProjectFiles, setAuthoringProperties } from '../src/index.js';
import { authoringPropertySchema } from '../src/authoring/schema.js';
import { editComponentXml } from '../src/authoring/xml-fragment-edit.js';

const factories = [
	'createGImage', 'createGGraph', 'createGGroup', 'createGLoader', 'createGLoader3D',
	'createGMovieClip', 'createGTextField', 'createGRichTextField', 'createGTextInput',
	'createGList', 'createGTree', 'createGComponent', 'createGButton', 'createGLabel',
	'createGComboBox', 'createGProgressBar', 'createGSlider', 'createGScrollBar',
] as const;

function fixture() {
	const document = new Document();
	const pkg = document.createPackage('UI').setId('package1');
	const component = document.createComponent('Panel').setId('panel').setSize(300, 200);
	pkg.addResource(component);
	return { document, component };
}

for (const factory of factories) {
	test(`${factory}: authoring and project output require integer geometry`, async (t) => {
		const { document, component } = fixture();
		const node = document[factory]('child').setId('n0').setXY(-10, 20).setSize(125, 64);
		component.addChild(node);
		const schema = authoringPropertySchema(node);
		for (const key of ['x', 'y', 'width', 'height']) {
			t.deepEqual(schema.properties?.[key]?.type, ['integer', 'null']);
			t.throws(() => setAuthoringProperties(node, { [key]: 817.5 }), { code: 'INVALID_PROPERTY' });
			t.throws(() => setAuthoringProperties(node, { [key]: 2147483648 }), { code: 'INVALID_PROPERTY' });
		}
		const files = await serializeProjectFiles(document);
		t.regex(files.find((file) => file.kind === 'component')!.content, /xy="-10,20"/);
		for (const value of [817.5, -0.5, 2147483648, -2147483649, Infinity, NaN]) {
			node.setXY(value, 20);
			await t.throwsAsync(serializeProjectFiles(document), { instanceOf: RangeError, message: /xy/ });
		}
		node.setXY(-2147483648, 2147483647);
		await t.notThrowsAsync(serializeProjectFiles(document));
		node.setSize(125.5, 64);
		await t.throwsAsync(serializeProjectFiles(document), { instanceOf: RangeError, message: /size/ });
	});
}

test('component dimensions and size constraints use integer pixels', async (t) => {
	const { document, component } = fixture();
	for (const key of ['width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight']) {
		t.throws(() => setAuthoringProperties(component, { [key]: 0.5 }), { code: 'INVALID_PROPERTY' });
		t.is(authoringPropertySchema(component).properties?.[key]?.minimum, 0);
	}
	component.setSize(300.5, 200);
	await t.throwsAsync(serializeProjectFiles(document), { instanceOf: RangeError, message: /size/ });
	component.setSize(300, 200).setMinWidth(0.5);
	await t.throwsAsync(serializeProjectFiles(document), { instanceOf: RangeError, message: /restrictSize/ });
});

test('floating point transforms and opacity remain available alongside integer geometry', async (t) => {
	const { document, component } = fixture();
	const node = document.createGLoader('icon').setId('n0');
	component.addChild(node);
	setAuthoringProperties(node, { x: -10, y: 20, width: 125, height: 64,
		pivotX: 0.5, pivotY: 0.25, scaleX: 0.75, scaleY: 1.25, alpha: 0.5, rotation: 12.5 });
	const xml = (await serializeProjectFiles(document)).find((file) => file.kind === 'component')!.content;
	for (const attribute of ['pivot="0.5,0.25"', 'scale="0.75,1.25"', 'alpha="0.5"', 'rotation="12.5"'])
		t.true(xml.includes(attribute), attribute);
	setAuthoringProperties(node, { x: null });
	t.is(node.getX(), 0);
});

test('XML edits validate native geometry without interpreting extension attributes', (t) => {
	const source = '<component size="300,200"><displayList><loader id="n0" xy="10,20"/></displayList></component>';
	const target = { kind: 'component' as const, packageId: 'package1', componentId: 'panel' };
	for (const [attribute, value] of [
		['xy', '817.5,417.5'], ['xy', '1e2,0'], ['xy', 'NaN,0'], ['xy', '2147483648,0'],
		['size', '125.5,125'], ['size', '1,2,3'], ['restrictSize', '0,100.5,0,100'],
	]) {
		t.throws(() => editComponentXml(source, { op: 'xml', action: 'insert', target,
			xml: `<graph id="new" ${attribute}="${value}"/>` }), { code: 'INVALID_XML' });
	}
	t.throws(() => editComponentXml(source, { op: 'xml', action: 'attributes',
		target: { ...target, kind: 'node', nodeId: 'n0' }, attributes: { xy: '817.5,417.5' } }), { code: 'INVALID_XML' });
	t.throws(() => editComponentXml(source, { op: 'xml', action: 'replace', target,
		xml: '<component size="300.5,200"/>' }), { code: 'INVALID_XML' });
	t.notThrows(() => editComponentXml(source, { op: 'xml', action: 'insert', target,
		xml: '<loader id="new" xy="-10,20" size="125,125" pivot="0.5,0.5"/><vendor size="0.5,0.5"/>' }));
});
