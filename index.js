// 17LIVE（17直播）1.0.0 — AngelLive JS 插件
//
// 端点来源（2026-09-30 实测，全部免鉴权）：
//   地区   GET  https://api-dsa.17app.co/api/v1/liveStreams/regionList
//   列表   GET  https://api-dsa.17app.co/api/v1/sections?count=20&region=XX[&cursor=...]
//   详情   GET  https://api-dsa.17app.co/api/v1/lives/<liveStreamID>
//   搜索   GET  https://api-dsa.17app.co/api/v1/liveStreams/search?query=xxx
//
// 房间号的真实语义：**liveStreamID**（数字）。注意不是 userID（UUID）——
// /api/v1/lives/<uuid> 会返回 errorCode 7 "invalid roomID"。
// 页面链接形如 https://17.live/live/<liveStreamID>。
//
// 关于网络：本机（大陆网络）对 *.17app.co 做 SNI 拦截，直连只会拿到 502 拦截页，
// 必须走代理才能调试。真机上 App 用自己的 URLSession，与此无关。

var __lp_s17_apiHost = "https://api-dsa.17app.co";
var __lp_s17_pageSize = 20;

/// /sections 的 count 实测上限就是页大小 20（给 30 直接报错），别调大。
var __lp_s17_maxPages = 12;

var __lp_s17_headers = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "accept-language": "zh-Hans-CN;q=1,zh;q=0.9,en;q=0.8",
  accept: "application/json, text/plain, */*",
  origin: "https://17.live",
  referer: "https://17.live/"
};

/// 播放线路对 Referer 不敏感，但带上更保险。
var __lp_s17_playHeaders = { Referer: "https://17.live/", Origin: "https://17.live" };

/// regionList 的地区码 → 中文名。没收录的地区码回退成原始码。
var __lp_s17_regionNames = {
  GLOBAL: "全球",
  JP: "日本",
  TW: "中国台湾",
  HK: "中国香港",
  KR: "韩国",
  SG: "新加坡",
  MY: "马来西亚",
  TH: "泰国",
  ID: "印度尼西亚",
  VN: "越南",
  PH: "菲律宾",
  IN: "印度",
  US: "美国",
  CN: "中国大陆"
};

/// regionList 挂掉时的兜底（按实测在播量排序）。
var __lp_s17_regionFallback = ["JP", "GLOBAL", "TW", "HK"];

// ------------------------------------------------------------------ 工具

function _s17_throw(code, message, context) {
  if (globalThis.Host && typeof Host.raise === "function") {
    Host.raise(code, message, context || {});
  }
  throw new Error(
    "LP_PLUGIN_ERROR:" +
      JSON.stringify({ code: String(code || "UNKNOWN"), message: String(message || ""), context: context || {} })
  );
}

function _s17_text(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return "";
  return String(value);
}

function _s17_number(value, fallback) {
  var n = Number(value);
  return isFinite(n) ? n : fallback;
}

/// 17LIVE 的图片有 http 与 https 两套。cdn.17app.co 的 http 直接 500，必须升到 https。
function _s17_https(url) {
  var text = _s17_text(url).trim();
  if (!text) return "";
  if (text.indexOf("//") === 0) return "https:" + text;
  if (text.indexOf("http://") === 0) return "https://" + text.slice("http://".length);
  return text;
}

/// 头像字段只给文件名（如 e8425bf2-....jpg），要自己拼 CDN 前缀；
/// 有时又已经是完整 URL，两种情况都要吃。
function _s17_picture(value) {
  var text = _s17_text(value).trim();
  if (!text) return "";
  if (text.indexOf("http://") === 0 || text.indexOf("https://") === 0) return _s17_https(text);
  return "https://cdn.17app.co/" + text.replace(/^\/+/, "");
}

/// 发请求并尽力解析 JSON，**不因 HTTP 状态码抛错**。
/// 返回 { status, json }。网络层失败或响应体不是 JSON 才抛。
///
/// 为什么需要这个：17LIVE 把业务错误塞在非 2xx 里 —— 房间不存在是
/// HTTP 520 + {"errorCode":0,"errorMessage":"stream not found"}，
/// 只看状态码会把它当成上游故障，插件就没法给出「房间不存在」这种准确提示。
async function _s17_requestJSON(url, timeoutSeconds) {
  var response = await Host.http.request({
    url: url,
    method: "GET",
    headers: __lp_s17_headers,
    timeout: timeoutSeconds || 20
  });
  var status = Number((response && response.status) || 0);
  var body = _s17_text(response && response.bodyText);
  var json = null;
  if (body) {
    try {
      json = JSON.parse(body);
    } catch (error) {
      json = null;
    }
  }
  return { status: status, json: json, body: body };
}

async function _s17_getJSON(url, timeoutSeconds) {
  var result = await _s17_requestJSON(url, timeoutSeconds);
  if (result.status >= 400) {
    _s17_throw("UPSTREAM", "17LIVE 返回 HTTP " + result.status + "：" + url, { url: url, status: result.status });
  }
  if (!result.body) return null;
  if (result.json === null) {
    _s17_throw("PARSE", "17LIVE 返回体不是 JSON：" + result.body.slice(0, 160), { url: url });
  }
  return result.json;
}

/// 上游用 errorMessage 表达业务语义；这里统一归一化成插件的错误码。
function _s17_isMissingStream(json) {
  if (!json) return false;
  var message = _s17_text(json.errorMessage).toLowerCase();
  return message.indexOf("stream not found") >= 0 || message.indexOf("invalid roomid") >= 0;
}

/// 房间对象字段路径（/lives/{id} 与 /sections 里的 stream 是同一套结构，但前者少 gridStyle 之类）：
///   liveStreamID  数字房间号
///   userID        主播 UUID
///   userInfo      { displayName, name, picture }
///   caption       房间标题
///   coverPhoto    http://cdn.17app.co/snapshot/<userID>?t=...（需升 https）
///   status        2 = 在播
///   liveViewerCount 当前人气
function _s17_roomFromStream(stream) {
  var s = stream || {};
  var roomId = _s17_text(s.liveStreamID);
  if (!roomId) return null;

  var user = s.userInfo || {};
  var cover = _s17_https(s.coverPhoto);
  var head = _s17_picture(user.picture);
  if (!cover && head) cover = head;

  var title = _s17_text(s.caption);
  if (!title) {
    // 标题为空时用 hashtag 兜一下，避免列表里出现空白卡片。
    var tags = s.hashtags || [];
    var texts = [];
    for (var i = 0; i < tags.length && texts.length < 3; i++) {
      var tag = _s17_text(tags[i] && tags[i].text);
      if (tag) texts.push("#" + tag);
    }
    title = texts.join(" ");
  }

  return {
    userName: _s17_text(user.displayName || user.name || user.openID),
    roomTitle: title,
    roomCover: cover,
    userHeadImg: head,
    liveState: _s17_liveStateFromStatus(s.status),
    userId: _s17_text(s.userID),
    roomId: roomId,
    liveWatchedCount: _s17_text(_s17_number(s.liveViewerCount, 0))
  };
}

/// 实测 status：2 = 在播；0 = 未开播 / 节目预告（programsV2 里的条目全是 0）。
/// 只有 2 才算直播中，其余一律按关播处理，避免把预告卡片当成能播的房间。
function _s17_liveStateFromStatus(status) {
  return _s17_number(status, -1) === 2 ? "1" : "0";
}

// ------------------------------------------------------------------ 列表

async function _s17_sections(region, cursor) {
  var url =
    __lp_s17_apiHost +
    "/api/v1/sections?count=" +
    __lp_s17_pageSize +
    "&region=" +
    encodeURIComponent(region);
  if (cursor) url += "&cursor=" + encodeURIComponent(cursor);

  var payload = await _s17_getJSON(url);
  if (!payload) return { rooms: [], cursor: "" };

  // 实测：这个接口是**扁平**的 { cursor, sections }，没有 data 包装。
  // 但保留 data 分支以防上游改版。
  var root = payload.data && payload.data.sections ? payload.data : payload;
  var sections = root.sections || [];

  var rooms = [];
  var seen = {};
  for (var i = 0; i < sections.length; i++) {
    var grids = (sections[i] && sections[i].grids) || [];
    for (var j = 0; j < grids.length; j++) {
      var stream = grids[j] && grids[j].stream;
      // grids 里混着录播回放（ArchiveVideo）、剪辑（ArchiveClip）、节目预告，
      // 只有 status === 2 是真正在推流的房间。
      if (!stream || _s17_number(stream.status, -1) !== 2) continue;
      var room = _s17_roomFromStream(stream);
      if (!room || seen[room.roomId]) continue;
      seen[room.roomId] = true;
      rooms.push(room);
    }
  }
  return { rooms: rooms, cursor: _s17_text(root.cursor) };
}

/// 这个接口是**无状态**的：第 N 页必须靠第 N-1 页返回的 cursor 才能取到。
/// 所以取第 page 页要顺序走完前面 page-1 页。
///
/// 顺带解决重复问题：实测相邻两页有约 18 个房间重叠（TopSearched 这类 section 会
/// 固定挂在首页），沿路把见过的 roomId 攒起来，翻到目标页时过滤掉即可。
async function _s17_roomsPage(region, page) {
  var target = Math.max(1, Math.min(__lp_s17_maxPages, Math.floor(_s17_number(page, 1))));

  var cursor = "";
  var seen = {};
  var current = [];

  for (var i = 1; i <= target; i++) {
    var result = await _s17_sections(region, cursor);
    var fresh = [];
    for (var j = 0; j < result.rooms.length; j++) {
      var room = result.rooms[j];
      if (seen[room.roomId]) continue;
      seen[room.roomId] = true;
      fresh.push(room);
    }
    if (i === target) {
      current = fresh;
      break;
    }
    cursor = result.cursor;
    if (!cursor) break; // 没有更多了
  }
  return current;
}

// ------------------------------------------------------------------ 详情 / 取流

async function _s17_streamInfo(roomId) {
  var id = _s17_roomIdFromInput(roomId);
  if (!id) _s17_throw("INVALID_ARGS", "roomId is required", { field: "roomId" });

  var result = await _s17_requestJSON(__lp_s17_apiHost + "/api/v1/lives/" + encodeURIComponent(id));

  var stream = result.json && (result.json.data && result.json.data.liveStreamID ? result.json.data : result.json);
  if (!stream || !stream.liveStreamID) {
    // 实测：房间不存在 = HTTP 520 + {"errorCode":0,"errorMessage":"stream not found"}。
    if (_s17_isMissingStream(result.json)) {
      _s17_throw("NOT_FOUND", "17LIVE 房间不存在或已下播：" + id, { roomId: id });
    }
    _s17_throw("UPSTREAM", "17LIVE 详情接口异常（HTTP " + result.status + "）：" + id, {
      roomId: id,
      status: result.status,
      body: result.body.slice(0, 160)
    });
  }
  return stream;
}

/// 把 https 那条线路（provider 5，wansu）的各个清晰度展开。
///
/// 实测 m3u8 换扩展名后返回的是标准 master playlist（带 100ycdn 重定向），
/// BANDWIDTH 依次为：plain 3228000 / _h264 2816000 / _QEHDSA 1859000 / _LBHDSA 698000。
function _s17_hlsFromFlv(url) {
  var text = _s17_text(url);
  if (!text) return "";
  var idx = text.indexOf(".flv");
  if (idx < 0) return "";
  return text.slice(0, idx) + ".m3u8" + text.slice(idx + 4);
}

function _s17_quality(roomId, title, qn, url, kind, tier) {
  return {
    roomId: _s17_text(roomId),
    title: title,
    qn: qn,
    url: url,
    liveCodeType: kind,
    liveType: "17live",
    headers: __lp_s17_playHeaders,
    requestContext: { tier: tier, kind: kind }
  };
}

/// 把上游返回的 rtmpUrls 展开成清晰度列表。
///
/// 上游按 provider 给两条线，**顺序本身就是平台自己的偏好**（provider 5 在前）：
///   provider 5  wansu-global-pull-rtmp-latency.17app.co   https  ← 唯一支持 HLS 的线路
///   provider 17 tencent-global-pull-rtmp.17app.co         http   ← 只有 FLV
///
/// 实测（2026-09-30）：
///   * wansu 的 .flv 换成 .m3u8 会返回标准 master playlist（再重定向到 100ycdn，
///     URL 上带一次性 wsSession 鉴权），BANDWIDTH 依次为
///     原画 3228000 / _h264 2816000 / _QEHDSA 1859000 / _LBHDSA 698000。
///   * tencent 的 https 握手空回、404，只有 http 可用。
///   * 两条线的可用性会各自独立地抖动：探测过程中 wansu 曾被限流到整段时间全 000，
///     而 tencent 照常能拉下 1.4MB。所以**两种线路都要给出来**，让用户能手动切换，
///     只给一条的话遇到单边故障就是「这个平台全挂了」。
///   * http 不影响播放：App 的 iOS / macOS / tvOS 三个 Info.plist 都开了
///     NSAllowsArbitraryLoads。
function _s17_playbackQualities(roomId, stream) {
  var list = (stream && stream.rtmpUrls) || [];
  var httpsEntry = null;
  var httpEntry = null;

  for (var i = 0; i < list.length; i++) {
    var entry = list[i] || {};
    var url = _s17_text(entry.url || entry.webUrl || entry.urlHighQuality);
    if (!url) continue;
    if (!httpsEntry && url.indexOf("https://") === 0) httpsEntry = entry;
    if (!httpEntry && url.indexOf("http://") === 0) httpEntry = entry;
  }

  var qualities = [];
  var pushed = {};
  function push(title, qn, rawUrl, kind, tier) {
    var url = _s17_text(rawUrl);
    if (!url || pushed[url]) return;
    pushed[url] = true;
    qualities.push(_s17_quality(roomId, title, qn, url, kind, tier));
  }

  // https 侧（wansu）：四档 HLS + 一条 FLV 兜底。
  // HLS 走 AVPlayer 原生解封装，比 FLV 稳，所以在同一 provider 内 HLS 优先。
  if (httpsEntry) {
    push("原画", 1, _s17_hlsFromFlv(httpsEntry.urlHighQuality || httpsEntry.url), "m3u8", "origin");
    push("高清", 2, _s17_hlsFromFlv(httpsEntry.urlQualityEnhancedHD), "m3u8", "enhanced");
    push("H.264", 3, _s17_hlsFromFlv(httpsEntry.url264), "m3u8", "h264");
    push("流畅", 4, _s17_hlsFromFlv(httpsEntry.urlLowBitrateHD || httpsEntry.urlLowQuality), "m3u8", "low");
    push("原画 (FLV)", 5, httpsEntry.urlHighQuality || httpsEntry.url, "flv", "origin_flv");
  }

  // http 侧（tencent）：只有 FLV，作为另一条独立线路给出。
  if (httpEntry) {
    push("备用线路 原画", 6, httpEntry.urlHighQuality || httpEntry.url, "flv", "backup_origin_flv");
    push("备用线路 流畅", 7, httpEntry.urlLowQuality, "flv", "backup_low_flv");
  }

  return qualities;
}

// ------------------------------------------------------------------ 房间号解析

/// 房间号永远以 liveStreamID（数字）为准。能吃的输入：
///   29796292
///   https://17.live/live/29796292
///   https://17.live/zh-Hant/live/29796292?...
///   17.live/live/29796292
function _s17_roomIdFromInput(input) {
  var text = _s17_text(input).trim();
  if (!text) return "";
  if (/^\d{4,}$/.test(text)) return text;

  var match = text.match(/[?&]liveStreamID=(\d+)/i);
  if (match) return match[1];
  match = text.match(/17\.live\/[^\s?#]*\/live\/(\d+)/i);
  if (match) return match[1];
  match = text.match(/\/(?:live|lives)\/(\d+)/i);
  if (match) return match[1];
  // 最后兜底：URL 里任意一段长数字。UUID 型 userID 不会命中。
  match = text.match(/(?:^|[^\d])(\d{5,})(?:[^\d]|$)/);
  return match ? match[1] : "";
}

// ------------------------------------------------------------------ 导出

globalThis.LiveParsePlugin = {
  apiVersion: 1,

  async getCategories() {
    var regions = [];
    try {
      var payload = await _s17_getJSON(__lp_s17_apiHost + "/api/v1/liveStreams/regionList");
      var list = (payload && (payload.regionList || (payload.data && payload.data.regionList))) || [];
      for (var i = 0; i < list.length; i++) {
        var code = _s17_text(list[i] && list[i].region).toUpperCase();
        if (!code) continue;
        regions.push({ code: code, count: _s17_number(list[i] && list[i].liveCount, 0) });
      }
    } catch (error) {
      regions = [];
    }

    if (!regions.length) {
      for (var k = 0; k < __lp_s17_regionFallback.length; k++) {
        regions.push({ code: __lp_s17_regionFallback[k], count: 0 });
      }
    }

    // 在播多的排前面 —— 用户点进去第一眼就有内容。
    regions.sort(function (a, b) {
      return b.count - a.count;
    });

    var categories = [];
    for (var n = 0; n < regions.length; n++) {
      var region = regions[n];
      var title = __lp_s17_regionNames[region.code] || region.code;
      categories.push({
        id: region.code,
        title: title,
        icon: "",
        biz: region.code,
        subList: [
          {
            id: region.code,
            parentId: region.code,
            title: title,
            icon: "",
            biz: region.code
          }
        ]
      });
    }
    return categories;
  },

  async getRooms(payload) {
    var category = (payload && payload.category) || {};
    var region = _s17_text(
      (payload && payload.parentBiz) || category.biz || category.id || (payload && payload.id)
    ).toUpperCase();
    if (!region) region = __lp_s17_regionFallback[0];

    var page = _s17_number((payload && payload.page) || 1, 1);
    return await _s17_roomsPage(region, page);
  },

  async getRoomDetail(payload) {
    var roomId = _s17_roomIdFromInput((payload && payload.roomId) || "");
    if (!roomId) _s17_throw("INVALID_ARGS", "roomId is required", { field: "roomId" });

    var stream = await _s17_streamInfo(roomId);
    var room = _s17_roomFromStream(stream);
    if (!room) _s17_throw("NOT_FOUND", "17LIVE 房间信息缺失：" + roomId, { roomId: roomId });
    return room;
  },

  async getLiveState(payload) {
    var roomId = _s17_roomIdFromInput((payload && payload.roomId) || "");
    if (!roomId) _s17_throw("INVALID_ARGS", "roomId is required", { field: "roomId" });

    var stream;
    try {
      stream = await _s17_streamInfo(roomId);
    } catch (error) {
      return { liveState: "0" };
    }
    return { liveState: _s17_liveStateFromStatus(stream.status) };
  },

  async getPlayback(payload) {
    var roomId = _s17_roomIdFromInput((payload && payload.roomId) || "");
    if (!roomId) _s17_throw("INVALID_ARGS", "roomId is required", { field: "roomId" });

    var stream = await _s17_streamInfo(roomId);
    var qualities = _s17_playbackQualities(roomId, stream);
    if (!qualities.length) {
      _s17_throw("NOT_FOUND", "17LIVE 未返回可播地址（房间可能已下播）：" + roomId, { roomId: roomId });
    }

    return [
      {
        cdn: "17LIVE",
        displayName: "默认线路",
        requestContext: { roomId: roomId },
        qualitys: qualities
      }
    ];
  },

  async refreshPlayback(payload) {
    var roomId = _s17_roomIdFromInput((payload && payload.roomId) || "");
    if (!roomId) _s17_throw("INVALID_ARGS", "roomId is required", { field: "roomId" });

    var quality = (payload && payload.quality) || {};
    var context = quality.requestContext || {};
    var wantedTier = _s17_text(context.tier);
    var wantedKind = _s17_text(quality.liveCodeType);

    var stream = await _s17_streamInfo(roomId);
    var qualities = _s17_playbackQualities(roomId, stream);
    if (!qualities.length) {
      _s17_throw("NOT_FOUND", "17LIVE 未返回可播地址：" + roomId, { roomId: roomId });
    }

    for (var i = 0; i < qualities.length; i++) {
      var tier = _s17_text(qualities[i].requestContext && qualities[i].requestContext.tier);
      if ((wantedTier && tier === wantedTier) || (!wantedTier && wantedKind && qualities[i].liveCodeType === wantedKind)) {
        return qualities[i];
      }
    }
    return qualities[0];
  },

  async resolveShare(payload) {
    var shareCode = _s17_text((payload && payload.shareCode) || "");
    if (!shareCode) _s17_throw("INVALID_ARGS", "shareCode is required", { field: "shareCode" });

    var roomId = _s17_roomIdFromInput(shareCode);
    if (!roomId) {
      _s17_throw("NOT_FOUND", "无法从分享内容里解析出 17LIVE 房间号", { shareCode: shareCode });
    }
    return await this.getRoomDetail({ roomId: roomId });
  },

  async search(payload) {
    var keyword = _s17_text((payload && (payload.keyword || payload.query)) || "").trim();
    if (!keyword) return [];

    var payloadData = await _s17_getJSON(
      __lp_s17_apiHost + "/api/v1/liveStreams/search?query=" + encodeURIComponent(keyword)
    );
    var list = payloadData && (payloadData.data || payloadData);
    if (!list || !list.length) return [];

    var rooms = [];
    var seen = {};
    // 先出在播的，下播的排后面 —— 搜索结果里混着双方都很常见。
    var live = [];
    var offline = [];
    for (var i = 0; i < list.length; i++) {
      var room = _s17_roomFromStream(list[i]);
      if (!room || seen[room.roomId]) continue;
      seen[room.roomId] = true;
      if (room.liveState === "1") live.push(room);
      else offline.push(room);
    }
    rooms = live.concat(offline);
    return rooms;
  },

  async getDanmaku(payload) {
    var roomId = _s17_roomIdFromInput((payload && payload.roomId) || "");
    if (!roomId) _s17_throw("INVALID_ARGS", "roomId is required", { field: "roomId" });

    var driver = globalThis.__lp_s17_danmaku;
    if (!driver) _s17_throw("UNSUPPORTED", "17LIVE 弹幕驱动未加载", {});

    return {
      args: { roomId: roomId, room_id: roomId, channel: roomId },
      headers: {},
      transport: {
        kind: "websocket",
        url: driver.wsURL,
        frameType: "text"
      },
      runtime: {
        driver: "plugin_js_v1",
        protocolId: "ably_17live",
        protocolVersion: "1",
        // Ably 是第三方（ably.io），不需要也不该带上 17.live 的 cookie。
        webSocketHeaderMode: "minimal_no_cookie"
      }
    };
  },

  async createDanmakuSession(payload) {
    return await globalThis.__lp_s17_danmaku.createDanmakuSession(payload);
  },

  async onDanmakuOpen(payload) {
    return await globalThis.__lp_s17_danmaku.onDanmakuOpen(payload);
  },

  async onDanmakuFrame(payload) {
    return await globalThis.__lp_s17_danmaku.onDanmakuFrame(payload);
  },

  async onDanmakuTick(payload) {
    return await globalThis.__lp_s17_danmaku.onDanmakuTick(payload);
  },

  async destroyDanmakuSession(payload) {
    return await globalThis.__lp_s17_danmaku.destroyDanmakuSession(payload);
  }
};
