import test from 'ava';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeIO } from '../src/node.js';
import type { GList, GLoader, GTextField } from '../src/index.js';

test('binary publish applies text, loader and list clearing while retaining authoring values', async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fgui-clearing-'));
	try {
		const project = path.join(directory, 'UI.fairy');
		const assets = path.join(directory, 'assets', 'UI');
		await fs.mkdir(assets, { recursive: true });
		await fs.writeFile(project, '<projectDescription type="Unity" version="5.0"/>');
		await fs.writeFile(
			path.join(assets, 'package.xml'),
			'<packageDescription id="clearpkg"><resources><component id="main" name="Main.xml" path="/" exported="true"/></resources></packageDescription>',
		);
		await fs.writeFile(
			path.join(assets, 'Main.xml'),
			`<component size="100,100"><displayList>
			<text id="text" name="text" text="设计文字" autoClearText="true"/>
			<richtext id="rich" name="rich" text="设计富文本" autoClearText="true"/>
			<text id="input" name="input" text="设计输入" input="true" autoClearText="true"/>
			<text id="keep" name="keep" text="运行文字"/>
			<loader id="loader" name="loader" url="ui://clearpkgimage" clearOnPublish="true"/>
			<list id="clear" name="clear" defaultItem="ui://clearpkgitem" autoClearItems="true"><item title="设计项"/></list>
			<list id="inherit" name="inherit" defaultItem="ui://clearpkgitem"><item title="继承项"/></list>
			<list id="retain" name="retain" defaultItem="ui://clearpkgitem" autoClearItems="false"><item title="运行项"/></list>
		</displayList></component>`,
		);
		const io = new NodeIO();
		const doc = await io.readProject(project);
		doc.getRoot().setSettings({ common: { listClearOnPublish: true } });
		const source = doc.getRoot().listPackages()[0].listComponents()[0].listChildren();
		const binary = path.join(directory, 'UI.bytes');
		await io.writeBinary(doc, binary);
		const children = (await io.readBinary(binary)).getRoot().listPackages()[0].listComponents()[0].listChildren();
		const byId = new Map(children.map((child) => [child.getId(), child]));
		for (const id of ['text', 'rich', 'input']) t.is((byId.get(id) as GTextField).getText(), '');
		t.is((byId.get('keep') as GTextField).getText(), '运行文字');
		t.is((byId.get('loader') as GLoader).getUrl(), '');
		for (const id of ['clear', 'inherit']) t.is((byId.get(id) as GList).getListItems().length, 0);
		t.is((byId.get('retain') as GList).getListItems()[0].title, '运行项');
		t.is((byId.get('clear') as GList).getDefaultItem(), 'ui://clearpkgitem');
		t.is((source[0] as GTextField).getText(), '设计文字');
		t.is((source[5] as GList).getListItems().length, 1);
		const rewritten = path.join(directory, 'roundtrip', 'UI.fairy');
		await fs.mkdir(path.dirname(rewritten));
		await io.writeProject(doc, rewritten);
		const reread = (await io.readProject(rewritten)).getRoot().listPackages()[0].listComponents()[0].listChildren();
		t.is((reread[5] as GList).getAutoClearItems(), true);
		t.is((reread[6] as GList).getAutoClearItems(), null);
		t.is((reread[7] as GList).getAutoClearItems(), false);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
