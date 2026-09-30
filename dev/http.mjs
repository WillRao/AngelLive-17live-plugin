// dev 工具共用的 HTTP 适配层。
//
// 为什么需要这层：本机（以及国内大多数网络）对 *.17app.co 做 SNI 拦截 ——
// TCP 能连上、TLS 握不上，直连 fetch 只会拿到 Google 前端吐的 502 HTML。
// curl 走本地代理就正常。所以这里先试直连，失败就自动降级到
// `curl -x <proxy>`，并记住哪条路通，后续请求直接复用。
//
// Proxy 来源：环境变量 LP_HTTP_PROXY，默认 http://127.0.0.1:7890（Clash 系）。
// 想强制直连就设 LP_HTTP_PROXY=none。
//
// ⚠️ 这层只服务 dev 工具。真机上插件的 Host.http.request 是 App 自己的
// URLSession，走系统网络栈，跟这里无关。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);

const envProxy = process.env.LP_HTTP_PROXY;
export const PROXY = envProxy === "none" ? "" : envProxy || "http://127.0.0.1:7890";

/// 记住上次哪条路通：null = 未知，true = 走代理，false = 直连。
let useProxy = null;

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function looksLikeBlockPage(text) {
  const head = String(text || "").slice(0, 200).toLowerCase();
  return head.includes("<html") && !head.includes("{");
}

async function once(url, options, proxy) {
  const headers = Object.assign(
    { "User-Agent": DEFAULT_UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8", Referer: "https://17.live/", Origin: "https://17.live" },
    options.headers || {}
  );
  const method = String(options.method || "GET").toUpperCase();

  if (proxy) {
    const args = ["-sS", "--compressed", "--max-time", String(options.timeout || 25), "-x", proxy, "-X", method];
    for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
    if (options.body !== undefined && options.body !== null) args.push("--data-binary", String(options.body));
    // 状态码单独写进 stdout，正文进临时文件，避免二进制/压缩内容把解析搞乱
    args.push("-o", "-", "-w", "\n__STATUS__%{http_code}");
    args.push(url);
    const { stdout } = await run("curl", args, { maxBuffer: 64 * 1024 * 1024 });
    const marker = stdout.lastIndexOf("\n__STATUS__");
    if (marker < 0) throw new Error("curl 输出缺少状态码标记");
    const bodyText = stdout.slice(0, marker);
    const status = Number(stdout.slice(marker + "\n__STATUS__".length).trim());
    return { status, bodyText, headers: {} };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (options.timeout || 25) * 1000);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: options.body !== undefined ? options.body : undefined,
      signal: controller.signal,
      redirect: "follow"
    });
    const responseHeaders = {};
    response.headers.forEach((v, k) => { responseHeaders[k] = v; });
    return { status: response.status, bodyText: await response.text(), headers: responseHeaders };
  } finally {
    clearTimeout(timer);
  }
}

/// 返回 { status, bodyText, headers }。
export async function httpRequest(url, options = {}) {
  const attempts = useProxy === null ? [false, true] : [useProxy];

  let lastError = null;
  for (const proxy of attempts) {
    if (proxy && !PROXY) continue;
    try {
      const result = await once(url, options, proxy ? PROXY : "");
      // 直连拿到 5xx/HTML 拦截页 → 换代理再试一次
      if (!proxy && useProxy === null && result.status >= 500 && looksLikeBlockPage(result.bodyText)) {
        lastError = new Error(`直连被拦截（HTTP ${result.status}）`);
        continue;
      }
      useProxy = proxy;
      return result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("HTTP 请求失败");
}

export async function getJSON(url, options = {}) {
  const response = await httpRequest(url, options);
  if (response.status >= 400) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return JSON.parse(response.bodyText);
}

/// 仅供本机调试用：说明当前走的是哪条路。
export function describeRoute() {
  if (useProxy === null) return "未确定";
  return useProxy ? `代理 ${PROXY}` : "直连";
}

/// 只取响应前缀就断开 —— 专门用来探直播流。
///
/// 直播流永不结束，`fetch` + `arrayBuffer()` 会挂死进程（沙箱会 SIGKILL 成 exit 137），
/// 所以这里用 curl + `--max-filesize` / `--max-time` 强制截断，
/// 再把「被截断」当成正常结果：能读到字节就说明线路是通的。
///
/// 响应头单独写进临时文件，stdout 保持纯正文，方便直接看 m3u8 内容。
export async function fetchPrefix(url, options = {}) {
  const seconds = options.seconds || 6;
  const maxBytes = options.maxBytes || 8192;
  const dir = mkdtempSync(join(tmpdir(), "lp-head-"));
  const headerFile = join(dir, "headers.txt");

  const args = [
    "-sS",
    "--compressed",
    "-x", PROXY,
    "--max-time", String(seconds),
    "--max-filesize", String(maxBytes),
    "-H", `User-Agent: ${DEFAULT_UA}`,
    "-H", "Referer: https://17.live/",
    "-D", headerFile,
    url
  ];

  let text = "";
  let truncated = false;
  try {
    const result = await run("curl", args, { maxBuffer: 4 * 1024 * 1024 });
    text = result.stdout;
  } catch (error) {
    // exit 28（超时）/ 63（超过 --max-filesize）都是预期路径：数据已经写进 stdout
    truncated = true;
    text = String(error.stdout || "");
  }

  let headerText = "";
  try {
    headerText = readFileSync(headerFile, "utf8");
  } catch (error) {
    headerText = "";
  }
  rmSync(dir, { recursive: true, force: true });

  // ⚠️ 必须滤掉代理的隧道应答行。
  // 走 HTTP 代理时 curl 会先把 `HTTP/1.1 200 Connection established` 写进
  // header dump，如果上游随后根本没响应（超时），只看最后一行会把失败读成 200。
  const statusLines = [...headerText.matchAll(/^HTTP\/[\d.]+\s+(\d{3})(.*)$/gm)]
    .filter((m) => !/connection established/i.test(m[2] || ""));
  const status = statusLines.length ? Number(statusLines[statusLines.length - 1][1]) : 0;
  const typeMatch = headerText.match(/^content-type:\s*(.+)$/im);

  return {
    status,
    contentType: typeMatch ? typeMatch[1].trim() : "",
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    truncated
  };
}
