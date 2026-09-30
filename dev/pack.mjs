// 打包插件 + 生成订阅源索引（GitHub Pages 发布用）。
//
//   node dev/pack.mjs                      # 默认按本仓库的 Pages 地址发布
//   node dev/pack.mjs --base=              # 空基址：索引里写相对地址，仅供本机自测
//   S17_BASE_URL=https://cdn.example.com/ node dev/pack.mjs   # 换托管地址
//   S17_OUT_DIR=/tmp/out node dev/pack.mjs                    # 换产物目录
//
// 产物（默认 docs/，由 GitHub Pages 的「main 分支 / docs 目录」直接对外服务）：
//   17live-<version>.zip    插件包（manifest.json 在压缩包根层）
//   index.json              AngelLive 订阅源索引，含 zip 的 sha256
//   .nojekyll               关掉 Pages 的 Jekyll 处理，避免文件被吞
//
// 关键点：
//   * 只打包运行时文件，dev/ 与 README 一律不进包（白名单式收集）。
//   * assets/ 下的平台图标是**必须打进包**的：宿主按固定文件名去已安装目录找图，
//     不进包就等于没图标。这里会当场校验存在 + PNG 魔数 + 尺寸，见下面 ICON_FILES。
//   * 用 staging 目录把 mtime 固定成 2020-01-01，保证同样的源码产出同样的 zip，
//     进而 sha256 稳定（宿主按 sha256 校验）。
//   * zip 内部不带目录条目（-D），与 plugins.carsonn.works 上的现有包一致。
//   * zipURL 必须是**绝对地址**：宿主那边是 `URL(string:)` 直接丢给 URLSession 下载，
//     相对地址不会自动按索引地址拼接。
//   * zipURLs 是**按顺序重试的镜像列表**，每个候选都要自己通过 sha256 校验才算命中。
//     *.github.io 在国内不稳，所以补 jsDelivr 兜底，客户端会自己往下试。

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, statSync, readdirSync, utimesSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, "..");

/// 本仓库的发布基址。仓库改名 / 换了 Pages 域名，只改这一行。
const PAGES_BASE = "https://willrao.github.io/AngelLive-17live-plugin/";

/// 备用镜像。{path} 换成 docs/ 下的相对路径。
/// jsDelivr 主域在国内时通时不通，所以再挂一个 fastly 备用域；
/// 两条都失败也不影响，客户端会继续用 zipURL 那条 Pages 线路。
const MIRROR_TEMPLATES = [
  "https://cdn.jsdelivr.net/gh/WillRao/AngelLive-17live-plugin@main/docs/{path}",
  "https://fastly.jsdelivr.net/gh/WillRao/AngelLive-17live-plugin@main/docs/{path}"
];

const outDir = join(pluginRoot, process.env.S17_OUT_DIR || "docs");
if (outDir === pluginRoot) {
  console.error("S17_OUT_DIR 不能是插件根目录（脚本会先清空产物目录）");
  process.exit(1);
}

const FIXED_TIME = new Date("2020-01-01T00:00:00Z");

const manifest = JSON.parse(readFileSync(join(pluginRoot, "manifest.json"), "utf8"));
const { pluginId, version, entry } = manifest;
if (!pluginId || !version || !entry) {
  console.error("manifest.json 缺 pluginId / version / entry");
  process.exit(1);
}

// ---- 收集要打包的文件（白名单）----
const files = new Set(["manifest.json", entry]);
for (const script of manifest.preloadScripts || []) files.add(script);

// assets/ 下的静态资源整体带上（存在才带）
function walk(dir, base) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return;
  }
  for (const item of entries) {
    const full = join(dir, item.name);
    const rel = relative(base, full).split(sep).join("/");
    if (item.isDirectory()) walk(full, base);
    else files.add(rel);
  }
}
walk(join(pluginRoot, "assets"), pluginRoot);

// ---- 平台图标必须有，且必须是对尺寸 ----
// 宿主不读 manifest 的图标字段，而是按固定文件名去「已安装插件目录」找 PNG
// （见各平台 PlatformIconProvider），所以图标只能靠打进 zip 来交付：
//   live_card_       iOS tab / tvOS 账号列表 / 索引里的四个 icon 字段
//   mini_live_card_  macOS 侧边栏
//   pad_live_card_   iOS / macOS 插件管理列表
//   tv_*_big|small   tvOS 平台页大图与焦点叠标（_dark 缺失时会回退到亮色版）
// 这里当场校验存在 + PNG 魔数 + 尺寸，免得打出一包「图标缺失/坏图」的版本 ——
// 那种问题在 App 里只表现为「图标没了」，很难定位回来。
const ICON_FILES = [
  [`assets/live_card_${pluginId}.png`, 128, 128],
  [`assets/mini_live_card_${pluginId}.png`, 128, 128],
  [`assets/pad_live_card_${pluginId}.png`, 128, 128],
  [`assets/tv_${pluginId}_big.png`, 740, 444],
  [`assets/tv_${pluginId}_big_dark.png`, 740, 444],
  [`assets/tv_${pluginId}_small.png`, 740, 444],
  [`assets/tv_${pluginId}_small_dark.png`, 740, 444]
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
for (const [rel, wantWidth, wantHeight] of ICON_FILES) {
  let buf;
  try {
    buf = readFileSync(join(pluginRoot, rel));
  } catch (error) {
    console.error(`图标缺失：${rel} —— 先跑 python3 dev/make-icons.py 生成`);
    process.exit(1);
  }
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    console.error(`不是合法 PNG：${rel}`);
    process.exit(1);
  }
  // IHDR 的宽高固定落在签名(8) + 长度(4) + 类型(4) 之后
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width !== wantWidth || height !== wantHeight) {
    console.error(`图标尺寸不对：${rel} 是 ${width}×${height}，期望 ${wantWidth}×${wantHeight}`);
    process.exit(1);
  }
  files.add(rel);
}

const sorted = Array.from(files).sort();
// 校验白名单里的文件都真实存在，避免打出缺文件的包
for (const rel of sorted) {
  try {
    statSync(join(pluginRoot, rel));
  } catch (error) {
    console.error(`manifest 里声明了 ${rel}，但文件不存在`);
    process.exit(1);
  }
}

// ---- staging：复制 + 固定 mtime ----
const staging = join(tmpdir(), `lp-pack-${pluginId}-${Date.now()}`);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

for (const rel of sorted) {
  const dest = join(staging, rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(join(pluginRoot, rel), dest);
  utimesSync(dest, FIXED_TIME, FIXED_TIME);
}

// ---- 打包 ----
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const zipName = `${pluginId}-${version}.zip`;
const zipPath = join(outDir, zipName);

// 必须锁 TZ=UTC 再调 zip。
// zip 把 mtime 写进 DOS 时间字段时用的是**本地时间**：同一份源码在 UTC+8 的 Mac 上
// 写出 01-01-2020 08:00，在 UTC 的 CI runner 上写出 01-01-2020 00:00，6 个字节不同
// → sha256 就不同 → CI 每次都会产生一次「重新打包」提交，本地重打包后也是脏的。
// 锁死 UTC 之后，本地和 CI 产出逐字节一致。
execFileSync("zip", ["-X", "-q", "-D", zipPath, ...sorted], {
  cwd: staging,
  env: { ...process.env, TZ: "UTC" }
});

const zipData = readFileSync(zipPath);
const sha256 = createHash("sha256").update(zipData).digest("hex");

// ---- 索引 ----
// zipURL 必须是绝对地址（宿主用 URL(string:) 直接下载，不会按索引地址补全）。
const baseArg = process.argv.find((a) => a.startsWith("--base="));
let baseURL = process.env.S17_BASE_URL || (baseArg ? baseArg.slice("--base=".length) : PAGES_BASE);
if (baseURL && !baseURL.endsWith("/")) baseURL += "/";

const zipURL = baseURL ? baseURL + zipName : zipName;

// 只有走默认 Pages 基址时才挂镜像。换了托管地址说明发布形态变了，
// 再塞 jsDelivr 会指向一个不属于那个地址的仓库路径。
const zipURLs = [zipURL];
if (baseURL === PAGES_BASE) {
  for (const template of MIRROR_TEMPLATES) zipURLs.push(template.replace("{path}", zipName));
}

// 四个 icon 字段统一指向这一张（官方插件源的写法就是四个字段同一个路径）
const iconPath = `assets/live_card_${pluginId}.png`;

const index = {
  apiVersion: 1,
  // 刻意不写 generatedAt：它在宿主侧是可选字段，除解码外没有任何使用点，
  // 但每次打包都会变 —— 留着会让 CI 每次产生一次纯改时间戳的空提交。
  // 去掉之后 index.json 完全由源码决定，配合可复现的 zip 做到「输入同则产物同」。
  plugins: [
    {
      pluginId,
      version,
      changelog: manifest.changelog || [],
      platform: pluginId,
      platformName: manifest.displayName || pluginId,
      platformDescription: manifest.platformDescription || "",
      // 图标四项都指向同一张 live_card_<id>.png —— 与官方插件源
      // （plugins.carsonn.works 的 /api/plugins）写法一致。这些字段目前只是元数据：
      // 宿主真正渲染用的是包内 assets/ 下那几个固定文件名，包不带图就没图标。
      icon: iconPath,
      iosIcon: iconPath,
      macosIcon: iconPath,
      tvosIcon: iconPath,
      tvosBigIcon: `assets/tv_${pluginId}_big.png`,
      tvosSmallIcon: `assets/tv_${pluginId}_small.png`,
      tvosBigIconDark: `assets/tv_${pluginId}_big_dark.png`,
      tvosSmallIconDark: `assets/tv_${pluginId}_small_dark.png`,
      zipURL,
      zipURLs,
      sha256,
      auth: manifest.auth || null
    }
  ]
};
writeFileSync(join(outDir, "index.json"), JSON.stringify(index, null, 2) + "\n");

// GitHub Pages 默认会跑一遍 Jekyll，它会把下划线开头的路径吞掉。
// 打一个 .nojekyll 关掉，静态文件原样输出。
writeFileSync(join(outDir, ".nojekyll"), "");

// ---- 报告 ----
const kb = (zipData.length / 1024).toFixed(1);
console.log(`\n✅ ${zipName}  (${kb} KB, ${sorted.length} 个文件)`);
console.log(`   sha256: ${sha256}`);
console.log("\n   包内文件：");
for (const rel of sorted) console.log(`     ${rel}`);
console.log(`\n✅ ${relative(pluginRoot, join(outDir, "index.json"))}`);
if (baseURL) {
  console.log("\n   镜像线路（客户端按顺序试，逐个校验 sha256）：");
  for (const url of zipURLs) console.log(`     ${url}`);
  console.log("\n   订阅源地址（填到 App 的「添加订阅源」）：");
  console.log(`     ${baseURL}index.json`);
} else {
  console.log("\n⚠️  索引里的 zipURL 目前是相对地址（" + zipName + "），");
  console.log("   App 用 URL(string:) 直接下载，相对地址会失败。");
  console.log("   正式发布请带上基址重跑：");
  console.log("     S17_BASE_URL=https://你的域名/路径/ node dev/pack.mjs");
  console.log("\n   本地自测可以忽略：起 `python3 -m http.server 8080` 后把");
  console.log("   zipURL 手动改成 http://127.0.0.1:8080/" + zipName + " 即可。");
}

rmSync(staging, { recursive: true, force: true });
