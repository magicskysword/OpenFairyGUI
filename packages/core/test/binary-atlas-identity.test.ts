import test from 'ava';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Document } from '../src/index.js';
import { NodeIO } from '../src/node.js';

test('binary round trips preserve standalone atlas identities independently of numeric indices', async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fgui-atlas-identity-'));
	try {
		const doc = new Document();
		const pkg = doc.createPackage('UI').setId('atlas001');
		for (const id of ['first', 'second']) {
			const atlas = doc
				.createAtlas(`atlas_${id}`)
				.setIndex(0)
				.setFile(`atlas_${id}.png`)
				.setWidth(8)
				.setHeight(8);
			atlas.addSprite(
				doc
					.createSprite()
					.setItemId(id)
					.setRectWidth(8)
					.setRectHeight(8)
					.setOriginalWidth(8)
					.setOriginalHeight(8)
					.setAtlas(atlas),
			);
			pkg.addAtlas(atlas);
		}
		const file = path.join(directory, 'UI.bytes');
		const io = new NodeIO();
		await io.writeBinary(doc, file);
		const result = (await io.readBinary(file)).getRoot().listPackages()[0];
		t.deepEqual(
			result
				.listAtlases()
				.map((atlas) => [atlas.getName(), atlas.listSprites().map((sprite) => sprite.getItemId())]),
			[
				['atlas_first', ['first']],
				['atlas_second', ['second']],
			],
		);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
