import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repack the four livery PNGs shipped beside this Sketchfab GLB into one self-contained GLB. */
export function repackSketchfabTextures(source, texturesDir, output) {
  const input = fs.readFileSync(source);
  if (input.readUInt32LE(0) !== 0x46546c67 || input.readUInt32LE(4) !== 2 || input.readUInt32LE(8) !== input.length) {
    throw new Error('源文件不是完整的 glTF 2.0 GLB');
  }
  const jsonLength = input.readUInt32LE(12);
  if (input.readUInt32LE(16) !== 0x4e4f534a) throw new Error('缺少 GLB JSON 块');
  const binHeader = 20 + jsonLength;
  if (input.readUInt32LE(binHeader + 4) !== 0x004e4942 || binHeader + 8 + input.readUInt32LE(binHeader) !== input.length) {
    throw new Error('只支持单个内嵌 BIN 块的 GLB');
  }
  const gltf = JSON.parse(input.subarray(20, binHeader).toString('utf8'));
  if (gltf.asset?.extras?.source !== 'https://sketchfab.com/3d-models/2026-haas-vf-26-1f41e03886724bc6acd16c92402989bc') {
    throw new Error('源模型与已核对的 Haas VF-26 底稿不符，拒绝猜测贴图映射');
  }
  const replacements = [
    ['chasis', 'chassis_(1).png'],
    ['chassis2', 'chassis2_(1).png'],
    ['decal', 'decals_(1).png'],
    ['redbull_wheel_hub', 'redbull_wheel_d_(1).png'],
  ];
  const originalBin = input.subarray(binHeader + 8);
  const segments = [originalBin];
  let offset = originalBin.length;
  const details = [];
  for (const [materialName, fileName] of replacements) {
    const material = gltf.materials.find((item) => item.name === materialName);
    const textureIndex = material?.pbrMetallicRoughness?.baseColorTexture?.index;
    const imageIndex = gltf.textures[textureIndex]?.source;
    if (!Number.isInteger(imageIndex) || !Number.isInteger(gltf.images[imageIndex]?.bufferView)) {
      throw new Error(`材质 ${materialName} 没有内嵌基础色贴图`);
    }
    const bytes = fs.readFileSync(path.join(texturesDir, fileName));
    if (bytes.readUInt32BE(0) !== 0x89504e47 || bytes.toString('ascii', 4, 8) !== '\r\n\x1a\n') {
      throw new Error(`${fileName} 不是 PNG`);
    }
    if (offset % 4) { const padding = Buffer.alloc(4 - offset % 4); segments.push(padding); offset += padding.length; }
    const view = gltf.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length }) - 1;
    gltf.images[imageIndex] = { ...gltf.images[imageIndex], bufferView: view, mimeType: 'image/png' };
    segments.push(bytes);
    offset += bytes.length;
    details.push({ material: materialName, imageIndex, file: fileName, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
  }
  if (offset % 4) { const padding = Buffer.alloc(4 - offset % 4); segments.push(padding); offset += padding.length; }
  gltf.buffers[0].byteLength = offset;
  gltf.asset.extras = { ...gltf.asset.extras, livery: '2026 Aston Martin AMR26', liveryNote: 'Haas VF-26 geometry with separately supplied Aston Martin livery textures' };
  const json = Buffer.from(JSON.stringify(gltf));
  const paddedJson = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + paddedJson.length + 8 + offset, 8);
  header.writeUInt32LE(paddedJson.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const binChunk = Buffer.alloc(8);
  binChunk.writeUInt32LE(offset, 0);
  binChunk.writeUInt32LE(0x004e4942, 4);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, Buffer.concat([header, paddedJson, binChunk, ...segments]));
  return details;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , source, texturesDir, output] = process.argv;
  if (!source || !texturesDir || !output) throw new Error('用法：node repack-sketchfab-textures.mjs source.glb textures/ output.glb');
  console.log(JSON.stringify(repackSketchfabTextures(source, texturesDir, output), null, 2));
}
