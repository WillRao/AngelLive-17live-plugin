# 17LIVE for AngelLive

[AngelLive](https://github.com/pcccccc/AngelLive) 的 **17LIVE（17直播）** 平台插件。

纯 JS，跑在宿主的 JavaScriptCore 里，不改一行原生代码。装上订阅源即可用。

## 安装

在 AngelLive 的「插件管理 → 添加订阅源」里填：

```
https://willrao.github.io/AngelLive-17live-plugin/index.json
```

GitHub Pages 在国内时通时不通。如果拉不到，换 jsDelivr 镜像（内容一致）：

```
https://cdn.jsdelivr.net/gh/WillRao/AngelLive-17live-plugin@main/docs/index.json
```

> 插件包的下载地址在索引里是多线路的（Pages → jsDelivr → fastly），逐条校验 sha256，
> 所以只要索引本身能拿到，包基本都能下来。

## 能力

| 能力 | 状态 | 说明 |
|---|---|---|
| 分类 | ✅ | `regionList` 的地区：全球 / 日本 / 中国台湾 / 中国香港，按在播量排序 |
| 房间列表 | ✅ | 首页 feed 扁平化，只取在播房间，游标分页 |
| 房间详情 | ✅ | 主播名、标题、封面、头像、人气 |
| 开播状态 | ✅ | |
| 取流 | ✅ | 两条 CDN 线路，四档 HLS + FLV 兜底 |
| 搜索 | ✅ | 按主播名 / 标题 |
| 分享链接解析 | ✅ | `https://17.live/live/<房间号>` |
| 弹幕 | ✅ | Ably 实时通道，含聊天与进场提示 |

房间号就是 17LIVE 的 `liveStreamID`（数字）。也可以直接粘 `https://17.live/live/12345678` 这种链接。

## 取流线路

上游对每个房间给两条独立 CDN，插件把两条都列出来：

- **wansu**（`wansu-global-pull-rtmp-latency.17app.co`，https）→ 原画 / 高清 / H.264 / 流畅 四档 HLS，外加一条 FLV。
  HLS 是把 `.flv` 换成 `.m3u8` 得到的，服务端返回标准 master playlist（再重定向到 `100ycdn`，URL 上带一次性 `wsSession` 鉴权）。
- **tencent**（`tencent-global-pull-rtmp.17app.co`，http）→ 只有 FLV，作为备用线路。

**为什么两条都给**：实测它们的可用性会各自独立地抖动 —— 探测过程中 wansu 曾被限流到整段时间全部超时，而同一时刻 tencent 照常能拉下 1.4 MB。只给一条的话，遇到单边故障看起来就是「这个平台全挂了」。播不动的时候换一条线路试试。

http 不影响播放：App 的 iOS / macOS / tvOS 三个 `Info.plist` 都开了 `NSAllowsArbitraryLoads`。

## 弹幕

走 Ably 的实时通道（`wss://17media-realtime.ably.io`），**不需要登录、不需要 token**：

1. 连上后发 `{"action":10,"channel":"<liveStreamID>"}`（Ably 的 ATTACH）
2. 服务端回 `action 11`（ATTACHED）
3. 之后 `action 15` 的音信里，`messages[].data` 是 **base64(gzip(JSON))**

宿主 `Host.*` 只提供 `http` / `crypto.md5` / `crypto.base64Decode` / `runtime.loadBuiltinScript`，**没有任何解压能力**，所以 `danmaku.js` 里内联了一份 raw DEFLATE 解码器（stored / 固定 Huffman / 动态 Huffman 三条路径 + 多 member 串联）。

消息类型与默认显示：

| type | 含义 | 默认 |
|---|---|---|
| 3 | 聊天 | 显示 |
| 27 | 订阅者进场 | 显示 |
| 18 | 普通进场 | 显示 |
| 79 | 打工奖励 | 关 |
| 119 | 主播实时字幕（日/繁/英） | 关 |
| 47 / 51 | 戳 / 红包 | 关 |
| 6 / 38 / 74 | 时长、人气等信令 | 忽略 |

开关都在 `danmaku.js` 顶部。

### 心跳

**刻意不回应**入站的 `action 0` 心跳。实测把入站心跳原样弹回去会与对端互刷：20 秒内入站心跳从 1 次放大到 8 次。Ably 的保活判据只是 `connectionStateTtl`（120s）内收到过任何东西，单边发送就够。

心跳按 **15s 墙钟截止时间**发出，收帧与 tick 两条回调路径都会补 —— 这样即使宿主每次都重装 timer 导致 tick 永不触发，连接也不会被对端判死。

## 开发

```bash
# 本机对 *.17app.co 有 SNI 拦截，dev 工具会自动降级到 curl + 本地代理
# 代理地址默认 http://127.0.0.1:7890，可用 LP_HTTP_PROXY 覆盖，或设 none 强制直连

node dev/verify-all.mjs              # HTTP 在线 + 弹幕离线回归
node dev/verify-all.mjs --full       # 再加上连真实 Ably 收弹幕的端到端
node dev/capture-fixture.mjs         # 重抓一份弹幕夹具（dev/fixtures/）
python3 dev/make-icons.py            # 重新生成 assets/ 下的平台图标
node dev/pack.mjs                    # 打包 + 生成订阅源索引到 docs/
```

三层验证各自守什么：

| 脚本 | 守什么 |
|---|---|
| `dev/verify.mjs` | 每个导出函数的线上行为：房间号语义、在播过滤、https 升级、HLS 换扩展名、分页去重、搜索排序、错误码归一化 |
| `dev/verify-parser.mjs` | **完全离线**。手写 inflate 与 Node 的 zlib 逐字节对拍（含 stored / 固定 / 动态 Huffman、长短回溯、码长重复码、多 member），再用真实抓包夹具回放整条驱动链 |
| `dev/verify-danmaku.mjs` | 连真实 Ably 跑完整 `getDanmaku → createSession → open → frame → tick`，断言 ATTACH 帧、进房、收到弹幕、心跳不回弹 |

`verify-parser.mjs` 是最要紧的一层：手写 inflate 与 JSON 取值路径的 bug **都是静默的** —— 不抛错，只是弹幕一条都不显示。所以它的 oracle 用 Node 的 zlib 加一段刻意不复用插件代码的字段读取逻辑，两边唯一的共识只有「协议长什么样」。

## 平台图标

AngelLive **不读 manifest 里的图标字段**，而是按固定文件名去「已安装插件目录」里找 PNG
（iOS `PlatformIconProvider`、macOS `MacPlatformIconProvider`、tvOS `TVPlatformIconProvider`）。
也就是说图标只能靠**打进 zip 的 `assets/`** 来交付 —— 包不带图，就是没图标。

| 文件 | 尺寸 | 用在哪 |
| --- | --- | --- |
| `assets/live_card_17live.png` | 128×128 | iOS 平台 tab、tvOS 账号列表；索引里四个 `icon` 字段也都指向它 |
| `assets/mini_live_card_17live.png` | 128×128 | macOS 侧边栏（读入后强制 16pt 逻辑尺寸） |
| `assets/pad_live_card_17live.png` | 128×128 | iOS / macOS 插件管理列表 |
| `assets/tv_17live_big[_dark].png` | 740×444 | tvOS 平台页大图卡片（获得焦点时会被模糊） |
| `assets/tv_17live_small[_dark].png` | 740×444 | tvOS 平台页焦点叠标（上面还要压一行描述文字） |

`_dark` 缺失时宿主会自动回退到亮色版，但两套都给能少一层猜测。

图标由 `dev/make-icons.py` 从 `dev/icon-source.png`（17LIVE 官方 App 图标，1024×1024）生成，
产物已提交进仓库，所以 CI 与打包都不需要装 Pillow：

```bash
python3 dev/make-icons.py     # 换了源图或配色后重新生成 assets/
```

`dev/pack.mjs` 在打包前会逐张校验存在性、PNG 魔数与尺寸。图标缺失在 App 里只表现为
「图标没了」，不留这道闸门很难定位回来。

> 图标取自 17LIVE 的官方 App 图标，仅用于在 AngelLive 里标识对应平台；相关商标归 17LIVE INC. 所有。

## 打包

`docs/` 是发布目录（GitHub Pages 选「main 分支 / docs 目录」）。包必须可复现：

```bash
TZ=UTC zip -X -q -D out.zip <files...>   # dev/pack.mjs 已经这么调了
```

`zip` 把 mtime 写进 DOS 时间字段时用的是本地时间，不锁 `TZ=UTC` 的话 UTC+8 的 Mac 和 UTC 的 CI 会产出差 6 个字节、sha256 不同的包，CI 每次都会多一次空提交。索引里也刻意不写 `generatedAt`，同理。

## 已知限制

- 17LIVE 没有公开的分类（游戏/聊天/音乐）列表接口，所以分类维度是**地区**。
- 首页 feed 是游标分页且无状态，取第 N 页要顺序走完前面 N-1 页（已在插件内做，单页最多 ~150 个房间，够用）。
- 搜索走 `/api/v1/liveStreams/search`，实际匹配主播名与标题，对中文标题的召回一般。
- 主播个人页链接（`/profile/r/<UUID>`）无法反查房间号：上游没有免鉴权的 userID → liveStreamID 映射接口。请改用直播间分享链接。

## 许可

MIT
