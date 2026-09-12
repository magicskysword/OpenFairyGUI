import test from 'ava';
import { Document } from '@openfairygui/core';
import { publish } from '../src/publish.js';

test('publish includes transitive resource dependencies without unreachable component trees', async (t) => {
	const doc = new Document();
	const pkg = doc.createPackage('UI').setId('reach001');
	for (const [id, exported, target] of [
		['main', true, 'nested'],
		['nested', false, 'icon'],
		['unused', false, 'orphan'],
		['orphan', false, 'unused'],
	] as const) {
		const component = doc.createComponent(id).setId(id).setExported(exported);
		component.addChild(doc.createGComponent('child').setId('child').setSrc(target));
		pkg.addResource(component);
	}
	pkg.addResource(doc.createImageResource('icon').setId('icon').setWidth(8).setHeight(8));
	await doc.transform(publish({}));
	t.deepEqual((pkg.getExtras().publishedResourceIds as string[]).sort(), ['icon', 'main', 'nested']);
});

test('publish retains incoming cross-package component dependencies', async (t) => {
	const doc = new Document();
	const main = doc.createPackage('Main').setId('main0001');
	const shared = doc.createPackage('Shared').setId('shared01');
	const entry = doc.createComponent('Main').setId('main').setExported(true);
	entry.addChild(doc.createGComponent('shared').setId('instance').setPackageId('shared01').setSrc('shared'));
	main.addResource(entry);
	shared.addResource(doc.createComponent('Shared').setId('shared'));
	await doc.transform(publish({}));
	t.deepEqual(shared.getExtras().publishedResourceIds, ['shared']);
});
