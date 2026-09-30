// 弹幕解析离线回归：喂真实抓包夹具，不联网也能跑。
//
//   node dev/verify-parser.mjs
//
// 为什么必须有这一层：手写 inflate 与 JSON 取值路径的 bug 都是**静默**的 ——
// 不抛错、不报异常，只是弹幕一条都不显示。肉眼看不出来，只能靠独立 oracle 守。
//
// 这里的 oracle 是 Node 的 zlib + 一段刻意不复用插件代码的字段读取逻辑。
// 两边唯一的共识只有「协议长什么样」，任何实现层面的偏差都会暴露成集合不等。

import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { installHost, loadPlugin, makeChecker } from "./host-shim.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures", "danmaku-frames.json"), "utf8"));

installHost();
const { plugin } = loadPlugin();
const { check, summary } = makeChecker();

const driver = globalThis.__lp_s17_danmaku;

// =====================================================================
// Oracle：用 Node 的 zlib 独立解码，字段路径手写一遍（不复用插件代码）
// =====================================================================

function oraclePackets(frameText) {
  const outer = JSON.parse(frameText);
  if (outer.action !== 15 || !Array.isArray(outer.messages)) return [];
  const packets = [];
  for (const message of outer.messages) {
    const data = message.data;
    if (typeof data !== "string") continue;
    const buf = Buffer.from(data, "base64");
    const json = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
    packets.push(JSON.parse(json));
  }
  return packets;
}

function oracleChats(packet) {
  if (Number(packet.type) !== 3) return [];
  const cm = packet.commentMsg;
  if (!cm) return [];
  const text = cm.comment && cm.comment.text;
  const name = cm.name && cm.name.text;
  if (typeof text !== "string" || !text.trim()) return [];
  return [{ nickname: String(name || ""), text: text.trim() }];
}

const oraclePacketsAll = fixture.frames.flatMap(oraclePackets);
const oracleChatList = oraclePacketsAll.flatMap(oracleChats);
const oracleKey = (nickname, text) => `${nickname}\u0000${text}`;
const oracleChatSet = new Set(oracleChatList.map((m) => oracleKey(m.nickname, m.text)));

console.log(`夹具：房间 ${fixture.roomId}，${fixture.frames.length} 帧`);
console.log(`oracle：${oraclePacketsAll.length} 个包，其中 type 3 聊天 ${oracleChatList.length} 条\n`);

check("夹具非空", fixture.frames.length > 0, `${fixture.frames.length} 帧`);
check("oracle 解出聊天消息", oracleChatList.length > 0, `${oracleChatList.length} 条`);

// =====================================================================
// 1. 手写 inflate vs Node zlib —— 逐条对拍
// =====================================================================
console.log("\n== inflate 对拍（插件实现 vs Node zlib）==");

let comparedPayloads = 0;
let inflateMismatch = 0;
for (const frame of fixture.frames) {
  const outer = JSON.parse(frame);
  for (const message of outer.messages || []) {
    if (typeof message.data !== "string") continue;
    const mine = driver._inflateGzipBase64(message.data);
    const expected = gunzipSync(Buffer.from(message.data, "base64")).toString("utf8");
    comparedPayloads += 1;
    if (mine !== expected) {
      inflateMismatch += 1;
      if (inflateMismatch <= 2) {
        console.log(`    差异：期望 ${expected.length} 字节 / 实得 ${String(mine).length} 字节`);
        console.log(`      期望: ${expected.slice(0, 120)}`);
        console.log(`      实得: ${String(mine).slice(0, 120)}`);
      }
    }
  }
}
check(
  `inflate 与 zlib 逐字节一致（${comparedPayloads} 个真实负载）`,
  inflateMismatch === 0 && comparedPayloads > 0,
  inflateMismatch ? `${inflateMismatch} 个不一致` : "全部相同"
);

// =====================================================================
// 2. inflate 三条分支都要走到（真实流量通常只有动态 Huffman）
// =====================================================================
console.log("\n== inflate 分支覆盖（按字节对拍）==");

// 刻意用 _inflateGzipBytesBase64 而不是文本版：
// 二进制负载按 UTF-8 解码会有损（非法字节只能回退），比对字符串会掩盖 inflate 的字节错误。
function byteCompare(name, payload, level) {
  const base64 = gzipSync(payload, { level }).toString("base64");
  let got;
  try {
    got = driver._inflateGzipBytesBase64(base64);
  } catch (error) {
    got = `<抛错 ${error.message}>`;
  }
  const expected = payload.toString("base64");
  const ok = got === expected;
  check(`  ${name}`, ok, ok ? `${payload.length} 字节` : `期望 ${payload.length} 字节，实得 ${String(got).slice(0, 40)}`);
}

{
  // zlib level 0 出 stored 块；level 9 出动态 Huffman；
  // 高重复 / 长距离数据逼出回溯引用与码长重复码（16/17/18）。
  // 随机二进制专门覆盖「不可压缩内容 → 近乎满码表 + 大量 literal」这条路径。
  byteCompare("stored 块（level 0）", Buffer.from("hello stored block", "utf8"), 0);
  byteCompare("随机二进制（level 9，满码表）", randomBytes(4096), 9);
  byteCompare("随机二进制（level 6，中等）", randomBytes(777), 6);
  byteCompare("大量短距离回溯（level 9）", Buffer.from("abab".repeat(2000), "utf8"), 9);
  byteCompare("长距离回溯 >8KB（level 9）", Buffer.from("x".repeat(20000) + "tail-marker", "utf8"), 9);
  byteCompare("全零（码长重复码 17/18）", Buffer.alloc(6000, 0), 9);
  byteCompare("14KB 中文 JSON（贴近真实负载）", Buffer.from(JSON.stringify({ type: 3, text: "日本語のコメントです🎉".repeat(500) }), "utf8"), 9);
  byteCompare("空负载（level 9）", Buffer.from("", "utf8"), 9);
}

// 多 member 串联：RFC 1952 允许，zlib 的 gunzip 默认会全部解开。
{
  const parts = [Buffer.from("first-", "utf8"), Buffer.from("second-", "utf8"), Buffer.from("third", "utf8")];
  const merged = Buffer.concat(parts.map((p) => gzipSync(p, { level: 9 })));
  let got;
  try {
    got = driver._inflateGzipBytesBase64(merged.toString("base64"));
  } catch (error) {
    got = `<抛错 ${error.message}>`;
  }
  const expected = Buffer.concat(parts).toString("base64");
  check("多 member 串联解压", got === expected, got === expected ? "" : `实得 ${String(got).slice(0, 40)}`);
}

// =====================================================================
// 3. 按宿主驱动契约跑完整回放
// =====================================================================
console.log("\n== 驱动回放 ==");

const connectionId = "offline-" + Math.random().toString(36).slice(2);
const session = await plugin.createDanmakuSession({
  connectionId,
  roomId: fixture.roomId,
  args: { roomId: fixture.roomId, channel: fixture.roomId }
});
check("createDanmakuSession 返回 ok", session.ok === true);

const attach = await plugin.onDanmakuOpen({ connectionId });
check("onDanmakuOpen 只写 1 帧", (attach.writes || []).length === 1);
check("进房帧是文本帧", attach.writes[0].kind === "text");
{
  const frame = JSON.parse(attach.writes[0].text);
  check("进房帧 action=10（Ably ATTACH）", frame.action === 10, JSON.stringify(frame));
  check("进房帧 channel 等于房间号", String(frame.channel) === String(fixture.roomId), String(frame.channel));
}
check("进房前心跳关闭", attach.timer.mode === "off");

const replayed = [];
for (const frame of fixture.frames) {
  const result = await plugin.onDanmakuFrame({ connectionId, frameType: "text", text: frame });
  for (const message of result.messages || []) replayed.push(message);
}

// 只比 type 3 聊天：进场/字幕等由开关控制，不在 oracle 覆盖范围内。
const hitKeys = new Set(
  replayed.map((m) => oracleKey(m.nickname, m.text)).filter((k) => oracleChatSet.has(k))
);
check(
  `回放出的聊天消息覆盖 oracle 全集（${oracleChatSet.size} 条）`,
  hitKeys.size === oracleChatSet.size,
  hitKeys.size === oracleChatSet.size ? "" : `实得 ${hitKeys.size} 条`
);
check("回放无重复消息", replayed.length === new Set(replayed.map((m) => `${m.nickname}|${m.text}`)).size);

// =====================================================================
// 4. 协议状态机：ATTACHED / 心跳 / 容错
// =====================================================================
console.log("\n== 协议状态机 ==");

const cid = "state-" + Math.random().toString(36).slice(2);
await plugin.createDanmakuSession({ connectionId: cid, args: { roomId: fixture.roomId, channel: fixture.roomId } });

const beforeAttach = await plugin.onDanmakuFrame({ connectionId: cid, frameType: "text", text: JSON.stringify({ action: 15, messages: [] }) });
check("未 ATTACH 时心跳仍为关", beforeAttach.timer.mode === "off");

const afterAttach = await plugin.onDanmakuFrame({
  connectionId: cid,
  frameType: "text",
  text: JSON.stringify({ action: 11, channel: String(fixture.roomId), flags: 786432 })
});
check("收到 ATTACHED(11) 后进入直播态", afterAttach.timer.mode === "heartbeat", JSON.stringify(afterAttach.timer));
check("心跳间隔为 15000ms", afterAttach.timer.intervalMs === 15000, String(afterAttach.timer.intervalMs));

const heartbeat = await plugin.onDanmakuFrame({ connectionId: cid, frameType: "text", text: JSON.stringify({ action: 0 }) });
check("入站心跳**不**被原样弹回（回弹会形成对刷风暴）", (heartbeat.writes || []).length === 0, JSON.stringify(heartbeat.writes));
check("入站心跳不影响直播态", heartbeat.timer.mode === "heartbeat");

// 心跳按墙钟截止时间发，所以要让时间「过期」才好观察下一次发送。
// 会话对象挂在 globalThis 上（驱动脚本是全局 eval 的），测试直接改它即可，
// 不需要给生产代码开测试口子。
const sessionState = globalThis.__lp_s17_dmk_sessions[cid];
check("会话状态可从外部观察（inspect）", !!sessionState && sessionState.stage === "live", sessionState && sessionState.stage);

sessionState.lastBeatAt = Date.now() - 20000; // 假装已经过去 20s
const tick1 = await plugin.onDanmakuTick({ connectionId: cid, reason: "heartbeat" });
check("onDanmakuTick 发心跳", (tick1.writes || []).length === 1, JSON.stringify(tick1.writes));
check("tick 心跳是文本帧且 action 0", tick1.writes[0].kind === "text" && JSON.parse(tick1.writes[0].text).action === 0);
const tick2 = await plugin.onDanmakuTick({ connectionId: cid, reason: "heartbeat" });
check("15s 内重复 tick 不重复发（宿主节奏不符时不至于打成密集包）", (tick2.writes || []).length === 0, JSON.stringify(tick2.writes));
check("重复 tick 仍保持心跳 timer", tick2.timer.mode === "heartbeat");

// 收帧路径也要能补心跳：宿主若每次都重装 timer 导致 tick 永不触发，
// 这条路径是连接不被判死的唯一保障。
sessionState.lastBeatAt = Date.now() - 20000;
const busyFrame = await plugin.onDanmakuFrame({
  connectionId: cid,
  frameType: "text",
  text: JSON.stringify({ action: 15, messages: [] })
});
check("收帧路径会按截止时间补心跳", (busyFrame.writes || []).length === 1, JSON.stringify(busyFrame.writes));

const garbage = await plugin.onDanmakuFrame({ connectionId: cid, frameType: "text", text: "这不是 JSON {{{" });
check("非法 JSON 帧不抛错也不产消息", (garbage.messages || []).length === 0 && (garbage.writes || []).length === 0);

const binary = await plugin.onDanmakuFrame({ connectionId: cid, frameType: "binary", bytesBase64: "AAAA" });
check("二进制帧被忽略而非报错", (binary.messages || []).length === 0);

let attachErrorThrew = false;
try {
  await plugin.onDanmakuFrame({
    connectionId: cid,
    frameType: "text",
    text: JSON.stringify({ action: 11, error: { code: 80018, message: "Channel does not exist" } })
  });
} catch (error) {
  attachErrorThrew = /LP_PLUGIN_ERROR/.test(String(error.message));
}
check("ATTACHED 带 error 时抛受控错误", attachErrorThrew);

await plugin.destroyDanmakuSession({ connectionId: cid });
let destroyedThrows = false;
try {
  await plugin.onDanmakuFrame({ connectionId: cid, frameType: "text", text: "{}" });
} catch (error) {
  destroyedThrows = true;
}
check("销毁后再收帧会报 unknown connection", destroyedThrows);

// =====================================================================
// 5. 回归断言：锁住已知样本
// =====================================================================
console.log("\n== 回归断言 ==");
{
  check("存在至少一条聊天消息", replayed.length > 0, replayed[0] ? `${replayed[0].nickname}: ${replayed[0].text}` : "");

  // 挑一条带 8 位 ARGB 颜色的真实聊天，验证 #AARRGGBB → 0xRRGGBB 的归一化
  const colored = oraclePacketsAll
    .filter((p) => Number(p.type) === 3)
    .map((p) => ({ packet: p, color: p.commentMsg.comment.textColor }))
    .filter((x) => typeof x.color === "string" && x.color.length === 9)[0];
  check("夹具里存在 8 位 ARGB 颜色样本", !!colored, colored ? colored.color : "");
  if (colored) {
    const expected = parseInt(colored.color.slice(3), 16);
    const hit = replayed.find(
      (m) => m.nickname === colored.packet.commentMsg.name.text && m.text === colored.packet.commentMsg.comment.text
    );
    check("颜色按 0xRRGGBB 归一化", hit && hit.color === expected, hit ? `实得 ${hit.color}，期望 ${expected}` : "没找到该消息");
  }

  // 显示开关默认值
  check("进场提示默认开（type 27 出现）", replayed.some((m) => m.text === "订阅了主播"));
  check("打工奖励默认关", !replayed.some((m) => m.text === "领取了打工奖励"));
  check("主播字幕默认关", !replayed.some((m) => m.nickname === "字幕"));
  check("信令包不产生空消息（type 6/38/74）", replayed.every((m) => m.text !== "" && m.nickname !== ""));
}

process.exit(summary() ? 1 : 0);
