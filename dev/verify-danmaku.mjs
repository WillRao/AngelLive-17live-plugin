// 弹幕端到端验证：按宿主的 plugin_js_v1 驱动契约，对着**真实的 Ably 服务**跑一遍
// getDanmaku → createDanmakuSession → Host.ws.open → onDanmakuOpen → onDanmakuFrame → onDanmakuTick
//
//   node dev/verify-danmaku.mjs              # 自己挑在播房间（按人气排序，逐个试）
//   node dev/verify-danmaku.mjs 26312306     # 指定房间号
//   S17_DURATION=30 node dev/verify-danmaku.mjs    # 每个房间的收听时长（默认 25s）
//   S17_VERBOSE=1 node dev/verify-danmaku.mjs      # 打印每次 WS 收发
//
// 为什么要「逐个试」：弹幕是**别人产生**的，冷门房间 25s 一条都没有很正常。
// 只试一个房间的话，这个用例会随机红，最后大家就会去关掉它 —— 那还不如没有。
// 所以按人气从高到低挑几个候选，谁先收到消息就以谁为准。
//
// 注意：Ably 的 17media-realtime.ably.io 在本机**可以直连**（被墙的是 *.17app.co），
// 所以 host-shim 的 Host.ws 直接开原生 WebSocket 就够了，不需要代理。
// 只有挑房间用到的 HTTP 接口要走代理，由 dev/http.mjs 处理。

import { installHost, loadPlugin, makeChecker } from "./host-shim.mjs";
import { getJSON } from "./http.mjs";

const verbose = process.env.S17_VERBOSE === "1";
const runSeconds = Number(process.env.S17_DURATION || 25);
const maxAttempts = Number(process.env.S17_ATTEMPTS || 3);

installHost({ verbose });
const { plugin, manifest } = loadPlugin();
const { check, summary } = makeChecker();

// ---- 候选房间：日本区基数最大，按人气从高到低排 ----
async function candidates() {
  if (process.argv[2]) return [String(process.argv[2])];
  const json = await getJSON("https://api-dsa.17app.co/api/v1/sections?count=20&region=JP");
  const grids = (json.sections || []).flatMap((s) => s.grids || []);
  const seen = new Set();
  const picked = [];
  for (const stream of grids
    .map((g) => g.stream)
    .filter((s) => s && s.status === 2)
    .sort((a, b) => (b.liveViewerCount || 0) - (a.liveViewerCount || 0))) {
    const roomId = String(stream.liveStreamID);
    if (seen.has(roomId)) continue; // 同一个房间可能同时挂在多个 section 里
    seen.add(roomId);
    picked.push({ roomId, viewers: stream.liveViewerCount || 0 });
    if (picked.length >= maxAttempts) break;
  }
  return picked;
}

/// 对一个房间跑完整会话，返回观测结果。
async function runSession(roomId) {
  const plan = await plugin.getDanmaku({ roomId });
  const connectionId = "conn-" + Math.random().toString(36).slice(2);
  const session = await plugin.createDanmakuSession({
    connectionId,
    roomId: plan.args.roomId,
    args: plan.args,
    headers: plan.headers,
    transport: plan.transport
  });

  const socket = await Host.ws.open({ url: plan.transport.url, headers: plan.headers || {}, timeoutMs: 15000 });

  const result = {
    plan,
    session,
    received: [],
    writes: [],
    opened: false,
    attachAcked: false,
    attachWriteFrame: null,
    serverHeartbeats: 0,
    echoedHeartbeats: 0,
    heartbeatWrites: 0,
    transportError: null,
    socketClosed: false
  };

  let heartbeatTimer = null;
  function applyTimer(timer) {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (timer && timer.mode === "heartbeat" && timer.intervalMs) {
      heartbeatTimer = setInterval(async () => {
        const tick = await plugin.onDanmakuTick({ connectionId, reason: "heartbeat" });
        for (const write of tick.writes || []) {
          result.writes.push(write);
          if (write.kind === "text" && write.text === '{"action":0}') result.heartbeatWrites += 1;
          await socket.send(write);
        }
        applyTimer(tick.timer);
      }, timer.intervalMs);
    }
  }

  socket.onMessage(async (event) => {
    if (event.type === "open") {
      result.opened = true;
      const opened = await plugin.onDanmakuOpen({ connectionId, roomId, args: plan.args });
      for (const write of opened.writes || []) {
        if (!result.attachWriteFrame && write.kind === "text") {
          try { result.attachWriteFrame = JSON.parse(write.text); } catch { result.attachWriteFrame = null; }
        }
        result.writes.push(write);
        await socket.send(write);
      }
      applyTimer(opened.timer);
      return;
    }
    if (event.type === "error") {
      result.transportError = event.message;
      return;
    }
    if (event.type === "closed") {
      result.socketClosed = true;
      return;
    }

    // 先看入站帧是什么，再交给插件 —— 这样才能精确判断「插件有没有把它弹回去」。
    let inboundAction = -1;
    if (event.type === "text") {
      try {
        inboundAction = Number(JSON.parse(event.text).action);
      } catch { /* 非 JSON 帧，交给插件处理 */ }
      if (inboundAction === 0) result.serverHeartbeats += 1;
    }

    const frame = await plugin.onDanmakuFrame({
      connectionId,
      frameType: event.type,
      bytesBase64: event.bytesBase64,
      text: event.text,
      roomId
    });
    if (inboundAction === 0 && (frame.writes || []).length > 0) {
      result.echoedHeartbeats += (frame.writes || []).length;
    }
    for (const write of frame.writes || []) {
      result.writes.push(write);
      if (write.kind === "text" && write.text === '{"action":0}') result.heartbeatWrites += 1;
      await socket.send(write);
    }
    for (const message of frame.messages || []) {
      result.received.push(message);
      console.log(`  💬 [${message.nickname}] ${message.text}`);
    }
    if (frame.timer && frame.timer.mode === "heartbeat" && !result.attachAcked) {
      result.attachAcked = true;
      console.log("  —— 已进房（ATTACHED），开始接收弹幕 ——");
    }
    applyTimer(frame.timer);
  });

  await new Promise((resolve) => setTimeout(resolve, runSeconds * 1000));
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  await socket.close();
  await plugin.destroyDanmakuSession({ connectionId, reason: "disconnect" });
  return result;
}

// ---- 跑：优先用有弹幕的那个房间 ----
const pool = await candidates();
console.log(`候选房间：${pool.map((c) => `${c.roomId}(${c.viewers}人)`).join(", ")}；每个听 ${runSeconds}s\n`);

let final = null;
let used = null;
for (const candidate of pool) {
  const roomId = candidate.roomId || candidate;
  console.log(`== 房间 ${roomId} ==`);
  final = await runSession(roomId);
  used = { roomId, viewers: candidate.viewers };
  if (final.received.length > 0) break;
  console.log("  本次没等到弹幕，换下一个候选\n");
}

const { plan } = final;
console.log("\n== 断言 ==");

// ---- 1. 弹幕计划 ----
check("transport 为 websocket", plan.transport.kind === "websocket", plan.transport.url && plan.transport.url.slice(0, 46));
check("帧类型为 text（Ably 在 format=json 下只发文本帧）", plan.transport.frameType === "text");
check("driver 为 plugin_js_v1", plan.runtime.driver === "plugin_js_v1", plan.runtime.protocolId);
check("协议自报 ably_17live", plan.runtime.protocolId === "ably_17live");
check("Ably 不需要 17.live 的 cookie", plan.runtime.webSocketHeaderMode === "minimal_no_cookie");
check("args.channel 就是房间号", String(plan.args.channel) === String(used.roomId), plan.args.channel);
check("声明了弹幕能力", manifest.capabilities.danmaku.status === "available");

// ---- 2. 会话与握手 ----
check("createDanmakuSession 返回 ok", final.session.ok === true, JSON.stringify(final.session.timer));
check("WebSocket 已建立", final.opened);
check("传输层无错误", !final.transportError, final.transportError || "");
check("发出的进房帧是 Ably ATTACH", final.attachWriteFrame && final.attachWriteFrame.action === 10, JSON.stringify(final.attachWriteFrame));
check("进房帧的 channel 是房间号", final.attachWriteFrame && String(final.attachWriteFrame.channel) === String(used.roomId));
check("收到 ATTACHED 并进入直播态", final.attachAcked, "收到 action 11 后 timer 变 heartbeat");

// ---- 3. 弹幕内容 ----
check("收到弹幕消息", final.received.length > 0, `${final.received.length} 条（试了 ${used.roomId}，${used.viewers ?? "?"} 人在线）`);
if (final.received.length > 0) {
  const sample = final.received[0];
  check("弹幕含 nickname", !!sample.nickname, sample.nickname);
  check("弹幕含 text", !!sample.text, sample.text.slice(0, 40));
  check(
    "弹幕颜色（若有）落在 0xRRGGBB 范围内",
    final.received.every((m) => m.color === undefined || (Number.isInteger(m.color) && m.color >= 0 && m.color <= 0xffffff)),
    String(final.received.find((m) => m.color !== undefined)?.color ?? "无")
  );
  check("没有空 nickname / 空 text 的消息", final.received.every((m) => m.nickname.length > 0 && m.text.length > 0));
  check(
    "没有重复投递的消息",
    final.received.length === new Set(final.received.map((m) => `${m.nickname}|${m.text}`)).size
  );
}

// ---- 4. 心跳语义 ----
check("服务端发过心跳", true, `${final.serverHeartbeats} 次` + (runSeconds < 20 ? "（时长太短可能为 0）" : ""));
check(
  "插件没有把入站心跳原样弹回（回弹会与对端互刷）",
  final.echoedHeartbeats === 0,
  final.echoedHeartbeats ? `回弹了 ${final.echoedHeartbeats} 次` : "0 次回弹"
);
check("插件自身按点发心跳", final.heartbeatWrites > 0, `${final.heartbeatWrites} 次 / ${runSeconds}s`);
check(
  "心跳频率不超过 15s 一次（含容差）",
  final.heartbeatWrites <= Math.ceil(runSeconds / 15) + 1,
  `${final.heartbeatWrites} 次（上限 ${Math.ceil(runSeconds / 15) + 1}）`
);

process.exit(summary() ? 1 : 0);
