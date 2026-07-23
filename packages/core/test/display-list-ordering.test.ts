import test from 'ava';
import { Document } from '../src/index.js';

function createFixture() {
	const doc = new Document();
	const component = doc.createComponent('Host');
	const a = doc.createGTextField('a').setId('n0');
	const b = doc.createGTextField('b').setId('n1');
	const c = doc.createGTextField('c').setId('n2');
	component.addChild(a).addChild(b).addChild(c);
	return { doc, component, a, b, c };
}

function ids(component: ReturnType<Document['createComponent']>): string[] {
	return component.listChildren().map((child) => child.getId());
}

test('insertChild inserts a new child at an explicit index', (t) => {
	const { doc, component } = createFixture();
	const inserted = doc.createGImage('inserted').setId('n3');

	component.insertChild(inserted, 1);

	t.deepEqual(ids(component), ['n0', 'n3', 'n1', 'n2']);
});

test('moveChild, swapChildren, and replaceChild preserve deterministic ordering', (t) => {
	const { doc, component, a, b, c } = createFixture();
	const replacement = doc.createGGraph('replacement').setId('n3');

	component.moveChild(c, 0);
	t.deepEqual(ids(component), ['n2', 'n0', 'n1']);

	component.swapChildren(a, b);
	t.deepEqual(ids(component), ['n2', 'n1', 'n0']);

	component.replaceChild(b, replacement);
	t.deepEqual(ids(component), ['n2', 'n3', 'n0']);
});

test('setChildrenOrder requires an exact unique id permutation', (t) => {
	const { component } = createFixture();

	component.setChildrenOrder(['n2', 'n0', 'n1']);
	t.deepEqual(ids(component), ['n2', 'n0', 'n1']);

	const before = ids(component);
	t.throws(() => component.setChildrenOrder(['n2', 'n0']), { message: /exactly/ });
	t.throws(() => component.setChildrenOrder(['n2', 'n0', 'missing']), { message: /unknown child id/ });
	t.throws(() => component.setChildrenOrder(['n2', 'n2', 'n0']), { message: /duplicate child id/ });
	t.deepEqual(ids(component), before, 'failed reorders must not mutate the display list');
});

test('ordered editing rejects invalid targets before mutation', (t) => {
	const { doc, component, a } = createFixture();
	const outsider = doc.createGTextField('outsider').setId('n9');
	const before = ids(component);

	t.throws(() => component.insertChild(outsider, -1), { message: /index/ });
	t.throws(() => component.insertChild(a, 0), { message: /already belongs/ });
	t.throws(() => component.moveChild(outsider, 0), { message: /does not belong/ });
	t.throws(() => component.moveChild(a, 3), { message: /index/ });
	t.throws(() => component.swapChildren(a, outsider), { message: /does not belong/ });
	t.throws(() => component.replaceChild(outsider, a), { message: /does not belong/ });
	t.deepEqual(ids(component), before);
});

test('component generateChildId delegates to numeric n-prefix allocation', (t) => {
	const { doc, component } = createFixture();
	component.addChild(doc.createGTextField('legacy').setId('custom-child'));
	component.addChild(doc.createGTextField('high').setId('n12'));

	t.is(component.generateChildId(), 'n13');
});
