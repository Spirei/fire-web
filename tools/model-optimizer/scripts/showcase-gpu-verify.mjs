import assert from 'node:assert/strict';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';

/** Reject a derivative that changes geometry data or shrinks even one source image. */
export async function verifyGpuDerivative(source, compressed) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const [original, packed] = await Promise.all([io.readBinary(source), io.readBinary(compressed)]);
  const a = original.getRoot(), b = packed.getRoot();
  assert(b.listExtensionsRequired().some(e => e.extensionName === 'KHR_texture_basisu'));
  const aa = a.listAccessors(), ba = b.listAccessors();
  assert.equal(aa.length, ba.length, 'accessor count changed');
  const compareAccessor = (left, right) => {
    assert.equal(!!left, !!right);
    if (!left) return;
    assert.equal(left.getType(), right.getType());
    assert.equal(left.getNormalized(), right.getNormalized());
    assert.deepEqual(left.getArray(), right.getArray(), 'geometry data changed');
  };
  assert.equal(a.listMeshes().length, b.listMeshes().length);
  a.listMeshes().forEach((mesh, index) => {
    const primitives = mesh.listPrimitives(), next = b.listMeshes()[index].listPrimitives();
    assert.equal(primitives.length, next.length);
    primitives.forEach((primitive, j) => {
      assert.equal(primitive.getMode(), next[j].getMode());
      compareAccessor(primitive.getIndices(), next[j].getIndices());
      assert.deepEqual(primitive.listSemantics(), next[j].listSemantics());
      primitive.listSemantics().forEach(semantic => compareAccessor(primitive.getAttribute(semantic), next[j].getAttribute(semantic)));
      assert.equal(primitive.listTargets().length, next[j].listTargets().length);
      primitive.listTargets().forEach((target, k) => target.listSemantics().forEach(semantic => compareAccessor(target.getAttribute(semantic), next[j].listTargets()[k].getAttribute(semantic))));
    });
  });
  assert.equal(a.listNodes().length, b.listNodes().length);
  // glTF-Transform serializes source node TRS through Float32; the resulting matrix can
  // differ by a few millionths without any visible or structural change.
  a.listNodes().forEach((node, i) => node.getMatrix().forEach((value, j) => assert(Math.abs(value - b.listNodes()[i].getMatrix()[j]) < 1e-5, 'node transform changed')));
  const at = a.listTextures(), bt = b.listTextures();
  assert.equal(at.length, bt.length, 'texture count changed');
  let rgbaBytes = 0, blockBytes = 0;
  const textures = [];
  for (let i = 0; i < at.length; i++) {
    const sourceImage = Buffer.from(at[i].getImage());
    const { width, height } = at[i].getMimeType() === "image/ktx2"
      ? { width: sourceImage.readUInt32LE(20), height: sourceImage.readUInt32LE(24) }
      : await sharp(sourceImage).metadata();
    assert.equal(bt[i].getMimeType(), 'image/ktx2');
    const ktx = Buffer.from(bt[i].getImage());
    assert.equal(ktx.readUInt32LE(20), width, `texture ${i} width changed`);
    assert.equal(ktx.readUInt32LE(24), height, `texture ${i} height changed`);
    const levels = ktx.readUInt32LE(40);
    for (let level = 0; level < levels; level++) {
      const w = Math.max(1, width >> level), h = Math.max(1, height >> level);
      rgbaBytes += w * h * 4;
      blockBytes += Math.ceil(w / 4) * Math.ceil(h / 4) * 16;
    }
    textures.push({name: at[i].getName(), width, height, levels});
  }
  return { accessors: aa.length, textures, rgbaBytes, blockBytes };
}
