import test from 'ava';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeIO } from '../src/node.js';

const PROJECT_XML = `<?xml version="1.0" encoding="utf-8"?>
<projectDescription id="folder-atlas-project" type="Unity" version="5.0"/>
`;

const PACKAGE_XML = `<?xml version="1.0" encoding="utf-8"?>
<packageDescription id="folderatlas">
  <resources>
    <folder id="/Images/" name="Images" path="/" atlas="10"/>
    <folder id="/Images/Nested/" name="Nested" path="/Images/" atlas="alone"/>
    <folder id="/Default/" name="Default" path="/" atlas="default"/>
    <image id="root1" name="root.png" path="/" width="8" height="8"/>
    <image id="parent1" name="parent.png" path="/Images/" width="8" height="8"/>
    <image id="nested1" name="nested.png" path="/Images/Nested/" width="8" height="8"/>
    <image id="child1" name="child.png" path="/Images/Nested/Child/" width="8" height="8"/>
    <image id="override1" name="override.png" path="/Images/Nested/" atlas="2" width="8" height="8"/>
    <image id="default1" name="default.png" path="/Default/" width="8" height="8"/>
    <movieclip id="movie1" name="movie.jta" path="/Images/Nested/"/>
  </resources>
</packageDescription>
`;

const BRANCH_PACKAGE_XML = `<?xml version="1.0" encoding="utf-8"?>
<branchDescription>
  <resources>
    <folder id="/Images/" name="Images" path="/" atlas="3"/>
    <image id="branch1" name="branch.png" path="/Images/" width="8" height="8"/>
    <image id="branch2" name="branch-nested.png" path="/Images/Nested/" width="8" height="8"/>
    <image id="branch3" name="branch-default.png" path="/Default/" width="8" height="8"/>
  </resources>
</branchDescription>
`;

interface TextureSetResource {
	getTextureSetMode(): string;
	getFolderTextureSetMode(): string;
}

async function createSourceProject(): Promise<{
	directory: string;
	projectPath: string;
}> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openfairygui-folder-atlas-'));
	const projectPath = path.join(directory, 'FolderAtlas.fairy');
	const packageDirectory = path.join(directory, 'assets', 'FolderAtlas');
	await fs.mkdir(packageDirectory, { recursive: true });
	await fs.writeFile(projectPath, PROJECT_XML, 'utf8');
	await fs.writeFile(path.join(packageDirectory, 'package.xml'), PACKAGE_XML, 'utf8');
	const branchPackageDirectory = path.join(directory, 'assets_mobile', 'FolderAtlas');
	await fs.mkdir(branchPackageDirectory, { recursive: true });
	await fs.writeFile(path.join(branchPackageDirectory, 'package_branch.xml'), BRANCH_PACKAGE_XML, 'utf8');
	return { directory, projectPath };
}

function resourceById(
	doc: Awaited<ReturnType<NodeIO['readProject']>>,
	id: string,
): TextureSetResource {
	const resource = doc.getRoot().getPackage('FolderAtlas')?.getResourceById(id);
	if (!resource) throw new Error(`missing resource ${id}`);
	return resource as unknown as TextureSetResource;
}

function branchResourceById(
	doc: Awaited<ReturnType<NodeIO['readProject']>>,
	id: string,
): TextureSetResource {
	const resource = doc
		.getRoot()
		.getPackage('FolderAtlas')
		?.listResources()
		.find((entry) => entry.getId() === id && entry.getBranch() === 'mobile');
	if (!resource) throw new Error(`missing branch resource ${id}`);
	return resource as unknown as TextureSetResource;
}

test('folder atlas modes inherit through resource paths while explicit values remain distinct', async (t) => {
	const source = await createSourceProject();
	try {
		const doc = await new NodeIO().readProject(source.projectPath);

		t.is(resourceById(doc, 'root1').getFolderTextureSetMode(), '');
		t.is(resourceById(doc, 'parent1').getFolderTextureSetMode(), '10');
		t.is(resourceById(doc, 'nested1').getFolderTextureSetMode(), 'alone');
		t.is(resourceById(doc, 'child1').getFolderTextureSetMode(), 'alone');
		t.is(resourceById(doc, 'override1').getTextureSetMode(), '2');
		t.is(resourceById(doc, 'override1').getFolderTextureSetMode(), 'alone');
		t.is(resourceById(doc, 'default1').getFolderTextureSetMode(), 'default');
		t.is(resourceById(doc, 'movie1').getFolderTextureSetMode(), 'alone');
		t.is(branchResourceById(doc, 'branch1').getFolderTextureSetMode(), '3');
		t.is(branchResourceById(doc, 'branch2').getFolderTextureSetMode(), 'alone');
		t.is(branchResourceById(doc, 'branch3').getFolderTextureSetMode(), 'default');
	} finally {
		await fs.rm(source.directory, { recursive: true, force: true });
	}
});

test('folder atlas declarations survive structural write and re-read without expanding onto resources', async (t) => {
	const source = await createSourceProject();
	const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'openfairygui-folder-atlas-out-'));
	const outputProjectPath = path.join(outputDirectory, 'FolderAtlas.fairy');
	try {
		const io = new NodeIO();
		await io.writeProject(await io.readProject(source.projectPath), outputProjectPath);
		const outputPackageXml = await fs.readFile(
			path.join(outputDirectory, 'assets', 'FolderAtlas', 'package.xml'),
			'utf8',
		);

		t.regex(outputPackageXml, /<folder\b[^>]*id="\/Images\/"[^>]*atlas="10"/);
		t.regex(outputPackageXml, /<folder\b[^>]*id="\/Images\/Nested\/"[^>]*atlas="alone"/);
		const parentTag = outputPackageXml.match(/<image\b[^>]*id="parent1"[^>]*>/)?.[0] ?? '';
		const nestedTag = outputPackageXml.match(/<image\b[^>]*id="nested1"[^>]*>/)?.[0] ?? '';
		t.notRegex(parentTag, /\batlas=/);
		t.notRegex(nestedTag, /\batlas=/);

		const roundTripped = await io.readProject(outputProjectPath);
		t.is(resourceById(roundTripped, 'parent1').getFolderTextureSetMode(), '10');
		t.is(resourceById(roundTripped, 'child1').getFolderTextureSetMode(), 'alone');
		t.is(resourceById(roundTripped, 'override1').getTextureSetMode(), '2');
		t.is(resourceById(roundTripped, 'movie1').getFolderTextureSetMode(), 'alone');
	} finally {
		await fs.rm(source.directory, { recursive: true, force: true });
		await fs.rm(outputDirectory, { recursive: true, force: true });
	}
});
