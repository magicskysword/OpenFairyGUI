import test from 'ava';
import fs from 'node:fs/promises';

async function readJson(url: URL): Promise<Record<string, any>> {
	return JSON.parse(await fs.readFile(url, 'utf8')) as Record<string, any>;
}

test('fork packages expose stable magicskysword names and semver dependencies', async (t) => {
	const workspaceRoot = await readJson(new URL('../../../package.json', import.meta.url));
	const core = await readJson(new URL('../package.json', import.meta.url));
	const functions = await readJson(new URL('../../functions/package.json', import.meta.url));

	t.deepEqual(workspaceRoot.repository, {
		type: 'git',
		url: 'git+https://github.com/magicskysword/OpenFairyGUI.git',
	});
	t.is(workspaceRoot.homepage, 'https://github.com/magicskysword/OpenFairyGUI#readme');
	t.deepEqual(workspaceRoot.bugs, {
		url: 'https://github.com/magicskysword/OpenFairyGUI/issues',
	});
	t.is(core.name, '@magicskysword/openfairygui-core');
	t.is(core.version, '0.2.4');
	t.is(functions.name, '@magicskysword/openfairygui-functions');
	t.is(functions.version, '0.2.4');
	t.is(
		functions.dependencies['@magicskysword/openfairygui-core'],
		'^0.2.4',
		'published manifests must use a real SemVer range instead of a sibling path or workspace protocol',
	);
});

test('workspace links matching semver package versions for local development', async (t) => {
	const workspace = await fs.readFile(new URL('../../../pnpm-workspace.yaml', import.meta.url), 'utf8');
	const tsconfig = await readJson(new URL('../../../tsconfig.json', import.meta.url));

	t.regex(workspace, /linkWorkspacePackages:\s*true/);
	t.truthy(tsconfig.compilerOptions.paths['@magicskysword/openfairygui-core']);
	t.truthy(tsconfig.compilerOptions.paths['@magicskysword/openfairygui-functions']);
});

test('npm trusted publishing is tokenless, version-gated, and dependency ordered', async (t) => {
	const workflow = await fs.readFile(
		new URL('../../../.github/workflows/publish.yml', import.meta.url),
		'utf8',
	);

	t.regex(workflow, /tags:\s*\r?\n\s*-\s*['"]npm-v\*['"]/);
	t.regex(workflow, /id-token:\s*write/);
	t.regex(workflow, /contents:\s*read/);
	t.regex(workflow, /actions\/checkout@v6/);
	t.regex(workflow, /submodules:\s*recursive/);
	t.regex(workflow, /actions\/setup-node@v6/);
	t.regex(workflow, /node-version:\s*['"]24['"]/);
	t.regex(workflow, /package-manager-cache:\s*false/);
	t.regex(workflow, /packages\/core\/package\.json/);
	t.regex(workflow, /packages\/functions\/package\.json/);
	t.regex(workflow, /-run\\\./);
	t.regex(workflow, /pnpm test/);

	const installStep = workflow.indexOf('- name: Install dependencies');
	const buildStep = workflow.indexOf('- name: Build packages');
	const testStep = workflow.indexOf('- name: Run tests');
	const coreBuild = workflow.indexOf(
		'pnpm --filter @magicskysword/openfairygui-core build',
	);
	const functionsBuild = workflow.indexOf(
		'pnpm --filter @magicskysword/openfairygui-functions build',
	);
	const corePublish = workflow.indexOf('npm publish ./packages/core --access public');
	const functionsPublish = workflow.indexOf(
		'npm publish ./packages/functions --access public',
	);
	t.true(installStep >= 0);
	t.true(buildStep > installStep);
	t.true(coreBuild > buildStep);
	t.true(functionsBuild > coreBuild);
	t.true(testStep > functionsBuild);
	t.true(corePublish > testStep);
	t.true(functionsPublish > corePublish);
	t.notRegex(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN|--provenance/);
});

test('upstream release workflow is retained for upstream-compatible branches', async (t) => {
	const workflow = await fs.readFile(
		new URL('../../../.github/workflows/release.yml', import.meta.url),
		'utf8',
	);

	t.regex(workflow, /name:\s*Release/);
	t.regex(workflow, /tags:\s*\r?\n\s*-\s*['"]v\*['"]/);
	t.regex(workflow, /workflow_dispatch/);
});
