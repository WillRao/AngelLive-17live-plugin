// 17LIVE 弹幕驱动（preload）——由 index.js 的 getDanmaku/createDanmakuSession/... 转发。
//
// 协议：Ably 实时通道（https://ably.com 的线协议，JSON 模式）。
//   连接   wss://17media-realtime.ably.io/?key=<public>&format=json&heartbeats=true&v=1.1&lib=js-web-1.1.25
//   进房   {"action":10,"channel":"<liveStreamID>"}      ← Ably 的 ATTACH
//   回执   {"action":11,"channel":"..."}                 ← ATTACHED
//   收帧   {"action":15,"channel":"...","messages":[{"data":"<base64(gzip(JSON))>"}]}
//   心跳   {"action":0}                                  ← HEARTBEAT
//
// 两个关键事实（都实测过）：
//   1. channel 就是 liveStreamID（房间号），不需要 userId、不需要登录、不需要 token。
//      参考实现 voyagen/17live 会先用户名密码登录再 POST /lives/{id}/enter，
//      但对**只读弹幕**而言那两步是多余的。
//   2. messages[].data 是 base64 再 gzip。宿主 Host.* 里**没有**任何解压能力
//      （JSRuntime 只挂了 http / crypto.md5 / crypto.base64Decode / runtime.loadBuiltinScript），
//      所以下面内联了一份 raw DEFLATE 解码器。这块是纯算法、无 IO，
//      dev/verify-parser.mjs 会用 Node 的 zlib 做独立 oracle 与它逐条对拍。

var __lp_s17_dmk_wsURL =
  "wss://17media-realtime.ably.io/?key=qvDtFQ.0xBeRA:iYWpd3nD2QHE6Sjm&format=json&heartbeats=true&v=1.1&lib=js-web-1.1.25";

/// Ably 服务端 maxIdleInterval = 15s。我们既回服务端的心跳，也自己按这个间隔发。
var __lp_s17_dmk_heartbeatMs = 15000;

// ---------------------------------------------------------------- 显示开关
// 17LIVE 一个房间每 15s 大约 8 条包，其中聊天占一半，另有一堆信令（6/38/74）。
var __lp_s17_dmk_showJoin = true;   // type 18 / 27：进场提示
var __lp_s17_dmk_showReward = false; // type 79：打工奖励播报，秀场房间会吵，默认关
var __lp_s17_dmk_showSubtitle = false; // type 119：主播实时字幕（日/繁/英），默认关
var __lp_s17_dmk_showPoke = false;   // type 47：戳一下
var __lp_s17_dmk_showRedEnvelope = false; // type 51：红包
var __lp_s17_dmk_showAvatar = false; // 是否在弹幕前插头像图（正文始终保留在 text 里）

// ---------------------------------------------------------------- 工具

function _dmk17_throw(code, message, context) {
  if (globalThis.Host && typeof Host.raise === "function") {
    Host.raise(code, message, context || {});
  }
  throw new Error(
    "LP_PLUGIN_ERROR:" +
      JSON.stringify({ code: String(code || "UNKNOWN"), message: String(message || ""), context: context || {} })
  );
}

/// ⚠️ 这是给「JSON.parse 出来的对象」用的，不要和 protobuf 那套字段读取器混用。
/// 混用会静默返回空串 —— 消息一条都出不来，且不报错。
function _dmk17_text(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return "";
  return String(value);
}

function _dmk17_int(value, fallback) {
  var n = Number(value);
  return isFinite(n) ? n : fallback;
}

function _dmk17_base64ToBytes(base64) {
  var binary;
  try {
    binary = globalThis.atob(String(base64 || ""));
  } catch (error) {
    return null;
  }
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
  return bytes;
}

function _dmk17_base64FromBytes(bytes) {
  var chunks = [];
  for (var i = 0; i < bytes.length; i++) chunks.push(String.fromCharCode(bytes[i]));
  return globalThis.btoa(chunks.join(""));
}

function _dmk17_utf8Decode(bytes) {
  var chunks = [];
  for (var i = 0; i < bytes.length; i++) chunks.push(String.fromCharCode(bytes[i]));
  var raw = chunks.join("");
  try {
    return decodeURIComponent(escape(raw));
  } catch (error) {
    return raw;
  }
}

// ---------------------------------------------------------------- raw DEFLATE (inflate)
//
// gzip 容器：10 字节固定头（+ 可选的 FEXTRA/FNAME/FCOMMENT/FHCRC）→ deflate 流 → 8 字节尾
// （CRC32 + ISIZE）。我们只需要中间那段，尾部的 ISIZE 拿来当长度校验。

var __lp_s17_dmk_lenBase = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258
];
var __lp_s17_dmk_lenExtra = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0
];
var __lp_s17_dmk_distBase = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577
];
var __lp_s17_dmk_distExtra = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13
];
var __lp_s17_dmk_clcOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function _dmk17_huff(count, symbol) {
  return { count: count, symbol: symbol };
}

/// 由码长表构造 canonical Huffman 表（同 puff 的 construct）。
function _dmk17_buildHuff(lengths, n) {
  var count = new Array(16);
  var i;
  for (i = 0; i < 16; i++) count[i] = 0;
  for (i = 0; i < n; i++) count[lengths[i]]++;
  count[0] = 0;

  var offs = new Array(16);
  offs[0] = 0;
  for (i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];

  var symbol = new Array(n);
  for (i = 0; i < n; i++) symbol[i] = 0;
  for (i = 0; i < n; i++) {
    if (lengths[i]) symbol[offs[lengths[i]]++] = i;
  }
  return _dmk17_huff(count, symbol);
}

var __lp_s17_dmk_fixedLit = null;
var __lp_s17_dmk_fixedDist = null;

function _dmk17_fixedTables() {
  if (!__lp_s17_dmk_fixedLit) {
    var lit = new Array(288);
    for (var i = 0; i < 288; i++) {
      lit[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
    }
    __lp_s17_dmk_fixedLit = _dmk17_buildHuff(lit, 288);

    var dist = new Array(30);
    for (var j = 0; j < 30; j++) dist[j] = 5;
    __lp_s17_dmk_fixedDist = _dmk17_buildHuff(dist, 30);
  }
  return { lit: __lp_s17_dmk_fixedLit, dist: __lp_s17_dmk_fixedDist };
}

/// input[start, end) 是一段 raw deflate 流。
/// 返回 { out: 字节数组, endPos: 流结束后的字节位置 }。
///
/// endPos 必须精确：deflate 的最后一个块未必字节对齐，收尾时会残留几个填充位，
/// 只把整字节的残留（bitCnt >> 3）退回，剩下的缓冲位算已消费。
function _dmk17_inflateRaw(input, start, end) {
  var pos = start;
  var bitBuf = 0;
  var bitCnt = 0;
  var out = [];

  function bits(need) {
    while (bitCnt < need) {
      if (pos >= end) _dmk17_throw("PARSE", "inflate: 数据提前结束", {});
      bitBuf = bitBuf | (input[pos++] << bitCnt);
      bitCnt += 8;
    }
    var value = bitBuf & ((1 << need) - 1);
    bitBuf >>>= need;
    bitCnt -= need;
    return value;
  }

  /// puff 的逐位回溯解码。
  function decode(huff) {
    var code = 0;
    var first = 0;
    var index = 0;
    for (var len = 1; len <= 15; len++) {
      code |= bits(1);
      var count = huff.count[len];
      if (code - count < first) return huff.symbol[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    return -1;
  }

  function stored() {
    bitBuf = 0;
    bitCnt = 0; // 字节对齐
    if (pos + 4 > end) _dmk17_throw("PARSE", "inflate: stored 块头越界", {});
    var len = input[pos] | (input[pos + 1] << 8);
    var nlen = input[pos + 2] | (input[pos + 3] << 8);
    if ((len ^ 0xffff) !== nlen) _dmk17_throw("PARSE", "inflate: stored 块长度校验失败", {});
    pos += 4;
    if (pos + len > end) _dmk17_throw("PARSE", "inflate: stored 块数据越界", {});
    for (var i = 0; i < len; i++) out.push(input[pos++]);
  }

  function codes(litHuff, distHuff) {
    for (;;) {
      var symbol = decode(litHuff);
      if (symbol < 0) _dmk17_throw("PARSE", "inflate: 无效的 literal/length 码", {});
      if (symbol < 256) {
        out.push(symbol);
        continue;
      }
      if (symbol === 256) return; // 块结束

      symbol -= 257;
      if (symbol >= 29) _dmk17_throw("PARSE", "inflate: length 码越界", { symbol: symbol });
      var length = __lp_s17_dmk_lenBase[symbol] + bits(__lp_s17_dmk_lenExtra[symbol]);

      var distSymbol = decode(distHuff);
      if (distSymbol < 0 || distSymbol >= 30) {
        _dmk17_throw("PARSE", "inflate: 无效的 distance 码", { symbol: distSymbol });
      }
      var distance = __lp_s17_dmk_distBase[distSymbol] + bits(__lp_s17_dmk_distExtra[distSymbol]);
      if (distance > out.length) _dmk17_throw("PARSE", "inflate: 回溯距离超出已解压长度", {});

      // 必须逐字节前向复制：LZ77 允许 source 与 destination 重叠。
      var from = out.length - distance;
      for (var i = 0; i < length; i++) out.push(out[from + i]);
    }
  }

  function dynamic() {
    var hlit = bits(5) + 257;
    var hdist = bits(5) + 1;
    var hclen = bits(4) + 4;
    if (hlit > 286 || hdist > 30) _dmk17_throw("PARSE", "inflate: 动态表头越界", {});

    var lengths = new Array(320);
    var i;
    for (i = 0; i < 320; i++) lengths[i] = 0;
    for (i = 0; i < hclen; i++) lengths[__lp_s17_dmk_clcOrder[i]] = bits(3);

    var clc = _dmk17_buildHuff(lengths.slice(0, 19), 19);

    var index = 0;
    while (index < hlit + hdist) {
      var symbol = decode(clc);
      if (symbol < 0) _dmk17_throw("PARSE", "inflate: 无效的码长码", {});
      if (symbol < 16) {
        lengths[index++] = symbol;
      } else if (symbol === 16) {
        if (index === 0) _dmk17_throw("PARSE", "inflate: 码长重复无前值", {});
        var prev = lengths[index - 1];
        var repeat = 3 + bits(2);
        while (repeat-- > 0 && index < hlit + hdist) lengths[index++] = prev;
      } else if (symbol === 17) {
        var zero = 3 + bits(3);
        while (zero-- > 0 && index < hlit + hdist) lengths[index++] = 0;
      } else {
        var zeros = 11 + bits(7);
        while (zeros-- > 0 && index < hlit + hdist) lengths[index++] = 0;
      }
    }
    if (lengths[256] === 0) _dmk17_throw("PARSE", "inflate: 缺少块结束码", {});

    codes(_dmk17_buildHuff(lengths.slice(0, hlit), hlit), _dmk17_buildHuff(lengths.slice(hlit, hlit + hdist), hdist));
  }

  var last = 0;
  do {
    last = bits(1);
    var type = bits(2);
    if (type === 0) stored();
    else if (type === 1) {
      var fixed = _dmk17_fixedTables();
      codes(fixed.lit, fixed.dist);
    } else if (type === 2) dynamic();
    else _dmk17_throw("PARSE", "inflate: 保留的块类型 3", {});
  } while (!last);

  return { out: out, endPos: pos - (bitCnt >> 3) };
}

/// 剥 gzip 外壳并解压，返回**原始字节**（Uint8Array）。
///
/// 按 gzip 规范逐个 member 解（RFC 1952 允许把多个 member 串在一起，
/// zlib 的 gunzip 也是这么干的）。每个 member 结构：
///   10 字节固定头（+ FEXTRA / FNAME / FCOMMENT / FHCRC）→ deflate 流 → CRC32(4) + ISIZE(4)
/// ISIZE = 原始长度 mod 2^32，用它兜住 inflate 的静默错误。
function _dmk17_gunzipBytes(bytes) {
  if (!bytes || !bytes.length) return new Uint8Array(0);
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    return bytes;
  }
  if (bytes[2] !== 8) _dmk17_throw("PARSE", "gzip: 不支持的压缩方法 " + bytes[2], {});

  var chunks = [];
  var total = 0;
  var cursor = 0;
  var members = 0;

  while (cursor + 18 <= bytes.length && bytes[cursor] === 0x1f && bytes[cursor + 1] === 0x8b) {
    var flags = bytes[cursor + 3];
    var pos = cursor + 10;

    if (flags & 0x04) {
      if (pos + 2 > bytes.length) _dmk17_throw("PARSE", "gzip: FEXTRA 越界", {});
      pos += 2 + (bytes[pos] | (bytes[pos + 1] << 8));
    }
    if (flags & 0x08) {
      while (pos < bytes.length && bytes[pos] !== 0) pos++;
      pos++;
    }
    if (flags & 0x10) {
      while (pos < bytes.length && bytes[pos] !== 0) pos++;
      pos++;
    }
    if (flags & 0x02) pos += 2;
    if (pos + 8 > bytes.length) _dmk17_throw("PARSE", "gzip: 头部越界", {});

    var result = _dmk17_inflateRaw(bytes, pos, bytes.length);
    var raw = result.out;

    // ISIZE 在 CRC32 之后，位于 deflate 流结束之后。
    var trailer = result.endPos;
    if (trailer + 8 > bytes.length) _dmk17_throw("PARSE", "gzip: 尾部越界", {});
    var isize =
      (bytes[trailer + 4] | (bytes[trailer + 5] << 8) | (bytes[trailer + 6] << 16) | (bytes[trailer + 7] << 24)) >>> 0;
    if (isize !== raw.length >>> 0) {
      _dmk17_throw("PARSE", "gzip: 解压长度与 ISIZE 不符（" + raw.length + " vs " + isize + "）", {});
    }

    chunks.push(raw);
    total += raw.length;
    cursor = trailer + 8;
    members += 1;
  }

  if (!members) _dmk17_throw("PARSE", "gzip: 没解析出任何 member", {});

  var out = new Uint8Array(total);
  var offset = 0;
  for (var c = 0; c < chunks.length; c++) {
    for (var i = 0; i < chunks[c].length; i++) out[offset++] = chunks[c][i] & 0xff;
  }
  return out;
}

/// 解压并当 UTF-8 文本返回；不是 gzip 就原样当文本。
function _dmk17_gunzip(bytes) {
  if (!bytes || !bytes.length) return "";
  return _dmk17_utf8Decode(_dmk17_gunzipBytes(bytes));
}

// ---------------------------------------------------------------- 消息映射

/// 17LIVE 的颜色写作 "#AARRGGBB"（8 位）或 "#RRGGBB"（6 位），宿主要的是 UInt32 的 0xRRGGBB。
function _dmk17_parseColor(value) {
  var raw = _dmk17_text(value).trim();
  if (!raw) return null;
  if (raw.charAt(0) === "#") raw = raw.slice(1);
  if (!/^[0-9a-fA-F]+$/.test(raw)) return null;
  if (raw.length === 8) raw = raw.slice(2); // 丢掉 alpha
  if (raw.length === 6) return parseInt(raw, 16);
  return null;
}

function _dmk17_makeMessage(text, nickname, color, segments) {
  var message = { text: String(text), nickname: String(nickname || "17LIVE用户") };
  if (typeof color === "number" && isFinite(color)) message.color = color;
  if (segments && segments.length) message.segments = segments;
  return message;
}

function _dmk17_badge(upload) {
  if (!__lp_s17_dmk_showAvatar) return null;
  var url = _dmk17_text(upload);
  if (!url) return null;
  if (url.indexOf("http://") === 0) url = "https://" + url.slice("http://".length);
  return url;
}

/// 一条解压后的包 → 零到一条弹幕。
///
/// 实测样本（2026-09-30，房间 14209725，60s / 33 包）：
///   type 3   聊天       commentMsg.name.text + commentMsg.comment.text
///   type 6   时长信令   liveinfoChange.duration          ← 忽略
///   type 27  订阅进场   subscriberEnterMsg.displayName
///   type 38  人气信令   liveinfo.liveViewerCount         ← 忽略
///   type 74  空包       {}                               ← 忽略
///   type 79  打工奖励   laborReceiveRewardMsg.userInfo.displayName
///   type 119 主播字幕   subtitle.subtitle.{JP,TW,EN}
///   type 18/47/51 未在本轮抓到，按参考实现（voyagen/17live）的字段路径解析，取不到就丢弃。
function _dmk17_mapPacket(packet) {
  var type = _dmk17_int(packet && packet.type, -1);

  if (type === 3) {
    var cm = packet.commentMsg || {};
    var text = _dmk17_text(cm.comment && cm.comment.text).trim();
    if (!text) return [];
    var nickname = _dmk17_text(cm.name && cm.name.text).trim() || "17LIVE用户";
    var color = _dmk17_parseColor(cm.comment && cm.comment.textColor);
    if (color === null) color = _dmk17_parseColor(cm.name && cm.name.textColor);

    var avatar = _dmk17_badge(cm.avatar && cm.avatar.URL);
    var segments = avatar
      ? [
          { type: "image", url: avatar, width: 20, height: 20, alt: nickname },
          { type: "text", text: " " + text }
        ]
      : null;
    return [_dmk17_makeMessage(text, nickname, color, segments)];
  }

  if (type === 18) {
    if (!__lp_s17_dmk_showJoin) return [];
    var join = packet.commentMsg || {};
    var who =
      _dmk17_text(join.displayUser && join.displayUser.displayName).trim() ||
      _dmk17_text(join.name && join.name.text).trim() ||
      _dmk17_text(join.displayName).trim();
    if (!who) return [];
    return [_dmk17_makeMessage("进入了直播间", who, null, null)];
  }

  if (type === 27) {
    if (!__lp_s17_dmk_showJoin) return [];
    var sub = packet.subscriberEnterMsg || {};
    var subName = _dmk17_text(sub.displayName).trim();
    if (!subName) return [];
    return [_dmk17_makeMessage("订阅了主播", subName, null, null)];
  }

  if (type === 79) {
    if (!__lp_s17_dmk_showReward) return [];
    var reward = packet.laborReceiveRewardMsg || {};
    var rewardName = _dmk17_text(reward.userInfo && reward.userInfo.displayName).trim();
    if (!rewardName) return [];
    return [_dmk17_makeMessage("领取了打工奖励", rewardName, null, null)];
  }

  if (type === 119) {
    if (!__lp_s17_dmk_showSubtitle) return [];
    var subtitle = packet.subtitle || {};
    var lines = subtitle.subtitle || {};
    var body =
      _dmk17_text(lines.JP).trim() || _dmk17_text(lines.TW).trim() || _dmk17_text(lines.EN).trim();
    if (!body) return [];
    return [_dmk17_makeMessage(body, "字幕", null, null)];
  }

  if (type === 47) {
    if (!__lp_s17_dmk_showPoke) return [];
    var poke = (packet.pokeInfo || packet.pokeMsg || {}).sender || {};
    var poker = _dmk17_text(poke.displayName).trim();
    if (!poker) return [];
    return [_dmk17_makeMessage("戳了一下", poker, null, null)];
  }

  if (type === 51) {
    if (!__lp_s17_dmk_showRedEnvelope) return [];
    return [_dmk17_makeMessage("发了一个红包", "17LIVE", null, null)];
  }

  return [];
}

/// Ably 帧 → 包列表。data 是 base64(gzip(json))，也可能是（上游没用二进制时）直接的对象。
function _dmk17_packetsFromMessage(message) {
  var data = message && message.data;
  if (data === undefined || data === null) return [];

  if (typeof data === "object") return [data];

  var bytes = _dmk17_base64ToBytes(data);
  if (!bytes || !bytes.length) return [];

  var text = _dmk17_gunzip(bytes);
  if (!text) return [];
  var trimmed = text.replace(/^\s+/, "");
  if (!trimmed || trimmed.charAt(0) !== "{" || trimmed.charAt(trimmed.length - 1) !== "}") return [];

  try {
    return [JSON.parse(trimmed)];
  } catch (error) {
    return [];
  }
}

// ---------------------------------------------------------------- 会话状态机

var __lp_s17_dmk_sessions = Object.create(null);

function _dmk17_session(connectionId) {
  var id = String(connectionId || "");
  var session = __lp_s17_dmk_sessions[id];
  if (!session) _dmk17_throw("INVALID_ARGS", "unknown danmaku connection: " + id, { connectionId: id });
  return session;
}

function _dmk17_timer(active) {
  return active ? { mode: "heartbeat", intervalMs: __lp_s17_dmk_heartbeatMs } : { mode: "off" };
}

function _dmk17_textWrite(object) {
  return { kind: "text", text: JSON.stringify(object) };
}

/// 按**墙钟截止时间**决定要不要发心跳，而不是只依赖宿主按 timer 回调的间隔。
///
/// 原因：宿主每次拿到返回值都可能重新装载 timer，而弹幕帧可能在 15s 内来好几条，
/// 于是「每帧重置一次 15s 定时器」会让定时器永远不触发 —— 心跳从此再不发出，
/// 连接被对端按 connectionStateTtl(120s) 判死。改成记上次发送时间，
/// 任何一个回调（收帧或 tick）先到就先补，这样只要求「有回调」，
/// 不要求「回调节奏恰好对得上」。
function _dmk17_dueHeartbeat(session, force) {
  if (session.stage !== "live") return null;
  var now = Date.now();
  if (!force && now - session.lastBeatAt < __lp_s17_dmk_heartbeatMs) return null;
  session.lastBeatAt = now;
  return _dmk17_textWrite({ action: 0 });
}

globalThis.__lp_s17_danmaku = {
  wsURL: __lp_s17_dmk_wsURL,

  /// 供离线测试直接调用 inflate（verify-parser.mjs 用它跟 zlib 对拍）。
  /// 文本版：返回 UTF-8 字符串。
  _inflateGzipBase64: function (base64) {
    var bytes = _dmk17_base64ToBytes(base64);
    if (!bytes) return null;
    return _dmk17_gunzip(bytes);
  },

  /// 字节版：返回解压结果的 base64。
  /// 二进制负载按 UTF-8 解码会有损（非法字节回退成 latin1），
  /// 所以 inflate 的字节级正确性必须靠这个入口对拍，不能用上面的文本版。
  _inflateGzipBytesBase64: function (base64) {
    var bytes = _dmk17_base64ToBytes(base64);
    if (!bytes) return null;
    return _dmk17_base64FromBytes(_dmk17_gunzipBytes(bytes));
  },

  async createDanmakuSession(payload) {
    var connectionId = String((payload && payload.connectionId) || "");
    var args = (payload && payload.args) || {};
    var roomId = String(
      args.roomId || args.channel || (payload && payload.roomId) || ""
    ).trim();

    if (!connectionId) _dmk17_throw("INVALID_ARGS", "connectionId is required", { field: "connectionId" });
    if (!/^\d+$/.test(roomId)) {
      _dmk17_throw("INVALID_ARGS", "17LIVE 弹幕频道号必须是纯数字 liveStreamID", { roomId: roomId });
    }

    __lp_s17_dmk_sessions[connectionId] = {
      connectionId: connectionId,
      roomId: roomId,
      stage: "attaching",
      lastBeatAt: 0,
      packets: 0,
      messages: 0
    };
    return { ok: true, timer: _dmk17_timer(false) };
  },

  async onDanmakuOpen(payload) {
    var session = _dmk17_session(payload && payload.connectionId);
    session.stage = "attaching";
    // Ably 的 ATTACH：action 10 + channel。
    return {
      writes: [_dmk17_textWrite({ action: 10, channel: session.roomId })],
      timer: _dmk17_timer(false)
    };
  },

  async onDanmakuFrame(payload) {
    var session = _dmk17_session(payload && payload.connectionId);
    var frameType = String((payload && payload.frameType) || "");
    var writes = [];
    var messages = [];

    // Ably 在 format=json 下只发文本帧；二进制帧不是我们认识的协议，忽略。
    if (frameType !== "text") {
      return { writes: writes, messages: messages, timer: _dmk17_timer(session.stage === "live") };
    }

    var outer;
    try {
      outer = JSON.parse(String((payload && payload.text) || ""));
    } catch (error) {
      return { writes: writes, messages: messages, timer: _dmk17_timer(session.stage === "live") };
    }

    var action = _dmk17_int(outer && outer.action, -1);

    // 0 = HEARTBEAT。
    // ⚠️ **刻意不回**。实测把入站心跳原样弹回去会让两边互刷：
    // 同理回应 → 对端再发 → 再回应，20s 内入站心跳从 1 次放大到 8 次（见 dev/verify-danmaku.mjs）。
    // Ably 的保活判据是 connectionStateTtl（120s）内有没有收到**任何**东西，
    // 而我们自己每 15s 就发一次心跳（onDanmakuTick），单边发送已经足够。
    if (action === 0) {
      return { writes: writes, messages: messages, timer: _dmk17_timer(session.stage === "live") };
    }

    // 11 = ATTACHED。带 error 表示频道没进去（房间号错 / 频道已关闭）。
    if (action === 11) {
      var attachError = outer.error;
      if (attachError) {
        _dmk17_throw("UPSTREAM", "17LIVE 弹幕进房失败：" + _dmk17_text(attachError.message), {
          roomId: session.roomId,
          code: _dmk17_text(attachError.code)
        });
      }
      session.stage = "live";
      session.lastBeatAt = Date.now();
      return { writes: writes, messages: messages, timer: _dmk17_timer(true) };
    }

    // 2/9 = NACK / ERROR。
    if (action === 2 || action === 9) {
      _dmk17_throw("UPSTREAM", "17LIVE 弹幕通道报错：" + _dmk17_text(outer.error && outer.error.message), {
        roomId: session.roomId,
        action: action
      });
    }

    // 13 = DETACHED：频道掉了，交给宿主的重连逻辑处理。
    if (action === 13) {
      session.stage = "detached";
      _dmk17_throw("UPSTREAM", "17LIVE 弹幕频道已断开", { roomId: session.roomId });
    }

    // 15 = MESSAGE。
    if (action === 15) {
      var list = (outer && outer.messages) || [];
      for (var i = 0; i < list.length; i++) {
        var packets;
        try {
          packets = _dmk17_packetsFromMessage(list[i]);
        } catch (error) {
          // 单条包解不开不该带走整帧 —— 与宿主「逐条容错解码」的策略保持一致。
          continue;
        }
        for (var j = 0; j < packets.length; j++) {
          session.packets += 1;
          var mapped = _dmk17_mapPacket(packets[j]);
          for (var k = 0; k < mapped.length; k++) {
            messages.push(mapped[k]);
            session.messages += 1;
          }
        }
      }
    }

    // 顺带补心跳：信道忙时服务端不会发空闲心跳，但我们仍要保证自己按点出声。
    var dueBeat = _dmk17_dueHeartbeat(session, false);
    if (dueBeat) writes.push(dueBeat);

    return { writes: writes, messages: messages, timer: _dmk17_timer(session.stage === "live") };
  },

  async onDanmakuTick(payload) {
    var session = _dmk17_session(payload && payload.connectionId);
    // tick 也走同一套截止时间判断，而不是无条件发。
    // 宿主按我们声明的 intervalMs 回调时两者等价（到点就是到点）；
    // 但宿主若因为别的原因更频繁地 tick（或与我们声明的节奏不一致），
    // 无条件发就会把心跳打成密集小包 —— 这正是要避免的。
    var write = _dmk17_dueHeartbeat(session, false);
    if (!write) {
      return { writes: [], timer: _dmk17_timer(session.stage === "live") };
    }
    return { writes: [write], timer: _dmk17_timer(true) };
  },

  async destroyDanmakuSession(payload) {
    var id = String((payload && payload.connectionId) || "");
    delete __lp_s17_dmk_sessions[id];
    return { ok: true, timer: _dmk17_timer(false) };
  }
};
