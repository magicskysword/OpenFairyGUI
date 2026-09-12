import test from 'ava';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Document } from '../src/index.js';
import { NodeIO } from '../src/node.js';

test('sprites trimmed only at the right or bottom retain original dimensions', async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fgui-sprite-trim-'));
	try {
		const doc = new Document();
		const pkg = doc.createPackage('UI').setId('trim0001');
		pkg.addResource(doc.createImageResource('image').setId('image').setWidth(32).setHeight(16));
		const atlas = doc.createAtlas('atlas0').setIndex(0).setFile('atlas0.png').setWidth(32).setHeight(16);
		pkg.addAtlas(atlas);
		atlas.addSprite(
			doc
				.createSprite()
				.setItemId('image')
				.setRectWidth(30)
				.setRectHeight(12)
				.setOriginalWidth(32)
				.setOriginalHeight(16)
				.setAtlas(atlas),
		);
		const io = new NodeIO();
		const file = path.join(directory, 'UI.bytes');
		await io.writeBinary(doc, file);
		const result = (await io.readBinary(file)).getRoot().listPackages()[0].listAtlases()[0].listSprites()[0];
		t.deepEqual([result.getOriginalWidth(), result.getOriginalHeight()], [32, 16]);
		t.deepEqual(
			[result.getRectWidth(), result.getRectHeight(), result.getOffsetX(), result.getOffsetY()],
			[30, 12, 0, 0],
		);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
