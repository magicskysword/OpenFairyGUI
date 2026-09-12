import test from 'ava';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Document, type ImageResource } from '@openfairygui/core';
import { NodeIO } from '@openfairygui/core/node';
import { publish, resolvePublishOptions } from '../src/publish.js';

test('publish defaults to power-of-two atlases and transparent-edge trimming', (t) => {
	const doc = new Document();
	t.true(resolvePublishOptions(doc).atlas.powerOfTwo);
	t.true(resolvePublishOptions(doc).atlas.trimImage);
	doc.getRoot().setSettings({ publish: { atlasSetting: { sizeOption: 'npot', trimImage: false } } });
	t.false(resolvePublishOptions(doc).atlas.powerOfTwo);
	t.false(resolvePublishOptions(doc).atlas.trimImage);
});

test('standalone image atlases preserve trim offsets, disableTrim and exact power-of-two edges', async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fgui-atlas-defaults-'));
	try {
		const file = path.join(directory, 'UI.fairy');
		const assets = path.join(directory, 'assets', 'UI');
		await fs.mkdir(assets, { recursive: true });
		await fs.writeFile(file, '<projectDescription type="Unity" version="5.0"/>');
		await fs.writeFile(
			path.join(assets, 'package.xml'),
			`<packageDescription id="trim0011"><resources>
			<image id="trim" name="trim.png" path="/" exported="true" atlas="alone"/>
			<image id="keep" name="keep.png" path="/" exported="true" atlas="alone" disableTrim="true"/>
		</resources></packageDescription>`,
		);
		const center = await sharp({ create: { width: 8, height: 8, channels: 4, background: 'red' } })
			.png()
			.toBuffer();
		const png = await sharp({ create: { width: 32, height: 16, channels: 4, background: '#00000000' } })
			.composite([{ input: center, left: 3, top: 4 }])
			.png()
			.toBuffer();
		for (const name of ['trim', 'keep']) await fs.writeFile(path.join(assets, `${name}.png`), png);
		const io = new NodeIO();
		const doc = await io.readProject(file);
		const pkg = doc.getRoot().listPackages()[0];
		t.true((pkg.getResourceById('keep') as ImageResource).getDisableTrim());
		const output = path.join(directory, 'release');
		await doc.transform(
			publish({
				output,
				basePath: path.join(directory, 'assets'),
				encoder: sharp,
				fs: {
					readFileRaw: fs.readFile,
					writeFileRaw: async (file, bytes) => {
						await fs.writeFile(file, bytes);
					},
					mkdir: async (dir) => {
						await fs.mkdir(dir, { recursive: true });
					},
					join: path.join,
				},
			}),
		);
		const pages = pkg.listAtlases();
		const trimmed = pages.find((page) => page.getFile().includes('_trim.'))!;
		const kept = pages.find((page) => page.getFile().includes('_keep.'))!;
		t.deepEqual([trimmed.getWidth(), trimmed.getHeight()], [8, 8]);
		t.deepEqual([kept.getWidth(), kept.getHeight()], [32, 16]);
		t.deepEqual([trimmed.listSprites()[0].getOffsetX(), trimmed.listSprites()[0].getOffsetY()], [3, 4]);
		t.deepEqual([kept.listSprites()[0].getRectWidth(), kept.listSprites()[0].getRectHeight()], [32, 16]);
		const rewritten = path.join(directory, 'copy');
		await fs.mkdir(rewritten);
		await io.writeProject(doc, path.join(rewritten, 'UI.fairy'));
		t.regex(await fs.readFile(path.join(rewritten, 'assets', 'UI', 'package.xml'), 'utf8'), /disableTrim="true"/);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
