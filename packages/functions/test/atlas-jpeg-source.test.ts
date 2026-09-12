import test from 'ava';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Document } from '@openfairygui/core';
import { publish } from '../src/publish.js';
import { publishToMemory } from '../src/publish-memory.js';

test('atlas decodes JPEG source pixels once even when the source file uses a PNG extension', async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fgui-jpeg-atlas-'));
	try {
		const assets = path.join(directory, 'assets');
		await fs.mkdir(path.join(assets, 'UI'), { recursive: true });
		const pixels = Buffer.from(
			Array.from({ length: 24 * 24 * 3 }, (_, index) => (index * 137 + (index % 17)) % 256),
		);
		const jpeg = await sharp(pixels, { raw: { width: 24, height: 24, channels: 3 } })
			.jpeg({ quality: 97, chromaSubsampling: '4:4:4' })
			.toBuffer();
		const expected = await sharp(jpeg).ensureAlpha().raw().toBuffer();
		await fs.writeFile(path.join(assets, 'UI', 'photo.png'), jpeg);
		const doc = new Document();
		const pkg = doc.createPackage('UI').setId('jpeg0001');
		for (const id of ['photo', 'copy'])
			pkg.addResource(
				doc
					.createImageResource(id)
					.setId(id)
					.setFileName('photo.png')
					.setPath('/')
					.setWidth(24)
					.setHeight(24)
					.setExported(true),
			);
		const output = path.join(directory, 'release');
		await doc.transform(
			publish({
				output,
				basePath: assets,
				encoder: sharp,
				fs: {
					readFileRaw: fs.readFile,
					join: path.join,
					mkdir: async (dir) => {
						await fs.mkdir(dir, { recursive: true });
					},
					writeFileRaw: async (file, bytes) => {
						await fs.writeFile(file, bytes);
					},
				},
			}),
		);
		const page = pkg.listAtlases()[0];
		const sprite = page.listSprites().find((sprite) => sprite.getItemId() === 'photo')!;
		const actual = await sharp(path.join(output, page.getFile()))
			.extract({ left: sprite.getRectX(), top: sprite.getRectY(), width: 24, height: 24 })
			.ensureAlpha()
			.raw()
			.toBuffer();
		t.deepEqual(actual, expected);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test('memory publishing encodes standalone JPEG artifacts with the declared format', async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fgui-jpeg-format-'));
	try {
		await fs.mkdir(path.join(directory, 'UI'));
		await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } })
			.jpeg()
			.toFile(path.join(directory, 'UI', 'photo.jpg'));
		const doc = new Document();
		const pkg = doc.createPackage('UI').setId('jpeg0001');
		pkg.addResource(
			doc
				.createImageResource('photo')
				.setId('photo')
				.setFileName('photo.jpg')
				.setPath('/')
				.setWidth(8)
				.setHeight(8)
				.setTextureSetMode('alone')
				.setExported(true),
		);
		const artifacts = await publishToMemory(doc, { encoder: sharp, basePath: directory });
		const atlas = artifacts.find((file) => file.fileName === 'UI_atlas_photo.jpg')!;
		t.is((await sharp(atlas.data).metadata()).format, 'jpeg');
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
