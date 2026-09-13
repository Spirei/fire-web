import { execFileSync } from "node:child_process";

const TYPES = ["feat", "fix", "style", "docs", "refactor", "test", "chore"];
const TITLE_PATTERN = new RegExp(`^(?:${TYPES.join("|")}): (?=.*\\p{Script=Han}).+`, "u");

function readTitles(args) {
  if (args[0] === "--title") return [args.slice(1).join(" ")];

  const [before = "", head = "HEAD"] = args;
  const revisions = before && !/^0+$/.test(before) ? [`${before}..${head}`] : ["-1", head];
  const output = execFileSync("git", ["log", "--format=%s", ...revisions], { encoding: "utf8" }).trim();
  return output ? output.split("\n") : [];
}

const titles = readTitles(process.argv.slice(2));
const invalid = titles.filter((title) => !TITLE_PATTERN.test(title));

if (!titles.length) {
  console.error("未找到需要检查的提交标题。");
  process.exit(1);
}

if (invalid.length) {
  console.error("提交标题格式不符合“英文类型前缀: 中文摘要”：");
  invalid.forEach((title) => console.error(`- ${title}`));
  console.error("允许的前缀：feat、fix、style、docs、refactor、test、chore。");
  process.exit(1);
}

console.log(`提交标题检查通过（${titles.length} 条）。`);
