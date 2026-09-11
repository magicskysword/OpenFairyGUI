import test from 'ava';
import { editComponentXml } from '../src/authoring/xml-fragment-edit.js';

const source =
	'<component size="100,100" custom="kept"><displayList><text id="n3" name="title" xy="0,0" text="Hi"/><graph id="g" name="box" xy="0,0"/></displayList><transition name="enter"><item type="Rotation" target="n3" time="0"/></transition></component>';
const target = { kind: 'component' as const, packageId: 'package1', componentId: 'panel' };

test('XML fragment insertion allocates IDs and resolves forward local references', (t) => {
	const result = editComponentXml(source, {
		op: 'xml',
		action: 'insert',
		target,
		xml: '<text id="caption" name="caption" xy="0,0"><relation target="icon" sidePair="left-left"/></text><graph id="icon" name="icon" xy="0,0"/>',
	});
	t.deepEqual(result.idMap, { caption: 'n4', icon: 'n5' });
	t.true(result.xml.includes('target="n5"'));
	t.true(result.xml.includes('custom="kept"'));
	t.true(result.xml.includes('target="n3"'));
});

test('XML replacement preserves the existing target identity', (t) => {
	const result = editComponentXml(source, {
		op: 'xml',
		action: 'replace',
		target: { ...target, kind: 'node', nodeId: 'n3' },
		xml: '<graph id="local" name="replacement" xy="4,5"/>',
	});
	t.is(result.idMap.local, 'n3');
	t.true(result.xml.includes('id="n3"'));
	t.false(result.xml.includes('id="local"'));
});

test('attribute updates preserve nested structures and protect identities', (t) => {
	const result = editComponentXml(source, {
		op: 'xml',
		action: 'attributes',
		target: { ...target, kind: 'node', nodeId: 'n3' },
		attributes: { text: 'Updated', customFlag: 'value' },
	});
	t.true(result.xml.includes('text="Updated"'));
	t.true(result.xml.includes('<transition'));
	t.throws(() => editComponentXml(source, { op: 'xml', action: 'attributes', target, attributes: { id: 'other' } }));
});

test('unsafe XML, duplicate local labels and excessive nesting are rejected', (t) => {
	for (const xml of [
		'<!DOCTYPE x [<!ENTITY a SYSTEM "file:///secret">]><text/>',
		'<text id="same"/><text id="same"/>',
		'<node>'.repeat(70) + '</node>'.repeat(70),
		'<text>',
	]) {
		t.throws(() => editComponentXml(source, { op: 'xml', action: 'insert', target, xml }));
	}
});

test('external node bindings resolve without rewriting resource identifiers', (t) => {
	const result = editComponentXml(source, {
		op: 'xml',
		action: 'insert',
		target,
		bindings: { outside: 'n3' },
		xml: '<image id="icon" src="outside" name="icon" xy="0,0"><relation target="outside" sidePair="left-left"/></image>',
	});
	t.true(result.xml.includes('target="n3"'));
	t.true(result.xml.includes('src="outside"'));
});

test('component replacement retains existing node identities and allocates new nodes', (t) => {
	const result = editComponentXml(source, {
		op: 'xml',
		action: 'replace',
		target,
		xml: '<component size="80,80"><displayList><text id="n3" name="title"/><graph id="new" name="box"/></displayList><transition name="show"><item target="new" type="Rotation" time="0"/></transition></component>',
	});
	t.is(result.idMap.n3, 'n3');
	t.is(result.idMap.new, 'n4');
	t.true(result.xml.includes('target="n4"'));
});
