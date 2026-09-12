import test from 'ava';
import { Document } from '@openfairygui/core';
import { publish } from '../src/publish.js';
import { atlas } from '../src/atlas.js';

for (const transform of [publish, atlas]) {
	test(`${transform.name} includes images referenced by instance property overrides`, async (t) => {
		const doc = new Document();
		const pkg = doc.createPackage('UI').setId('props001');
		const main = doc.createComponent('Main').setId('main').setExported(true);
		pkg.addResource(main);
		main.addChild(
			doc
				.createGComponent('instance')
				.setId('instance')
				.setPropertyOverrides([{ target: 'icon', propertyId: 1, value: 'ui://props001image' }]),
		);
		main.addChild(
			doc
				.createGList('list')
				.setId('list')
				.setListItems([
					{
						title: null,
						icon: null,
						url: null,
						name: null,
						selectedTitle: null,
						selectedIcon: null,
						level: 0,
						isFolder: null,
						properties: [{ target: 'icon', propertyId: 1, value: 'ui://props001listicon' }],
					},
				]),
		);
		for (const id of ['image', 'listicon', 'unused'])
			pkg.addResource(doc.createImageResource(id).setId(id).setWidth(8).setHeight(8));
		await doc.transform(transform({}));
		t.deepEqual(
			pkg
				.listAtlases()
				.flatMap((page) => page.listSprites().map((sprite) => sprite.getItemId()))
				.sort(),
			['image', 'listicon'],
		);
		if (transform === publish)
			t.deepEqual((pkg.getExtras().publishedResourceIds as string[]).sort(), ['image', 'listicon', 'main']);
	});
}

test('publish records foreign packages referenced in property overrides', async (t) => {
	const doc = new Document();
	const pkg = doc.createPackage('UI').setId('props001');
	const other = doc.createPackage('Icons').setId('icons001');
	const main = doc.createComponent('Main').setId('main').setExported(true);
	main.addChild(
		doc
			.createGComponent('instance')
			.setId('instance')
			.setPropertyOverrides([{ target: 'icon', propertyId: 1, value: 'ui://icons001image' }]),
	);
	pkg.addResource(main);
	await doc.transform(publish({ packages: ['UI'] }));
	t.deepEqual(pkg.listDependencies(), [other]);
});
