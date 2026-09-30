// 宿主 Host.* 仿真层：让插件在 Node 里跑的语义与 JSRuntime.swift 的表层一致。
// 被 verify.mjs / verify-danmaku.mjs 共用。

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { httpRequest } from "./http.mjs";

export const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}
function base64ToBytes(base64) {
  return new Uint8Array(Buffer.from(String(base64), "base64"));
}

export function installHost({ verbose = false } = {}) {
  // JavaScriptCore 里有 btoa/atob（JSRuntime 的 bootstrap 会补齐），Node 22 也自带。
  globalThis.Host = {
    makeError(code, message, context) {
      return new Error(
        "LP_PLUGIN_ERROR:" + JSON.stringify({ code, message, context: context || {} })
      );
    },
    raise(code, message, context) {
      throw globalThis.Host.makeError(code, message, context);
    },
    crypto: {
      md5(input) {
        return createHash("md5").update(String(input), "utf8").digest("hex");
      }
    },
    http: {
      async request(options) {
        const url = options && options.url;
        if (!url) throw globalThis.Host.makeError("NETWORK", "missing url", {});
        try {
          // 走 ./http.mjs：直连不通时自动降级到 curl + 本地代理，
          // 因为本机对 *.17app.co 做 SNI 拦截（直连只会拿到 502 拦截页）。
          return await httpRequest(url, {
            method: options.method || "GET",
            headers: options.headers || {},
            body: options.body || undefined,
            timeout: options.timeout || 20
          });
        } catch (error) {
          throw globalThis.Host.makeError("NETWORK", String((error && error.message) || error), { url });
        }
      }
    },
    // Host.ws 的事件契约：{type:"open"} / {type:"binary",bytesBase64} / {type:"text",text}
    // / {type:"closed",code,reason} / {type:"error",message}
    ws: {
      async open(options) {
        const socket = new WebSocket(String(options.url));
        socket.binaryType = "arraybuffer";
        let handler = null;
        const pending = [];

        socket.addEventListener("message", (event) => {
          let payload;
          if (typeof event.data === "string") {
            payload = { type: "text", text: event.data };
          } else {
            payload = { type: "binary", bytesBase64: bytesToBase64(new Uint8Array(event.data)) };
          }
          emit(payload);
        });
        socket.addEventListener("close", (event) => {
          emit({ type: "closed", code: event.code || 0, reason: event.reason || "" });
        });
        socket.addEventListener("error", (event) => {
          emit({ type: "error", message: String((event && event.message) || "ws error") });
        });

        function emit(payload) {
          if (verbose) {
            const brief =
              payload.type === "binary"
                ? `binary(${base64ToBytes(payload.bytesBase64).length}B)`
                : JSON.stringify(payload).slice(0, 120);
            console.log(`    [ws←] ${brief}`);
          }
          if (handler) handler(payload);
          else pending.push(payload);
        }

        // 连接建立后再把 open 事件交给插件（与 Starscream 的 didReceive 行为一致）。
        socket.addEventListener("open", () => emit({ type: "open" }));

        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("ws open timeout")), 15000);
          socket.addEventListener("open", () => {
            clearTimeout(timer);
            resolve();
          });
          socket.addEventListener("error", () => {
            clearTimeout(timer);
            reject(new Error("ws open failed"));
          });
        });

        return {
          sessionId: "mock-" + Math.random().toString(36).slice(2),
          onMessage(callback) {
            handler = typeof callback === "function" ? callback : null;
            if (handler) {
              while (pending.length) handler(pending.shift());
            }
          },
          async send(frame) {
            // 驱动契约里写帧用 `kind`（LiveParseDanmakuWriteAction），
            // 宿主弹幕层再把它转成 __lp_host_ws_send 的 `type`。这里两种都收。
            const kind = String((frame && (frame.kind || frame.type)) || "text").toLowerCase();
            if (verbose) console.log(`    [ws→] ${kind} ${frame.bytesBase64 ? base64ToBytes(frame.bytesBase64).length + "B" : ""}`);
            if (kind === "binary") {
              if (!frame.bytesBase64) throw globalThis.Host.makeError("WS_SEND", "missing bytesBase64", {});
              socket.send(base64ToBytes(frame.bytesBase64));
            } else {
              socket.send(String(frame.text || ""));
            }
          },
          async close() {
            handler = null;
            pending.length = 0;
            try {
              socket.close();
            } catch (error) {
              /* already closed */
            }
          },
          // 测试专用：等底层 socket 真正收到 N 条消息
          _socket: socket
        };
      }
    }
  };
  return globalThis.Host;
}

export function loadPlugin({ verbose = false } = {}) {
  const manifest = JSON.parse(readFileSync(join(pluginRoot, "manifest.json"), "utf8"));
  for (const script of manifest.preloadScripts || []) {
    const source = readFileSync(join(pluginRoot, script), "utf8");
    try {
      (0, eval)(source);
    } catch (error) {
      console.log(`[warn] preload ${script} 执行失败：${error.message}`);
    }
  }
  (0, eval)(readFileSync(join(pluginRoot, manifest.entry), "utf8"));
  const plugin = globalThis.LiveParsePlugin;
  if (!plugin) throw new Error("插件没有导出 globalThis.LiveParsePlugin");
  return { manifest, plugin };
}

// 断言小工具
export function makeChecker() {
  const state = { passed: 0, failed: 0 };
  return {
    state,
    check(name, condition, detail) {
      if (condition) {
        state.passed += 1;
        console.log(`  ✅ ${name}${detail ? " — " + detail : ""}`);
      } else {
        state.failed += 1;
        console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`);
      }
    },
    summary() {
      console.log(`\n—— ${state.passed} 通过 / ${state.failed} 失败 ——`);
      return state.failed;
    }
  };
}

export { bytesToBase64, base64ToBytes, encoder, decoder };
