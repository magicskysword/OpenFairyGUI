import test from 'ava';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeIO } from '../src/node.js';
import type { GComponent, GList } from '../src/index.js';

test('publish clears ComboBox design items and disables auto sizing for unbounded flow lists', async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fgui-list-options-'));
	try {
		const file = path.join(directory, 'UI.fairy');
		const assets = path.join(directory, 'assets', 'UI');
		await fs.mkdir(assets, { recursive: true });
		await fs.writeFile(file, '<projectDescription type="Unity" version="5.0"/>');
		await fs.writeFile(
			path.join(assets, 'package.xml'),
			'<packageDescription id="listpkg1"><resources><component id="main" name="Main.xml" path="/" exported="true"/></resources></packageDescription>',
		);
		await fs.writeFile(
			path.join(assets, 'Main.xml'),
			`<component size="100,100"><displayList>
			<component id="combo" name="combo"><ComboBox autoClearItems="true"><item title="Design" icon="ui://listpkg1icon"/></ComboBox></component>
			<list id="flow" layout="flow_hz"/><list id="bounded" layout="flow_hz" lineItemCount="3"/>
			<list id="vertical" layout="flow_vt"/><list id="row" layout="row"/>
		</displayList></component>`,
		);
		const io = new NodeIO();
		const doc = await io.readProject(file);
		const binary = path.join(directory, 'UI.bytes');
		await io.writeBinary(doc, binary);
		const children = (await io.readBinary(binary)).getRoot().listPackages()[0].listComponents()[0].listChildren();
		t.deepEqual((children[0] as GComponent).getInstanceComboItems(), []);
		t.deepEqual(
			children.slice(1).map((child) => (child as GList).getAutoResizeItem()),
			[false, true, false, true],
		);
		const original = doc.getRoot().listPackages()[0].listComponents()[0].listChildren()[0] as GComponent;
		t.is(original.getInstanceComboItems().length, 1);
		await io.writeProject(doc, file);
		const reread = (await io.readProject(file))
			.getRoot()
			.listPackages()[0]
			.listComponents()[0]
			.listChildren()[0] as GComponent;
		t.true(reread.getInstanceAutoClearItems());
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
