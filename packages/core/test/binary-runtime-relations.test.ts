import test from 'ava';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Document } from '../src/index.js';
import { NodeIO } from '../src/node.js';

test('binary relations address runtime children after basic groups are filtered', async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fgui-relations-'));
	try {
		const doc = new Document();
		const pkg = doc.createPackage('UI').setId('relpkg01');
		const component = doc.createComponent('Main').setId('main').setExported(true);
		pkg.addResource(component);
		component.addChild(doc.createGGroup('design').setId('group'));
		const first = doc.createGGraph('first').setId('first');
		const second = doc.createGGraph('second').setId('second');
		component.addChild(first).addChild(second);
		first.setRelations([{ target: 'second', type: 14, usePercent: false }]);
		component.setRelations([{ target: 'first', type: 15, usePercent: false }]);
		const io = new NodeIO();
		const file = path.join(directory, 'UI.bytes');
		await io.writeBinary(doc, file);
		const result = (await io.readBinary(file)).getRoot().listPackages()[0].listComponents()[0];
		t.deepEqual(
			result.listChildren().map((child) => child.getId()),
			['first', 'second'],
		);
		t.deepEqual(result.listChildren()[0].getRelations(), first.getRelations());
		t.deepEqual(result.getRelations(), component.getRelations());
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
