import assert from "node:assert/strict";
import {
  confirmRevision,
  findPublishedRelease,
  releaseIdentity,
} from "../lib/deployReleaseManifest.mjs";
const expected = {
  version: "0.1.76",
  revision: "a".repeat(40),
  schema_hash: "b".repeat(64),
  image: "ghcr.io/synthetic/fire-web",
};
const body = {
  ...expected,
  image: expected.image + "@sha256:" + "c".repeat(64),
};
const record = (value = body, extra = {}) => ({
  body: JSON.stringify(value),
  target_commitish: expected.revision,
  draft: false,
  prerelease: false,
  ...extra,
});
assert.deepEqual(
  await findPublishedRelease(async () => [record()], expected),
  body,
);
assert.equal(await findPublishedRelease(async () => [], expected), null);
for (const extra of [
  { draft: true },
  { prerelease: true },
  { target_commitish: "d".repeat(40) },
])
  assert.equal(
    await findPublishedRelease(async () => [record(body, extra)], expected),
    null,
  );
for (const invalid of [
  { ...body, version: "0.1.1" },
  { ...body, schema_hash: "e".repeat(64) },
  { ...body, revision: "e".repeat(40) },
  { ...body, image: "ghcr.io/other/fire@sha256:" + "c".repeat(64) },
  { ...body, image: expected.image + ":latest" },
  { ...body, image: null },
  { ...body, extra: true },
  null,
])
  await assert.rejects(() =>
    findPublishedRelease(async () => [record(invalid)], expected),
  );
await assert.rejects(() =>
  findPublishedRelease(
    async () => [record(body, { body: "not a manifest" })],
    expected,
  ),
);
await assert.rejects(() =>
  findPublishedRelease(async () => ({ items: [] }), expected),
);
let pages = 0;
assert.deepEqual(
  await findPublishedRelease(
    async () =>
      ++pages === 1
        ? Array.from({ length: 100 }, () =>
            record(body, { target_commitish: "d".repeat(40) }),
          )
        : [record()],
    expected,
  ),
  body,
);
assert.equal(pages, 2);
pages = 0;
await assert.rejects(
  () =>
    findPublishedRelease(async () => {
      pages++;
      return Array.from({ length: 100 }, () =>
        record(body, { target_commitish: "d".repeat(40) }),
      );
    }, expected),
  /完整/,
);
assert.equal(pages, 20);
await assert.rejects(
  () =>
    findPublishedRelease(async () => {
      throw Error("network failure");
    }, expected),
  /network/,
);
confirmRevision(expected.revision, expected.revision);
assert.throws(() => confirmRevision("f".repeat(40), expected.revision));
assert.throws(() => confirmRevision("bad", expected.revision));
const identity = releaseIdentity(
  process.cwd(),
  "Synthetic/Fire-Web",
  expected.revision,
);
assert.equal(identity.image, "ghcr.io/synthetic/fire-web");
assert.match(identity.schema_hash, /^[a-f0-9]{64}$/);
console.log(
  "PASS immutable publication: exact commit/version/schema/image digest, full pagination, incomplete evidence rejection and confirmed-source guard",
);
