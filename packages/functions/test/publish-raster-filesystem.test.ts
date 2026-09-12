import test from 'ava';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Document } from '@openfairygui/core';
import { publish } from '../src/publish.js';

for (const count of [1, 2]) {
	test(`publish sends ${count === 1 ? 'direct' : 'packed'} atlas bytes through its output filesystem`, async (t) => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fgui-raster-fs-'));
		try {
			const assets = path.join(directory, 'assets');
			await fs.mkdir(path.join(assets, 'UI'), { recursive: true });
			const doc = new Document();
			const pkg = doc.createPackage('UI').setId('raster01');
			for (let index = 0; index < count; index++) {
				const name = `image${index}`;
				pkg.addResource(
					doc
						.createImageResource(name)
						.setId(name)
						.setFileName(`${name}.png`)
						.setPath('/')
						.setWidth(8)
						.setHeight(8)
						.setExported(true),
				);
				await sharp({ create: { width: 8, height: 8, channels: 4, background: 'red' } })
					.png()
					.toFile(path.join(assets, 'UI', `${name}.png`));
			}
			const files = new Map<string, Uint8Array>();
			const output = path.join(directory, 'virtual');
			const options = {
				output,
				basePath: assets,
				encoder: sharp,
				fs: {
					readFileRaw: fs.readFile,
					mkdir: async () => {},
					join: path.join,
					writeFileRaw: async (file: string, data: Uint8Array) => {
						files.set(path.basename(file), data);
					},
				},
			};
			await doc.transform(publish(options));
			t.deepEqual([...files.keys()].sort(), ['UI_atlas0.png', 'UI_fui.bytes']);
			t.is((await sharp(files.get('UI_atlas0.png')).metadata()).format, 'png');
			t.false(
				await fs.stat(output).then(
					() => true,
					() => false,
				),
			);
			files.clear();
			await t.throwsAsync(
				doc.transform(
					publish({
						...options,
						fs: {
							...options.fs,
							writeFileRaw: async () => {
								throw new Error('output unavailable');
							},
						},
					}),
				),
			);
			t.is(files.size, 0);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
}
