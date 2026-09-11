import test from 'ava';
import {
	AUTHORING_OPERATION_SCHEMA,
	assertAuthoringOperations,
	authoringPropertySchema,
} from '../src/authoring/schema.js';
import { Document, setAuthoringProperties } from '../src/index.js';

test('authoring contract validates operation envelopes and finite JSON values', (t) => {
	const operation = {
		op: 'update',
		target: { kind: 'node', packageId: 'p', componentId: 'c', nodeId: 'n0' },
		props: { x: 10, alpha: 0.5 },
	};
	t.notThrows(() => assertAuthoringOperations([operation]));
	for (const value of [
		{ ...operation, unused: true },
		{ ...operation, props: { x: Infinity } },
		{ ...operation, target: { ...operation.target, unused: true } },
	]) {
		t.throws(() => assertAuthoringOperations([value]), { code: 'INVALID_EDIT' });
	}
	t.throws(() => assertAuthoringOperations([]), { code: 'INVALID_EDIT' });
	t.throws(() => assertAuthoringOperations(Array(201).fill(operation)), { code: 'INVALID_EDIT' });
	t.deepEqual(
		AUTHORING_OPERATION_SCHEMA.oneOf?.map((schema) => schema.properties?.op?.const),
		['create', 'update', 'remove', 'move', 'replace', 'import', 'clone', 'xml'],
	);
});

test('authoring contract requires explicit selector counts and XML payloads', (t) => {
	const target = { kind: 'node', packageId: 'p', componentId: 'c', selector: 'GTextField' };
	t.throws(() => assertAuthoringOperations([{ op: 'update', target, props: {} }]), { code: 'INVALID_EDIT' });
	t.notThrows(() =>
		assertAuthoringOperations([{ op: 'update', target: { ...target, expectedMatches: 2 }, props: {} }]),
	);
	t.throws(
		() =>
			assertAuthoringOperations([
				{ op: 'xml', action: 'insert', target: { kind: 'component', packageId: 'p', componentId: 'c' } },
			]),
		{ code: 'INVALID_EDIT' },
	);
	t.notThrows(() =>
		assertAuthoringOperations([
			{
				op: 'xml',
				action: 'attributes',
				target: { kind: 'component', packageId: 'p', componentId: 'c' },
				attributes: { opaque: true },
			},
		]),
	);
});

test('property definitions use current native fields and reflect nullable values', (t) => {
	const schema = authoringPropertySchema(new Document().createGTextField('text'));
	t.deepEqual(schema.properties?.x?.type, ['number', 'null']);
	t.deepEqual(schema.properties?.text?.type, 'string');
	t.is(schema.properties?.alpha?.maximum, 1);
	t.is(schema.properties?.id, undefined);
	t.is(schema.additionalProperties, false);
});

test('native definitions and editing share enums, units and nullability', (t) => {
	const document = new Document();
	const gear = document.createGear();
	const schema = authoringPropertySchema(gear);
	t.deepEqual(schema.properties?.gearType?.enum, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, null]);
	t.true(schema.properties?.tweenDuration?.description?.includes('Seconds') ?? false);
	t.true(
		authoringPropertySchema(document.createTransitionItem()).properties?.duration?.description?.includes(
			'frames',
		) ?? false,
	);
	t.throws(() => setAuthoringProperties(gear, { gearType: 10 }), { code: 'INVALID_PROPERTY' });
	t.throws(() => setAuthoringProperties(document.createControllerAction(), { actionType: 3 }), {
		code: 'INVALID_PROPERTY',
	});
	t.notThrows(() => setAuthoringProperties(document.createGTextField(), { x: null }));
	t.notThrows(() => setAuthoringProperties(document.createGTextField(), { align: 1, vAlign: 2 }));
	t.deepEqual(authoringPropertySchema(document.createGTextField()).properties?.align?.enum, [0, 1, 2, null]);
});
