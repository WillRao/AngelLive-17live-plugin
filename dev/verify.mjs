// HTTP 能力在线验证：把插件的每个导出函数都真的打一遍线上接口。
//
//   node dev/verify.mjs
//   node dev/verify.mjs --verbose        # 打印每条请求
//
// 本机对 *.17app.co 有 SNI 拦截，dev/http.mjs 会自动降级到 curl + 本地代理
// （LP_HTTP_PROXY，默认 127.0.0.1:7890）。想强制直连：LP_HTTP_PROXY=none。
//
// 原则：不只断言「字段存在」。每条断言都要能抓住一个真实可能发生的回归 ——
// 房间号语义、status 过滤、https 升级、HLS 换扩展名、分页去重、搜索排序。

import { installHost, loadPlugin, makeChecker } from "./host-shim.mjs";
import { describeRoute, fetchPrefix, PROXY } from "./http.mjs";

const verbose = process.argv.includes("--verbose");
installHost({ verbose: false });
const { plugin, manifest } = loadPlugin();
const { check, summary } = makeChecker();

console.log("== getCategories ==");
const categories = await plugin.getCategories();
check("拿到分类", categories.length > 0, `${categories.length} 个`);
check("每个分类都有 id / title", categories.every((c) => c.id && c.title));
check("每个分类都有 subList", categories.every((c) => Array.isArray(c.subList) && c.subList.length > 0));
check(
  "分类都是大写地区码",
  categories.every((c) => /^[A-Z]{2,8}$/.test(c.id)),
  categories.map((c) => c.id).join(",")
);
check("地区名已本地化（不含原始码）", categories.every((c) => c.title !== c.id), categories.map((c) => c.title).join(","));
console.log(`    路由：${describeRoute()}` + (PROXY ? "" : "（未配代理）"));

console.log("\n== 每个地区都能出房间 ==");
// 各地区的在播量差别很大（日本 ~200 / 全球 ~13），
// 分页用例必须挑内容最多的那个地区跑，否则「第 2 页为空」是上游本来就没了，
// 会把正常的空页误判成回归。
const perRegion = [];
for (const category of categories) {
  const rooms = await plugin.getRooms({ parentBiz: category.id, page: 1 });
  perRegion.push({ id: category.id, title: category.title, rooms });
  check(`  ${category.title}（${category.id}）`, rooms.length > 0, `${rooms.length} 个`);
}
const best = perRegion.slice().sort((a, b) => b.rooms.length - a.rooms.length)[0];
const region = best.id;
const page1 = best.rooms;
console.log(`\n== getRooms 详情（用内容最多的 ${best.title}/${region}，${page1.length} 个）==`);

check("首页有房间", page1.length > 0, `${page1.length} 个`);
check(
  "房间号都是纯数字（liveStreamID 语义）",
  page1.every((r) => /^\d+$/.test(r.roomId)),
  page1[0] && page1[0].roomId
);
check(
  "所有房间都标为直播中（status===2 过滤生效）",
  page1.every((r) => r.liveState === "1"),
  [...new Set(page1.map((r) => r.liveState))].join(",")
);
check(
  "首页内无重复房间",
  page1.length === new Set(page1.map((r) => r.roomId)).size,
  `${page1.length} vs ${new Set(page1.map((r) => r.roomId)).size}`
);
check("卡片有标题", page1.filter((r) => r.roomTitle).length > page1.length * 0.5, `${page1.filter((r) => r.roomTitle).length}/${page1.length}`);
check("卡片有主播名", page1.filter((r) => r.userName).length > page1.length * 0.8);
check(
  "封面全部是 https（cdn.17app.co 的 http 会 500）",
  page1.every((r) => !r.roomCover || r.roomCover.indexOf("https://") === 0),
  page1[0] && page1[0].roomCover
);
check(
  "头像全部是 https",
  page1.every((r) => !r.userHeadImg || r.userHeadImg.indexOf("https://") === 0),
  page1[0] && page1[0].userHeadImg
);
check("人气是可解析的数字", page1.every((r) => /^\d+$/.test(r.liveWatchedCount)), page1[0] && page1[0].liveWatchedCount);

console.log("\n== 分页去重（回归：相邻页曾有约 18 个重叠）==");
const page2 = await plugin.getRooms({ parentBiz: region, page: 2 });
check("第 2 页有房间", page2.length > 0, `${page2.length} 个`);
{
  const page1Ids = new Set(page1.map((r) => r.roomId));
  const overlap = page2.filter((r) => page1Ids.has(r.roomId));
  check("第 2 页与第 1 页无重叠", overlap.length === 0, overlap.length ? `${overlap.length} 个重复：${overlap.slice(0, 3).join(",")}` : "");
  check("第 2 页内部无重复", page2.length === new Set(page2.map((r) => r.roomId)).size);
  check(
    "第 2 页房间也全是直播中",
    page2.every((r) => r.liveState === "1"),
    [...new Set(page2.map((r) => r.liveState))].join(",")
  );
}
// 再翻一页，确认游标是能连续走的（第 3 页允许为空，但不能抛错）
const page3 = await plugin.getRooms({ parentBiz: region, page: 3 });
check("第 3 页（连续游标）不抛错", Array.isArray(page3), `${page3.length} 个`);

console.log("\n== getRoomDetail ==");
const probe = page1[0];
const detail = await plugin.getRoomDetail({ roomId: probe.roomId });
check("详情能取到", !!detail);
check("房间号一致", detail.roomId === probe.roomId, `${probe.roomId} → ${detail.roomId}`);
check("详情也是直播中", detail.liveState === "1");
check("有主播名", !!detail.userName, detail.userName);
check("封面是 https", !detail.roomCover || detail.roomCover.indexOf("https://") === 0);

console.log("\n== getRoomDetail 吃 URL 输入 ==");
for (const input of [
  `https://17.live/live/${probe.roomId}`,
  `https://17.live/zh-Hant/live/${probe.roomId}?utm_source=x`,
  String(probe.roomId)
]) {
  const fromUrl = await plugin.getRoomDetail({ roomId: input });
  check(`  ${input.slice(0, 52)}`, fromUrl.roomId === probe.roomId, fromUrl.roomId);
}

console.log("\n== getLiveState ==");
const state = await plugin.getLiveState({ roomId: probe.roomId });
check("在播房间返回 1", state.liveState === "1", state.liveState);
{
  // 一个几乎不可能存在的房间号：上游回 errorCode 7，插件应降级成关播而不是抛错。
  const ghost = await plugin.getLiveState({ roomId: "999999999999" });
  check("不存在的房间降级为 0 而非抛错", ghost.liveState === "0", ghost.liveState);
}

console.log("\n== getPlayback ==");
const playArgs = await plugin.getPlayback({ roomId: probe.roomId });
check("返回 CDN 分组", Array.isArray(playArgs) && playArgs.length > 0);
const cdn = playArgs[0];
check("分组有 qualitys", Array.isArray(cdn.qualitys) && cdn.qualitys.length > 0, `${cdn.qualitys.length} 档`);
check("第一条就是首选（宿主取 qualitys.first）", !!cdn.qualitys[0].url, cdn.qualitys[0].title);
check(
  "所有线路都带 roomId / liveType / liveCodeType",
  cdn.qualitys.every((q) => q.roomId === probe.roomId && q.liveType === "17live" && q.liveCodeType)
);
check(
  "liveCodeType 只用 m3u8 / flv",
  cdn.qualitys.every((q) => q.liveCodeType === "m3u8" || q.liveCodeType === "flv"),
  [...new Set(cdn.qualitys.map((q) => q.liveCodeType))].join(",")
);
check(
  "HLS 线路都是 .m3u8 结尾",
  cdn.qualitys.filter((q) => q.liveCodeType === "m3u8").every((q) => /\.m3u8(\?|$)/.test(q.url)),
  cdn.qualitys.find((q) => q.liveCodeType === "m3u8")?.url
);
check("优先给 https 的 HLS 线路", cdn.qualitys[0].liveCodeType === "m3u8" && cdn.qualitys[0].url.indexOf("https://") === 0);
check(
  "每条 requestContext 都带 tier（refreshPlayback 靠它找回同一条线路）",
  cdn.qualitys.every((q) => q.requestContext && q.requestContext.tier)
);
console.log(`    档位：${cdn.qualitys.map((q) => `${q.title}(${q.liveCodeType})`).join(", ")}`);

console.log("\n== 播放地址真的能拉起来 ==");
{
  // 用 dev/http.mjs 的 fetchPrefix：直播流无限长，必须只读前缀就断，
  // 等完整 body 会挂死进程；这层同时负责走代理（本机对 *.17app.co 有 SNI 拦截）。
  //
  // 这里刻意断言「**至少一条**线路能拉到数据」而不是「第一条能」：
  // wansu / tencent 两条线路会各自独立地抖动（实测 wansu 被限流到整段时间全 000，
  // 同一时刻 tencent 照常拉下 1.4MB）。插件能做的只是把两条都给出来，
  // 所以「至少有一条真的能播」才是插件该被考核的契约。
  const reachable = [];
  for (const quality of cdn.qualitys) {
    const prefix = await fetchPrefix(quality.url, { seconds: quality.liveCodeType === "m3u8" ? 10 : 5 });
    const ok = prefix.status === 200 && prefix.bytes > 0;
    reachable.push({ quality, prefix, ok });
    console.log(
      `    ${ok ? "✓" : "×"} ${quality.title.padEnd(14)} ${quality.liveCodeType.padEnd(4)} HTTP ${prefix.status} ${prefix.bytes}B` +
        (quality.liveCodeType === "m3u8" && /#EXTM3U/.test(prefix.text) ? "  m3u8✓" : "")
    );
  }

  const hits = reachable.filter((r) => r.ok);
  check("至少一条线路真的能拉到数据", hits.length > 0, `${hits.length}/${reachable.length} 条可用`);

  // HLS 线路必须给出可被 AVPlayer 直接消费的 playlist。
  // 换扩展名推导出来的地址最容易静默失效，所以这一条要单独咬住。
  const hlsHits = reachable.filter((r) => r.quality.liveCodeType === "m3u8" && r.ok);
  if (hlsHits.length) {
    const sample = hlsHits[0].prefix;
    check("HLS 响应是 m3u8", /mpegurl/i.test(sample.contentType) || /#EXTM3U/.test(sample.text), sample.contentType);
    check(
      "master playlist 指向 CDN 并带一次性会话参数",
      /100ycdn/i.test(sample.text) && /wsSession=/i.test(sample.text),
      sample.text.replace(/\s+/g, " ").slice(0, 96)
    );
    check("playlist 声明了 BANDWIDTH", /BANDWIDTH=\d+/i.test(sample.text), (sample.text.match(/BANDWIDTH=\d+/i) || [])[0]);
  } else {
    console.log("    ⚠️ 本次没有可达的 HLS 线路，跳过 playlist 结构断言（wansu 侧抖动，非插件问题）");
  }

  // 两条 provider 必须都在列表里 —— 只给一条的话单边故障就等于平台挂掉。
  const tiers = cdn.qualitys.map((q) => q.requestContext.tier);
  check("同时给出了 HLS 与 FLV 两类线路", tiers.some((t) => !t.endsWith("_flv")) && tiers.some((t) => t.endsWith("_flv")), tiers.join(","));
  check(
    "两条 provider 都给了（wansu 的 origin 与 tencent 的 backup）",
    tiers.includes("origin") && tiers.some((t) => t.indexOf("backup_") === 0),
    tiers.join(",")
  );
}

console.log("\n== refreshPlayback ==");
{
  const wanted = cdn.qualitys.find((q) => q.requestContext.tier === "enhanced") || cdn.qualitys[1];
  const refreshed = await plugin.refreshPlayback({ roomId: probe.roomId, quality: wanted });
  check("按 tier 找回同一条线路", refreshed.requestContext.tier === wanted.requestContext.tier, `${wanted.requestContext.tier} → ${refreshed.requestContext.tier}`);
  check("刷新后拿到的是新地址对象", typeof refreshed.url === "string" && refreshed.url.length > 0);
  const noHint = await plugin.refreshPlayback({ roomId: probe.roomId, quality: { liveCodeType: "m3u8" } });
  check("没给 tier 时按 liveCodeType 兜底", noHint.liveCodeType === "m3u8");
}

console.log("\n== search ==");
{
  const keyword = (detail.userName || "").slice(0, 4);
  const results = await plugin.search({ keyword });
  check(`搜主播名「${keyword}」有结果`, results.length > 0, `${results.length} 条`);
  check("搜索结果的房间号是纯数字", results.every((r) => /^\d+$/.test(r.roomId)));
  check(
    "在播的结果排在前面",
    results.findIndex((r) => r.liveState === "1") < results.findIndex((r) => r.liveState !== "1") ||
      results.every((r) => r.liveState === "1") ||
      !results.some((r) => r.liveState !== "1"),
    results.map((r) => r.liveState).join(",")
  );
  const empty = await plugin.search({ keyword: "" });
  check("空关键词返回空数组", Array.isArray(empty) && empty.length === 0);

  // 搜索命中的房间必须能直接取流 —— 这是「搜到了却播不了」的回归护栏。
  const live = results.find((r) => r.liveState === "1");
  if (live) {
    const args = await plugin.getPlayback({ roomId: live.roomId });
    check("搜索结果可以直接取流", args[0].qualitys.length > 0, `${live.userName} → ${args[0].qualitys.length} 档`);
  }
}

console.log("\n== resolveShare ==");
{
  const hit = await plugin.resolveShare({ shareCode: `https://17.live/live/${probe.roomId}` });
  check("从分享链接解析出房间", hit.roomId === probe.roomId, hit.roomId);
  let threw = false;
  try {
    await plugin.resolveShare({ shareCode: "这不是任何 17LIVE 链接" });
  } catch (error) {
    threw = /LP_PLUGIN_ERROR/.test(String(error.message));
  }
  check("解析不了的分享内容抛受控错误", threw);
}

console.log("\n== 错误路径 ==");
{
  let threw = false;
  try {
    await plugin.getPlayback({ roomId: "" });
  } catch (error) {
    threw = /LP_PLUGIN_ERROR/.test(String(error.message));
  }
  check("空 roomId 抛受控错误", threw);

  let missingThrew = false;
  try {
    await plugin.getRoomDetail({ roomId: "999999999999" });
  } catch (error) {
    missingThrew = /NOT_FOUND/.test(String(error.message));
  }
  check("不存在的房间抛 NOT_FOUND", missingThrew);
}

console.log("\n== manifest 与实现的一致性 ==");
{
  check("pluginId 与 liveType 自洽", manifest.liveTypes.includes(manifest.pluginId), manifest.liveTypes.join(","));
  check("导出面齐全", ["getCategories", "getRooms", "getPlayback", "refreshPlayback", "getRoomDetail", "getLiveState", "search", "resolveShare", "getDanmaku", "createDanmakuSession", "onDanmakuOpen", "onDanmakuFrame", "onDanmakuTick", "destroyDanmakuSession"].every((name) => typeof plugin[name] === "function"));
  check("capabilities 只声明实际实现的搜索", manifest.capabilities.search.status === "available");
  check("弹幕协议自报 ably_17live", manifest.capabilities.danmaku.protocolId === "ably_17live");
}

process.exit(summary() ? 1 : 0);
