import test from 'ava';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	inspectOpaqueProjectXml,
} from '../src/index.js';
import { NodeIO } from '../src/node.js';

const PROJECT_XML = `<?xml version="1.0" encoding="utf-8"?>
<projectDescription id="opaque-project" type="Unity" version="3.0" vendorProject="keep">
  <vendorProjectNode value="keep"/>
</projectDescription>
`;

const PACKAGE_XML = `<?xml version="1.0" encoding="utf-8"?>
<packageDescription id="pkg00001" vendorPackage="keep">
  <vendorBefore value="before"/>
  <resources vendorContainer="keep">
    <component id="abcde" name="Main.xml" path="/" exported="true" vendorResource="keep">
      <vendorResourceChild value="keep"/>
    </component>
    <vendorResource id="opaque-resource" value="keep"/>
  </resources>
  <publish name="Opaque" vendorPublish="keep">
    <vendorPublishChild value="keep"/>
  </publish>
  <vendorAfter value="after"/>
</packageDescription>
`;

const COMPONENT_XML = `<?xml version="1.0" encoding="utf-8"?>
<component size="200,100" vendorRoot="keep">
  <vendorComponentBefore value="before"/>
  <displayList vendorDisplayList="keep">
    <text id="n0" name="first" xy="0,0" size="80,20" text="old" vendorText="keep">
      <vendorTextChild value="owned-by-n0"/>
    </text>
    <vendorWidget id="opaque-widget" value="keep"/>
    <text id="n1" name="second" xy="0,30" size="80,20" text="second">
      <vendorSecondChild value="owned-by-n1"/>
    </text>
  </displayList>
  <vendorComponentAfter value="after"/>
</component>
`;

async function createProject(): Promise<{ directory: string; projectPath: string }> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openfairygui-opaque-'));
	const projectPath = path.join(directory, 'Opaque.fairy');
	const packageDirectory = path.join(directory, 'assets', 'Opaque');
	await fs.mkdir(packageDirectory, { recursive: true });
	await fs.writeFile(projectPath, PROJECT_XML, 'utf8');
	await fs.writeFile(path.join(packageDirectory, 'package.xml'), PACKAGE_XML, 'utf8');
	await fs.writeFile(path.join(packageDirectory, 'Main.xml'), COMPONENT_XML, 'utf8');
	return { directory, projectPath };
}

test('project writer structurally preserves unknown XML while editing known fields', async (t) => {
	const source = await createProject();
	const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'openfairygui-opaque-output-'));
	const outputProjectPath = path.join(outputDirectory, 'Opaque.fairy');
	const io = new NodeIO();

	try {
		const doc = await io.readProject(source.projectPath);
		const component = doc.getRoot().getPackage('Opaque')?.getComponent('Main');
		const first = component?.getChildById('n0') as { setText(value: string): unknown } | null;
		t.truthy(first);
		first?.setText('edited');

		const n0 = component?.getChildById('n0');
		if (component && n0) {
			component.removeChild(n0);
			component.addChild(n0);
		}

		await io.writeProject(doc, outputProjectPath);

		const outputProject = await fs.readFile(outputProjectPath, 'utf8');
		const outputPackage = await fs.readFile(
			path.join(outputDirectory, 'assets', 'Opaque', 'package.xml'),
			'utf8',
		);
		const outputComponent = await fs.readFile(
			path.join(outputDirectory, 'assets', 'Opaque', 'Main.xml'),
			'utf8',
		);

		t.regex(outputProject, /vendorProject="keep"/);
		t.regex(outputProject, /<vendorProjectNode value="keep"\/>/);
		t.regex(outputPackage, /vendorPackage="keep"/);
		t.regex(outputPackage, /vendorContainer="keep"/);
		t.regex(outputPackage, /vendorResource="keep"/);
		t.regex(outputPackage, /<vendorResourceChild value="keep"\/>/);
		t.regex(outputPackage, /<vendorResource id="opaque-resource" value="keep"\/>/);
		t.regex(outputPackage, /vendorPublish="keep"/);
		t.regex(outputPackage, /<vendorPublishChild value="keep"\/>/);
		t.regex(outputComponent, /vendorRoot="keep"/);
		t.regex(outputComponent, /vendorDisplayList="keep"/);
		t.regex(outputComponent, /vendorText="keep"/);
		t.regex(outputComponent, /<vendorTextChild value="owned-by-n0"\/>/);
		t.regex(outputComponent, /<vendorSecondChild value="owned-by-n1"\/>/);
		t.regex(outputComponent, /<vendorWidget id="opaque-widget" value="keep"\/>/);
		t.true(
			outputComponent.indexOf('id="n1"') < outputComponent.indexOf('id="n0"'),
			'known child movement must still be reflected in generated order',
		);

		const roundTrip = await io.readProject(outputProjectPath);
		const roundTripFirst = roundTrip
			.getRoot()
			.getPackage('Opaque')
			?.getComponent('Main')
			?.getChildById('n0') as { getText(): string } | null;
		t.is(roundTripFirst?.getText(), 'edited');
	} finally {
		await fs.rm(source.directory, { recursive: true, force: true });
		await fs.rm(outputDirectory, { recursive: true, force: true });
	}
});

test('opaque descendants are removed with their known owner while unowned nodes remain', async (t) => {
	const source = await createProject();
	const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'openfairygui-opaque-delete-'));
	const outputProjectPath = path.join(outputDirectory, 'Opaque.fairy');
	const io = new NodeIO();

	try {
		const doc = await io.readProject(source.projectPath);
		const component = doc.getRoot().getPackage('Opaque')?.getComponent('Main');
		const first = component?.getChildById('n0');
		if (component && first) component.removeChild(first);

		await io.writeProject(doc, outputProjectPath);
		const outputComponent = await fs.readFile(
			path.join(outputDirectory, 'assets', 'Opaque', 'Main.xml'),
			'utf8',
		);

		t.notRegex(outputComponent, /owned-by-n0/);
		t.notRegex(outputComponent, /id="n0"/);
		t.regex(outputComponent, /<vendorWidget id="opaque-widget" value="keep"\/>/);
	} finally {
		await fs.rm(source.directory, { recursive: true, force: true });
		await fs.rm(outputDirectory, { recursive: true, force: true });
	}
});

test('opaque XML inspection reports stable paths without exposing edit operations', (t) => {
	const findings = inspectOpaqueProjectXml('component', COMPONENT_XML);

	t.true(findings.some((finding) => finding.kind === 'attribute' && finding.name === 'vendorRoot'));
	t.true(findings.some((finding) => finding.kind === 'element' && finding.name === 'vendorWidget'));
	t.true(findings.every((finding) => finding.path.startsWith('/component')));
});
