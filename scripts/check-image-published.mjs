import {
  confirmRevision,
  releaseIdentity,
  findPublishedRelease,
} from "../lib/deployReleaseManifest.mjs";
import { appendFileSync } from "node:fs";

const {
  GH_TOKEN,
  REPOSITORY,
  CURRENT_SHA,
  GITHUB_OUTPUT,
  EXPECTED_REVISION = "",
  REQUEST_ID = "",
  VERIFY_ONLY = "",
} = process.env;
if (!GH_TOKEN || !REPOSITORY || !CURRENT_SHA || !GITHUB_OUTPUT)
  throw new Error("Missing release gate configuration");
confirmRevision(EXPECTED_REVISION, CURRENT_SHA);
if (
  REQUEST_ID &&
  !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
    REQUEST_ID,
  )
)
  throw new Error("请求编号无效");
const identity = releaseIdentity(process.cwd(), REPOSITORY, CURRENT_SHA);
const release =
  VERIFY_ONLY === "true"
    ? null
    : await findPublishedRelease(async (path) => {
        const response = await fetch(
          `https://api.github.com/repos/${REPOSITORY}${path}`,
          {
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${GH_TOKEN}`,
            },
          },
        );
        if (!response.ok)
          throw new Error(
            `GitHub publication check failed: ${response.status}`,
          );
        return response.json();
      }, identity);
appendFileSync(
  GITHUB_OUTPUT,
  `should_publish=${!release}\nversion=${identity.version}\nschema=${identity.schema_hash}\nimage=${identity.image}\n`,
);
console.log(
  release
    ? "当前提交已有匹配的不可变镜像清单，复用已发布版本。"
    : "当前提交需要完整构建核验。",
);
