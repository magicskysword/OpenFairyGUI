import test from 'ava';
import {
	buildResourceReferenceIndex,
	Document,
	GearType,
	type ResourceReference,
} from '../src/index.js';

function createFixture(): {
	document: Document;
	targetPackageId: string;
	targetImageId: string;
	targetComponentId: string;
} {
	const document = new Document();
	const targetPackageId = 'target01';
	const sourcePackageId = 'source01';
	const targetImageId = 'img01';
	const targetComponentId = 'cmp01';

	const targetPackage = document.createPackage('Target').setId(targetPackageId);
	targetPackage.addResource(document.createImageResource('Hero').setId(targetImageId));
	targetPackage.addResource(document.createComponent('Card').setId(targetComponentId));

	const sourcePackage = document.createPackage('Source').setId(sourcePackageId);
	const sourceComponent = document.createComponent('Screen').setId('host1');
	sourcePackage.addResource(sourceComponent);

	sourceComponent.addChild(
		document.createGImage('hero')
			.setId('n0')
			.setSrc(targetImageId)
			.setPackageId(targetPackageId),
	);
	sourceComponent.addChild(
		document.createGComponent('card')
			.setId('n1')
			.setSrc(targetComponentId)
			.setPackageId(targetPackageId),
	);
	sourceComponent.addChild(
		document.createGLoader('loader')
			.setId('n2')
			.setUrl(`ui://${targetPackageId}${targetImageId}`),
	);

	const list = document.createGList('items')
		.setId('n3')
		.setDefaultItem(`ui://${targetPackageId}${targetComponentId}`)
		.setListItems([
			{
				title: 'Item',
				icon: `ui://${targetPackageId}${targetImageId}`,
				url: `ui://${targetPackageId}${targetComponentId}`,
				name: null,
				selectedTitle: null,
				selectedIcon: null,
				level: 0,
				isFolder: null,
			},
		]);
	sourceComponent.addChild(list);

	const text = document.createGTextField('label')
		.setId('n4')
		.setFont(`ui://${targetPackageId}${targetImageId}`);
	const iconGear = document.createGear('icon')
		.setGearType(GearType.Icon)
		.setValues(`page0,ui://${targetPackageId}${targetImageId}`);
	text.addGear(iconGear);
	sourceComponent.addChild(text);

	return { document, targetPackageId, targetImageId, targetComponentId };
}

function fields(references: ResourceReference[]): string[] {
	return references.map((reference) => reference.source.field).sort();
}

test('resource reference index finds direct and ui URL references across packages', (t) => {
	const { document, targetPackageId, targetImageId } = createFixture();

	const index = buildResourceReferenceIndex(document);
	const references = index.find(targetPackageId, targetImageId);

	t.deepEqual(fields(references), [
		'font',
		'gear.values',
		'listItems[0].icon',
		'src',
		'url',
	]);
	t.deepEqual(
		references.map((reference) => reference.source.componentId),
		Array.from({ length: references.length }, () => 'host1'),
	);
});

test('resource reference index classifies safe and unsupported cascade actions', (t) => {
	const { document, targetPackageId, targetImageId, targetComponentId } = createFixture();
	const index = buildResourceReferenceIndex(document);

	const imageActions = new Map(
		index.find(targetPackageId, targetImageId)
			.map((reference) => [reference.source.field, reference.cascadeAction]),
	);
	t.is(imageActions.get('src'), 'remove-owner');
	t.is(imageActions.get('url'), 'clear-field');
	t.is(imageActions.get('font'), 'clear-field');
	t.is(imageActions.get('listItems[0].icon'), 'clear-field');
	t.is(imageActions.get('gear.values'), 'unsupported');

	t.deepEqual(
		fields(index.find(targetPackageId, targetComponentId)),
		['defaultItem', 'listItems[0].url', 'src'],
	);
});

test('resource reference index preserves reference provenance and ignores malformed URLs', (t) => {
	const { document, targetPackageId, targetImageId } = createFixture();
	const sourcePackage = document.getRoot().getPackageById('source01')!;
	const sourceComponent = sourcePackage.getResourceById('host1')!;
	const loader = (sourceComponent as { listChildren(): Array<{ setUrl(value: string): void }> })
		.listChildren()
		.find((child) => 'setUrl' in child)!;
	loader.setUrl('ui://short');

	const index = buildResourceReferenceIndex(document);
	const directReference = index.find(targetPackageId, targetImageId)
		.find((reference) => reference.source.field === 'src')!;

	t.like(directReference, {
		target: { packageId: targetPackageId, resourceId: targetImageId },
		source: {
			packageId: 'source01',
			resourceId: 'host1',
			componentId: 'host1',
			objectId: 'n0',
			ownerType: 'GImage',
			field: 'src',
		},
		value: targetImageId,
		cascadeAction: 'remove-owner',
	});
	t.false(index.list().some((reference) => reference.value === 'ui://short'));
});

