import test from 'ava';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Document } from '@openfairygui/core';
import { publish } from '../src/publish.js';

test('duplicate padding copies sprite border pixels into the reserved gutter', async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fgui-padding-'));
	try {
		const assets = path.join(directory, 'assets');
		await fs.mkdir(path.join(assets, 'UI'), { recursive: true });
		const doc = new Document();
		const pkg = doc.createPackage('UI').setId('padding1');
		pkg.addResource(
			doc
				.createImageResource('image')
				.setId('image')
				.setFileName('image.png')
				.setPath('/')
				.setWidth(4)
				.setHeight(4)
				.setExported(true)
				.setDuplicatePadding(true),
		);
		await sharp({ create: { width: 4, height: 4, channels: 4, background: 'red' } })
			.png()
			.toFile(path.join(assets, 'UI', 'image.png'));
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
		const sprite = page.listSprites()[0];
		const { data, info } = await sharp(path.join(output, page.getFile()))
			.ensureAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true });
		for (const [dx, dy] of [
			[-1, -1],
			[0, -1],
			[4, -1],
			[-1, 0],
			[4, 0],
			[-1, 4],
			[0, 4],
			[4, 4],
		]) {
			const offset = ((sprite.getRectY() + dy) * info.width + sprite.getRectX() + dx) * 4;
			t.deepEqual([...data.subarray(offset, offset + 4)], [255, 0, 0, 255]);
		}
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
