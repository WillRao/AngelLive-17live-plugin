// 抓 17LIVE Ably 弹幕的真实帧，存成离线回归夹具。
//
//   node dev/capture-fixture.mjs [roomId] [seconds]
//
// 存的是**入站文本帧原文**（Ably JSON），不做任何解码。
// 这样 verify-parser.mjs 能把同一批字节喂给插件的 onDanmakuFrame，
// 再用 Node 的 zlib 独立解一遍做 oracle —— 两边不共享代码，
// 插件里那套手写 inflate 出错时一定会被抓出来。
//
// 刻意不存 outbound：ATTACH 帧由插件自己生成，replay 时现算更严格。

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getJSON } from "./http.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "fixtures", "danmaku-frames.json");

// 与 index.js 保持一致的端点常量（夹具脚本刻意不复用插件代码，避免同源错误）。
const API = "https://api-dsa.17app.co";
const ABLY =
  "wss://17media-realtime.ably.io/?key=qvDtFQ.0xBeRA:iYWpd3nD2QHE6Sjm&format=json&heartbeats=true&v=1.1&lib=js-web-1.1.25";

const seconds = Number(process.argv[3] || 60);

async function pickRoom() {
  if (process.argv[2]) return String(process.argv[2]);
  // 日本区房间基数最大，弹幕最密
  const json = await getJSON(`${API}/api/v1/sections?count=20&region=JP`);
  const grids = (json.sections || []).flatMap((s) => s.grids || []);
  const live = grids.map((g) => g.stream).filter((s) => s && s.status === 2);
  if (!live.length) throw new Error("没找到在播房间");
  return String(live[0].liveStreamID);
}

const roomId = await pickRoom();
console.log(`房间 ${roomId}，抓 ${seconds}s ……`);

const frames = [];
const ws = new WebSocket(ABLY);
let attached = false;

const done = new Promise((resolve) => {
  setTimeout(() => {
    try { ws.close(); } catch {}
    resolve();
  }, seconds * 1000);
});

ws.onopen = () => {
  ws.send(JSON.stringify({ action: 10, channel: roomId }));
};
ws.onmessage = (ev) => {
  if (typeof ev.data !== "string") return;
  let outer;
  try { outer = JSON.parse(ev.data); } catch { return; }
  if (outer.action === 11) { attached = true; return; }
  if (outer.action === 15) {
    frames.push(ev.data);
    if (frames.length % 20 === 0) console.log(`  已收 ${frames.length} 帧`);
  }
};
ws.onerror = (e) => console.log("ERR", e?.message ?? String(e));

await done;

if (!attached) {
  console.error("❌ 从未收到 ATTACHED(action 11)，夹具不可信");
  process.exit(1);
}
if (!frames.length) {
  console.error("❌ 一帧都没抓到，换个房间重试");
  process.exit(1);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify({
    platform: "17live",
    transport: "ably",
    note:
      "17LIVE 弹幕真实帧（Ably 协议，format=json）。frames 里每条都是一个完整的入站文本帧原文；" +
      "messages[].data 是 base64(gzip(json))，未经任何处理原样保存。",
    ablyURL: ABLY,
    roomId,
    frameCount: frames.length,
    frames
  }) + "\n"
);

const bytes = frames.reduce((a, f) => a + f.length, 0);
console.log(`\n✅ ${outPath}`);
console.log(`   ${frames.length} 帧 / ${(bytes / 1024).toFixed(1)} KB`);
