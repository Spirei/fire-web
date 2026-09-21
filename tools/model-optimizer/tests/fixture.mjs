import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
export async function model(file, width, height, minBytes = 0) {
  const image = await sharp({ create: { width, height, channels: 4, background: '#abc' } }).png().toBuffer();
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: image.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: image.length }], images: [{ bufferView: 0, mimeType: 'image/png' }] }));
  const padded = Math.ceil(json.length / 4) * 4, size = Math.max(28 + padded + Math.ceil(image.length / 4) * 4, minBytes);
  const bytes = Buffer.alloc(size); bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(size, 8); bytes.writeUInt32LE(padded, 12); bytes.writeUInt32LE(0x4e4f534a, 16); bytes.fill(32, 20, 20 + padded); json.copy(bytes, 20); bytes.writeUInt32LE(size - 28 - padded, 20 + padded); bytes.writeUInt32LE(0x004e4942, 24 + padded); image.copy(bytes, 28 + padded);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
}
