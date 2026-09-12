import test from 'ava';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Document } from '../src/index.js';
import { NodeIO } from '../src/node.js';
import { ByteBuffer } from '../src/io/byte-buffer.js';

for (const mask of [0, 16, 31]) {
	test(`binary image preserves nine-slice tile mask ${mask}`, async (t) => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fgui-grid-'));
		try {
			const doc = new Document();
			const pkg = doc.createPackage('Grid').setId('gridpkg1');
			pkg.addResource(
				doc
					.createImageResource('panel')
					.setId('panel1')
					.setWidth(132)
					.setHeight(136)
					.setExported(true)
					.setScaleOption(1)
					.setScale9Grid([33, 34, 66, 68])
					.setTileGridIndice(mask),
			);
			const file = path.join(directory, 'Grid.bytes');
			const io = new NodeIO();
			await io.writeBinary(doc, file);
			const bytes = await fs.readFile(file);
			const buffer = new ByteBuffer(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			buffer.skip(9);
			buffer.readUTFString();
			buffer.readUTFString();
			buffer.skip(20);
			t.true(buffer.seek(buffer.pos, 1));
			t.is(buffer.getInt16(), 1);
			buffer.getInt32();
			t.is(buffer.getUint8(), 0);
			buffer.skip(17);
			t.is(buffer.getUint8(), 1);
			buffer.skip(16);
			t.is(buffer.getInt32(), mask);
			// Read a separately patched payload to exercise the reader independently of the writer.
			bytes.writeInt32BE(mask, buffer.pos - 4);
			await fs.writeFile(file, bytes);
			const image = (await io.readBinary(file)).getRoot().listPackages()[0].listImageResources()[0];
			t.is(image.getTileGridIndice(), mask);
			t.deepEqual(image.getScale9Grid(), [33, 34, 66, 68]);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
}
