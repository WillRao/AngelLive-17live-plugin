// 三层验证一把跑完，最后给一张总表。
//
//   node dev/verify-all.mjs          # HTTP + 离线回放（跳过需要 25s×N 的弹幕在线测试）
//   node dev/verify-all.mjs --full   # 连弹幕在线端到端一起跑
//
// 分层的意义：HTTP 层要联网、离线回放层完全离线、弹幕在线层要占用真实 WS 会话且
// 依赖「别人在说话」。日常改代码只需跑前两层；发版前必须跑全量。

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const full = process.argv.includes("--full");

const suites = [
  { name: "HTTP 能力在线验证", script: "verify.mjs", needsNetwork: true },
  { name: "弹幕解析离线回归", script: "verify-parser.mjs", needsNetwork: false }
];
if (full) suites.push({ name: "弹幕在线端到端", script: "verify-danmaku.mjs", needsNetwork: true });

function runSuite(suite) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, suite.script)], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.on("close", (code) => {
      const summaryLine = (output.match(/——\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败\s*——/) || []).slice(1);
      resolve({
        suite,
        code,
        passed: Number(summaryLine[0] || 0),
        failed: Number(summaryLine[1] || 0)
      });
    });
  });
}

console.log(`跑 ${suites.length} 个套件${full ? "（全量）" : "（跳过弹幕在线端到端，加 --full 开启）"}\n`);

const results = [];
for (const suite of suites) {
  console.log(`\n${"─".repeat(64)}`);
  console.log(`▶ ${suite.name}（dev/${suite.script}）`);
  console.log("─".repeat(64));
  results.push(await runSuite(suite));
}

console.log(`\n${"=".repeat(64)}`);
console.log("总表");
console.log("=".repeat(64));
let totalPassed = 0;
let totalFailed = 0;
for (const result of results) {
  totalPassed += result.passed;
  totalFailed += result.failed;
  const mark = result.code === 0 && result.failed === 0 ? "✅" : "❌";
  console.log(`  ${mark} ${result.suite.name.padEnd(20)} ${String(result.passed).padStart(3)} 通过 / ${result.failed} 失败`);
}
console.log(`\n  合计 ${totalPassed} 通过 / ${totalFailed} 失败`);

if (!full) {
  console.log("\n  提示：发版前请再跑一次 `node dev/verify-all.mjs --full`，");
  console.log("        它会真的连上 Ably 收一段弹幕。");
}

process.exit(totalFailed ? 1 : 0);
