/**
 * WebSocket 桥 —— 与 Chrome 扩展通信
 *
 * 协议（请求/应答）：
 *   → { id, action, payload }          server 发给扩展
 *   ← { id, ok: true,  result }        扩展回传
 *   ← { id, ok: false, error }         扩展回传错误
 */
import { WebSocketServer, WebSocket } from "ws";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "node:crypto";

export const DEFAULT_WS_PORT = 9223;

/** 不需要 opId 的动作（只读/查状态本身不该产生新状态） */
const NO_OP_ACTIONS = new Set([
  "status", "tabs_list", "tab_get", "tab_select", "op_status", "ops_list",
  "media_list", "media_clear", "media_config", "guard_config", "guard_stats",
]);

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

export class Bridge {
  private wss: WebSocketServer | null = null;
  private http: ReturnType<typeof createServer> | null = null;
  private client: WebSocket | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;

  /** ⭐ 本地工具：不经过扩展、直接在 Node 端执行（如 media_grab 下载） */
  private locals = new Map<string, (payload: any) => Promise<any>>();

  readonly port: number;

  constructor(port: number = DEFAULT_WS_PORT) {
    this.port = port;
  }

  /** 注册一个本地工具，使 /call 也能调用它（与 MCP 工具同源，便于脚本化测试） */
  registerLocal(name: string, fn: (payload: any) => Promise<any>) {
    this.locals.set(name, fn);
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // ── ⭐ 先把 WebSocket 挂到一个 HTTP server 上 ──
      // 好处：可以额外提供 /status 只读端点，让我查状态时
      // 不会「挤掉」扩展的 WebSocket 连接。
      const http = createServer((req: IncomingMessage, res: ServerResponse) => {
        const send = (code: number, obj: any) => {
          res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(obj));
        };

        if (req.url === "/status") {
          send(200, {
            connected: this.isConnected(),
            port: this.port,
            clients: this.client ? 1 : 0,
          });
          return;
        }

        // ⭐ POST /call —— HTTP 代理调用（复用已有扩展连接，不新建）
        // 用途：不通过 MCP 也能下发指令做调试；且不会挤掉扩展。
        if (req.method === "POST" && req.url === "/call") {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", async () => {
            try {
              const { action, payload, timeoutMs } = JSON.parse(body || "{}");
              if (!action) return send(400, { ok: false, error: "missing action" });

              // ⭐ 本地工具优先（media_grab 等在 Node 端执行，不需要扩展）
              const local = this.locals.get(action);
              if (local) {
                const result = await local(payload ?? {});
                return send(200, { ok: true, result });
              }

              const result = await this.send(action, payload ?? {}, Number(timeoutMs) || 60000);
              send(200, { ok: true, result });
            } catch (e: any) {
              const code = e?.code || "E_CALL";
              // 429 = 限速，语义比 500 准确，调用方可据此走退避而非重试
              const status = code === "E_TIMEOUT" ? 504 : code === "E_RATE" ? 429 : 500;
              send(status, {
                ok: false,
                error: e?.message ?? String(e),
                code,
                opId: e?.opId ?? null,
                hint: e?.hint ?? null,
                ...(e?.retryAfterMs != null
                  ? {
                      retryAfterMs: e.retryAfterMs,
                      retryAfterSec: e.retryAfterSec ?? Math.ceil(e.retryAfterMs / 1000),
                    }
                  : {}),
                ...(e?.current != null ? { current: e.current, limit: e.limit } : {}),
              });
            }
          });
          return;
        }

        send(404, { error: "not found" });
      });

      const wss = new WebSocketServer({ server: http });

      http.on("error", (err: any) => {
        if (err && err.code === "EADDRINUSE") {
          reject(new Error(`端口 ${this.port} 已被占用，请先关闭占用进程`));
        } else {
          reject(err);
        }
      });

      http.listen(this.port, "127.0.0.1", () => {
        this.http = http;
        this.wss = wss;
        resolve();
      });

      wss.on("connection", (ws) => {
        // 同一时刻只保留一个「扩展」连接（避免指令发错对象）。
        // ⭐ 只有声称 role=extension 的连接才会成为主连接并被占用；
        //    其他连接（调试/探测）走 HTTP /call 或只读，不抢主连接。
        const isExtension = !!(ws as any).__isExtension;

        ws.on("message", (raw) => {
          let msg: any;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            return;
          }

          // 握手：扩展声明身份
          if (msg.type === "hello") {
            if (msg.role === "extension") {
              (ws as any).__isExtension = true;
              // 替换旧的扩展连接
              if (this.client && this.client !== ws && this.client.readyState === WebSocket.OPEN) {
                try { this.client.close(); } catch {}
              }
              this.client = ws;
            }
            return;
          }

          // ⭐ 心跳应答：扩展发 ping，server 回 pong
          // 双方收发消息都会重置 Chrome 的 service worker 空闲计时器
          if (msg.type === "ping") {
            try { ws.send(JSON.stringify({ type: "pong", t: msg.t })); } catch {}
            return;
          }

          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.result);
          else {
            // ⭐ 保留扩展回报的结构化错误上下文（code / retryAfterMs / hint …），
            //    否则调用方只能从中文消息里 regex 抠，无法做精确重试决策。
            const e: any = new Error(msg.error || "unknown extension error");
            e.code = msg.code || "E_ACTION";
            for (const k of [
              "retryAfterMs", "retryAfterSec", "rateWindowSec",
              "current", "limit", "host", "matchedPattern", "hint",
            ]) {
              if (msg[k] !== undefined) e[k] = msg[k];
            }
            p.reject(e);
          }
        });

        ws.on("close", () => {
          if (this.client === ws) this.client = null;
        });

        ws.on("error", () => {});
      });
    });
  }

  isConnected(): boolean {
    return !!(this.client && this.client.readyState === WebSocket.OPEN);
  }

  /** 发送指令给扩展并等待结果 */
  send(action: string, payload: Record<string, any> = {}, timeoutMs = 60000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        const e: any = new Error(
          "扩展未连接。请：① 启动本 server ② 在 Chrome 里加载扩展 ③ 打开目标网页 ④ 点扩展图标 → 连接"
        );
        e.code = "E_NO_EXTENSION";
        reject(e);
        return;
      }
      const id = ++this.seq;

      // ⭐⭐⭐ 幂等（v1.5）：server 侧生成 opId 随请求下发。
      // 超时**不等于失败** —— 扩展端 dispatch 可能还在跑，跑完的结果会被记在扩展的 ops 表里。
      // 所以超时错误必须带上 opId，让调用方「查」而不是「猜」或「重试」。
      const opId = NO_OP_ACTIONS.has(action) ? undefined : randomUUID();

      const timer = setTimeout(() => {
        this.pending.delete(id);
        const e: any = new Error(
          opId
            ? `扩展响应超时（${action}, ${timeoutMs}ms）—— 操作可能已执行。` +
              `⛔ 不要直接重试；用 op_status 查 opId=${opId}（返回 done/error/pending/stale）。`
            : `扩展响应超时（${action}, ${timeoutMs}ms）`
        );
        e.code = "E_TIMEOUT";
        e.opId = opId;
        e.hint = opId ? `op_status ${opId}` : undefined;
        reject(e);
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.client!.send(JSON.stringify({ id, action, payload, opId }));
    });
  }

  async close() {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("server closing"));
    }
    this.pending.clear();
    try { this.client?.close(); } catch {}
    await new Promise<void>((r) => {
      if (this.wss) this.wss.close();
      if (!this.http) return r();
      this.http.close(() => r());
    });
  }
}
