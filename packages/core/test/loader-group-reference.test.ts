import test from 'ava';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeIO } from '../src/node.js';
import { applyDocumentEdits, readAuthoringProperties } from '../src/authoring/document-edit.js';
import { buildProjectReferenceGraph } from '../src/references/project-reference-graph.js';

test('loader group IDs survive native edits and XML and binary round trips', async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fgui-loader-group-'));
	try {
		const file = path.join(directory, 'UI.fairy');
		const assets = path.join(directory, 'assets', 'UI');
		await fs.mkdir(assets, { recursive: true });
		await fs.writeFile(file, '<projectDescription type="Unity" version="5.0"/>');
		await fs.writeFile(path.join(assets, 'package.xml'), '<packageDescription id="package1"><resources><component id="panel" name="Panel.xml" path="/" exported="true"/></resources></packageDescription>');
		await fs.writeFile(path.join(assets, 'Panel.xml'), '<component size="100,60"><displayList><loader id="n2_nkiv" name="flag" xy="0,0" size="40,40" group="n7_nkiv"/><group id="n7_nkiv" name="camp_flag" xy="0,0" size="40,40" advanced="true"/></displayList></component>');
		const io = new NodeIO();
		const document = await io.readProject(file);
		const check = (doc: typeof document) => {
			const loader = doc.getRoot().getPackageById('package1')!.listComponents()[0]!.getChildById('n2_nkiv')!;
			t.is(readAuthoringProperties(loader).group, 'n7_nkiv');
			t.true(buildProjectReferenceGraph(doc).find({ kind: 'node', packageId: 'package1', componentId: 'panel', id: 'n7_nkiv' }).some((edge) => edge.field === 'group'));
		};
		check(document);
		const edited = applyDocumentEdits(document, [{ op: 'update', target: { kind: 'node', packageId: 'package1', componentId: 'panel', nodeId: 'n2_nkiv' }, props: { width: 43 } }]).document;
		await io.writeProject(edited, file);
		t.true((await fs.readFile(path.join(assets, 'Panel.xml'), 'utf8')).includes('group="n7_nkiv"'));
		check(await io.readProject(file));
		const binary = path.join(directory, 'UI.bytes');
		await io.writeBinary(edited, binary);
		check(await io.readBinary(binary));
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
