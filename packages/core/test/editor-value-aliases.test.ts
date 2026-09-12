import test from 'ava';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeIO } from '../src/node.js';
import type { GGroup, GRichTextField, GTextInput } from '../src/index.js';

test('reader accepts editor group layouts, button effects, ellipsis and transition frameRate', async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fgui-aliases-'));
	try {
		const file = path.join(directory, 'UI.fairy');
		const assets = path.join(directory, 'assets', 'UI');
		await fs.mkdir(assets, { recursive: true });
		await fs.writeFile(file, '<projectDescription type="Unity" version="5.0"/>');
		await fs.writeFile(
			path.join(assets, 'package.xml'),
			'<packageDescription id="alias001"><resources><component id="main" name="Main.xml" path="/" exported="true"/></resources></packageDescription>',
		);
		for (const [effect, expected] of [
			['dark', 1],
			['scale', 2],
			['1', 1],
		] as const) {
			await fs.writeFile(
				path.join(assets, 'Main.xml'),
				`<component size="100,100" extention="Button"><displayList>
				<group id="hz" layout="hz" advanced="true"/><group id="vt" layout="vt" advanced="true"/>
				<richtext id="rich" autoSize="ellipsis"/><inputtext id="input" autoSize="ellipsis"/>
			</displayList><Button downEffect="${effect}" downEffectValue=".8"/>
			<transition name="t0" frameRate="30"><item time="30" type="Alpha" target="rich" value=".5"/></transition></component>`,
			);
			const doc = await new NodeIO().readProject(file);
			const component = doc.getRoot().listPackages()[0].listComponents()[0];
			t.is(component.getDownEffect(), expected);
			t.is(component.getDownEffectValue(), 0.8);
			const children = component.listChildren();
			t.is((children[0] as GGroup).getLayout(), 1);
			t.is((children[1] as GGroup).getLayout(), 2);
			t.is((children[2] as GRichTextField).getAutoSize(), 4);
			t.is((children[3] as GTextInput).getAutoSize(), 4);
			t.is(component.listTransitions()[0].getFps(), 30);
			const binary = path.join(directory, 'UI.bytes');
			await new NodeIO().writeBinary(doc, binary);
			const result = (await new NodeIO().readBinary(binary)).getRoot().listPackages()[0].listComponents()[0];
			const transition = result.listTransitions()[0];
			t.is(transition.listItems()[0].getTime() / transition.getFps(), 1);
		}
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
