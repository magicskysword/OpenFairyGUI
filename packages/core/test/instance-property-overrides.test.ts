import test from 'ava';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeIO } from '../src/node.js';
import type { GComponent, GList } from '../src/index.js';

test('component and list-item property overrides survive XML and binary round trips', async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fgui-properties-'));
	try {
		const file = path.join(directory, 'UI.fairy');
		const assets = path.join(directory, 'assets', 'UI');
		await fs.mkdir(assets, { recursive: true });
		await fs.writeFile(file, '<projectDescription type="Unity" version="5.0"/>');
		await fs.writeFile(
			path.join(assets, 'package.xml'),
			'<packageDescription id="proppkg1"><resources><component id="main" name="Main.xml" path="/" exported="true"/></resources></packageDescription>',
		);
		await fs.writeFile(
			path.join(assets, 'Main.xml'),
			`<component size="100,100"><displayList>
			<component id="instance" name="instance" xy="0,0">
				<property target="bar_bg" propertyId="1" value="ui://proppkg1image"/>
				<property target="title" propertyId="0" value=""/>
			</component>
			<list id="list" name="list" xy="0,0"><item title="item"><property target="icon" propertyId="1" value="ui://proppkg1image"/></item></list>
		</displayList></component>`,
		);
		const expected = [
			{ target: 'bar_bg', propertyId: 1, value: 'ui://proppkg1image' },
			{ target: 'title', propertyId: 0, value: '' },
		];
		const io = new NodeIO();
		const doc = await io.readProject(file);
		const check = (document: typeof doc) => {
			const children = document.getRoot().listPackages()[0].listComponents()[0].listChildren();
			t.deepEqual((children[0] as GComponent).getPropertyOverrides(), expected);
			t.deepEqual((children[1] as GList).getListItems()[0].properties, [
				{ target: 'icon', propertyId: 1, value: 'ui://proppkg1image' },
			]);
		};
		check(doc);
		const binary = path.join(directory, 'UI.bytes');
		await io.writeBinary(doc, binary);
		const decoded = await io.readBinary(binary);
		check(decoded);
		await io.writeProject(decoded, file);
		check(await io.readProject(file));
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
