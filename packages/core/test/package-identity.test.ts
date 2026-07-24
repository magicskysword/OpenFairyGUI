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
	t.is(core.version, '0.2.1');
	t.is(functions.name, '@magicskysword/openfairygui-functions');
	t.is(functions.version, '0.2.1');
	t.is(
		functions.dependencies['@magicskysword/openfairygui-core'],
		'^0.2.1',
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
