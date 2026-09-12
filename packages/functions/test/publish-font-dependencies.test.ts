import test from 'ava';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Document, type FontResource } from '@openfairygui/core';
import { NodeIO } from '@openfairygui/core/node';
import { publish } from '../src/publish.js';

test('publish includes glyph images of selected file-backed bitmap fonts', async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fgui-font-deps-'));
	try {
		const basePath = path.join(directory, 'assets');
		const packagePath = path.join(basePath, 'UI');
		await fs.mkdir(packagePath, { recursive: true });
		const doc = new Document();
		const pkg = doc.createPackage('UI').setId('fontpkg1');
		for (const [id, exported] of [
			['digits', true],
			['unused', false],
		] as const) {
			pkg.addResource(doc.createFontResource(id).setId(id).setPath('/').setExported(exported));
			pkg.addResource(
				doc
					.createImageResource(`${id}_0`)
					.setId(`${id}_0`)
					.setFileName(`${id}_0.png`)
					.setPath('/')
					.setWidth(8)
					.setHeight(12),
			);
			await fs.writeFile(
				path.join(packagePath, `${id}.fnt`),
				`info size=12 colored=false\nchar id=48 img=${id}_0 xadvance=8\n`,
			);
			await sharp({ create: { width: 8, height: 12, channels: 4, background: 'red' } })
				.png()
				.toFile(path.join(packagePath, `${id}_0.png`));
		}
		const output = path.join(directory, 'release');
		await doc.transform(
			publish({
				output,
				basePath,
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
		const decoded = await new NodeIO().readBinary(path.join(output, 'UI_fui.bytes'));
		const result = decoded.getRoot().listPackages()[0];
		t.deepEqual(
			result
				.listResources()
				.map((resource) => resource.getId())
				.sort(),
			['digits', 'digits_0'],
		);
		t.is((result.getResourceById('digits') as FontResource).listGlyphs()[0].getImg(), 'digits_0');
		t.deepEqual(
			result.listAtlases().flatMap((atlas) => atlas.listSprites().map((sprite) => sprite.getItemId())),
			['digits_0'],
		);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test('publish includes formal font texture and glyph dependencies before layout', async (t) => {
	const doc = new Document();
	const pkg = doc.createPackage('UI').setId('fontpkg1');
	const font = doc.createFontResource('Digits').setId('digits').setExported(true).setTextureId('texture');
	font.addGlyph(doc.createFontGlyph('zero').setCharId(48).setImg('zero'));
	pkg.addResource(font);
	for (const id of ['texture', 'zero', 'unused']) {
		pkg.addResource(doc.createImageResource(id).setId(id).setWidth(8).setHeight(8));
	}
	await doc.transform(publish({}));
	const selected = pkg.getExtras().publishedResourceIds as string[];
	t.deepEqual(selected.sort(), ['digits', 'texture', 'zero']);
	t.true(
		pkg
			.listAtlases()
			.flatMap((atlas) => atlas.listSprites())
			.some((sprite) => sprite.getItemId() === 'zero'),
	);
});
