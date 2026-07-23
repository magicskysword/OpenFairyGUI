import test from 'ava';
import {
	generateChildId,
	generatePackageId,
	generateResourceId,
	generateUniqueId,
} from '../src/index.js';

function sequenceRandom(values: number[]): () => number {
	let index = 0;
	return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

test('generatePackageId creates an 8-character lowercase alphanumeric id', (t) => {
	const id = generatePackageId([], { random: () => 0 });

	t.is(id, 'aaaaaaaa');
	t.regex(id, /^[a-z0-9]{8}$/);
});

test('generateResourceId creates a 5-character lowercase alphanumeric id', (t) => {
	const id = generateResourceId([], { random: () => 0.999999 });

	t.is(id, '99999');
	t.regex(id, /^[a-z0-9]{5}$/);
});

test('generateUniqueId retries when a generated id conflicts', (t) => {
	const random = sequenceRandom([
		0, 0, 0, 0, 0,
		0.999999, 0.999999, 0.999999, 0.999999, 0.999999,
	]);

	const id = generateUniqueId(5, ['aaaaa'], { random });

	t.is(id, '99999');
});

test('generateUniqueId fails explicitly when the attempt budget is exhausted', (t) => {
	const error = t.throws(
		() => generateUniqueId(5, ['aaaaa'], { random: () => 0, maxAttempts: 2 }),
		{ instanceOf: Error },
	);

	t.regex(error.message, /Unable to generate a unique 5-character FairyGUI ID/);
});

test('generateChildId uses max numeric n-prefix plus one and preserves legacy ids', (t) => {
	t.is(generateChildId(['legacy', 'n0', 'n8', 'n2_suffix', 'child-10']), 'n9');
	t.is(generateChildId(['legacy', 'custom']), 'n0');
});

test('generateChildId rejects values beyond the safe integer range', (t) => {
	const error = t.throws(
		() => generateChildId([`n${Number.MAX_SAFE_INTEGER}`]),
		{ instanceOf: Error },
	);

	t.regex(error.message, /safe integer range/);
});
