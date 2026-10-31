#!/usr/bin/env node
/**
 * Chrome MCP Bridge · MCP server
 *
 * MCP client ──stdio──► 本进程 ──WebSocket:9223──► Chrome 扩展 ──chrome.debugger──► 真实标签页
 *
 * 提供工具：navigate / snapshot / click / type / screenshot / eval / tabs ...
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import path from "node:path";
import { rename, mkdir } from "node:fs/promises";

import { Bridge, DEFAULT_WS_PORT } from "./bridge.js";
import { grabMedia } from "./media.js";

const PORT = Number(process.env.BRIDGE_PORT || process.env.XY_BRIDGE_PORT || DEFAULT_WS_PORT);

const bridge = new Bridge(PORT);

// ─────────────────────────── 工具定义 ───────────────────────────

type ToolDef = {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  handler: (args: any) => Promise<any>;
  /** 是否把结果作为图片返回 */
  image?: boolean;
};

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const json = (o: any) => text(JSON.stringify(o, null, 2));

/**
 * batch 的核心实现。
 * ⭐ 必须是"本地工具"（registerLocal）——它只在 Node 侧循环调用 bridge.send，
 *    扩展里没有 batch 这个 action。不注册的话 /call batch 会直接 unknown action。
 */
async function batchCore(a: any) {
  const steps = Array.isArray(a?.steps) ? a.steps : [];
  const stopOnError = a?.stopOnError !== false;
  const results: any[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const t0 = Date.now();
    try {
      const r = await bridge.send(s.action, s.payload ?? {}, a.timeoutMs ?? 60000);
      // 截图不内联 base64（会把上下文撑爆），只回报体积
      const brief =
        r && typeof r === "object" && typeof r.base64 === "string"
          ? { ...r, base64: `[${r.base64.length} chars]` }
          : r;
      results.push({ step: i, action: s.action, ok: true, ms: Date.now() - t0, result: brief });
      if (s.waitMs) await new Promise((res) => setTimeout(res, s.waitMs));
    } catch (e: any) {
      results.push({
        step: i,
        action: s.action,
        ok: false,
        ms: Date.now() - t0,
        error: e?.message ?? String(e),
        code: e?.code ?? null,
        ...(e?.retryAfterMs != null ? { retryAfterMs: e.retryAfterMs } : {}),
      });
      if (stopOnError) break;
    }
  }
  return { total: steps.length, done: results.length, failed: results.filter((r) => !r.ok).length, results };
}

/**
 * media_grab 的核心实现（普通对象返回，便于 MCP 与 /call 双通道复用）。
 * ⭐ 抽成函数而不是内联在 handler 里 —— 这样 /call 也能调到（脚本化测试需要）。
 */
async function mediaGrabCore(a: any) {
  const isHls = /\.m3u8(\?|#|$)/i.test(a.url);
  const baseDir = process.env.XY_MEDIA_DIR || path.resolve(process.cwd(), "_downloads");
  const stamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  const outPath = a.outPath || path.join(baseDir, `media_${stamp}${isHls ? ".part" : ".bin"}`);
  await mkdir(path.dirname(outPath), { recursive: true });

  const t0 = Date.now();
  let lastPct = -1;
  try {
    const res = await grabMedia(
      a.url,
      {
        outPath,
        concurrency: a.concurrency,
        maxSegments: a.maxSegments,
        timeoutMs: a.timeoutMs,
        onProgress: (done, total) => {
          if (!total) return;
          const pct = Math.floor((done / total) * 100);
          if (pct >= lastPct + 20) {
            lastPct = pct;
            console.error(`[media_grab] ${pct}% (${done}/${total})`);
          }
        },
      },
      a.referer
    );

    // 按真实容器改名：HLS 可能是 ts 也可能是 mp4(fMP4)
    let finalPath = outPath;
    if (isHls) {
      const ext = res.container === "mp4" ? ".mp4" : ".ts";
      finalPath = outPath.replace(/\.part$/, ext).replace(/\.bin$/, ext);
      if (finalPath !== outPath) await rename(outPath, finalPath).catch(() => {});
    } else {
      finalPath = outPath.replace(/\.bin$/, "");
      if (finalPath !== outPath) await rename(outPath, finalPath).catch(() => {});
    }

    return { ...res, outPath: finalPath, elapsedMs: Date.now() - t0 };
  } catch (e: any) {
    const msg = String(e?.message || e);
    const hint =
      /HTTP 403/.test(msg)
        ? "→ 多为防盗链：补 referer（可传页面 URL）后重试"
        : /HTTP 404/.test(msg)
        ? "→ 地址可能已过期（HLS 签名链接通常有时效），重新播放一次再嗅探"
        : /不支持的加密方式/.test(msg)
        ? "→ DRM 内容，本工具不做绕过"
        : null;
    return { ok: false, error: msg, hint, url: a.url, outPath, elapsedMs: Date.now() - t0 };
  }
}

const tools: ToolDef[] = [
  // ── 状态 ──
  {
    name: "bridge_status",
    description:
      "检查扩展是否已连接、当前接管的是哪个标签页。任何操作前建议先调用一次。",
    schema: z.object({}),
    handler: async () => {
      if (!bridge.isConnected()) {
        return text(
          "❌ 扩展未连接。\n请依次：① 确认 server 已启动 ② 在 Chrome 打开目标网页 " +
            "③ 点击扩展图标 → 连接到 MCP server。"
        );
      }
      const st = await bridge.send("status");
      return json(st);
    },
  },

  // ── 标签页 ──
  {
    name: "tabs_list",
    description: "列出 Chrome 当前所有标签页（id / 标题 / URL / 是否激活）。",
    schema: z.object({}),
    handler: async () => json(await bridge.send("tabs_list")),
  },
  {
    name: "tab_attach",
    description:
      "接管指定标签页。不传 tabId 则接管当前激活标签页。接管后所有操作默认作用于它。",
    schema: z.object({
      tabId: z.number().optional().describe("标签页 id，省略则用当前激活页"),
    }),
    handler: async (a) => json(await bridge.send("tab_attach", a)),
  },
  {
    name: "tab_select",
    description: "把某个标签页切到前台（激活）。",
    schema: z.object({ tabId: z.number().describe("标签页 id") }),
    handler: async (a) => json(await bridge.send("tab_select", a)),
  },
  {
    name: "tab_create",
    description:
      "新建标签页并（默认）切到前台。⭐ 不触发 beforeunload 弹窗，" +
      "因此在「离开此网站？」阻塞旧页时，可用「tab_create 新页 + tab_close 旧页」脱困。",
    schema: z.object({
      url: z.string().optional().describe("目标 URL，默认 about:blank"),
      active: z.boolean().optional().describe("是否切到前台，默认 true"),
      waitMs: z.number().optional().describe("创建后额外等待毫秒数"),
    }),
    handler: async (a) => json(await bridge.send("tab_create", a)),
  },
  {
    name: "tab_close",
    description:
      "关闭标签页。⭐ chrome.tabs.remove 不触发 beforeunload，" +
      "所以不会被「离开此网站？」卡住（会先 detach debugger）。",
    schema: z.object({ tabId: z.number().describe("要关闭的标签页 id") }),
    handler: async (a) => json(await bridge.send("tab_close", a)),
  },
  {
    name: "dialog_policy",
    description:
      "原生对话框（alert/confirm/beforeunload「离开此网站？」）自动应答开关。⭐ " +
      "原生对话框会阻塞渲染进程，导致后续所有 CDP 操作超时（表现为『桥卡死』）。" +
      "扩展默认开启自动应答；本 action 可关闭，或用 clearNow 主动清理当前卡住的弹窗。",
    schema: z.object({
      autoDismiss: z.boolean().optional().describe("是否自动应答，默认 true"),
      clearNow: z.boolean().optional().describe("立即尝试应答当前弹窗"),
    }),
    handler: async (a) => json(await bridge.send("dialog_policy", a)),
  },

  // ── ⭐ v1.5 幂等：超时后查真实结果 ──
  {
    name: "op_status",
    description:
      "查询某个动作的真实执行结果（v1.5 新增）。⭐⭐⭐ 用途单一但关键：" +
      "当一个 click/type/eval 返回「超时」时，**操作可能已经在页面里执行了** —— " +
      "此时不要重试（会重复点击/重复输入），用超时错误里给的 opId 调本工具查询。" +
      "返回 status: pending(还在跑) / done(已完成，result 有结果) / error(失败) / stale(超过10分钟无回包，多半 CDP 挂死，需重新 attach)。",
    schema: z.object({
      opId: z.string().describe("超时错误里返回的 opId"),
    }),
    handler: async (a) => json(await bridge.send("op_status", a)),
  },
  {
    name: "ops_list",
    description: "列出最近的动作及其终态（诊断用）。看有多少 pending、哪些动作慢、错误码分布。",
    schema: z.object({
      limit: z.number().optional().describe("返回条数，默认 30"),
    }),
    handler: async (a) => json(await bridge.send("ops_list", a)),
  },

  // ── ⭐ v1.5 网页媒体嗅探 ──
  {
    name: "media_list",
    description:
      "列出当前标签页已嗅探到的媒体资源（m3u8 / mp4 / mp3 等）（v1.5 新增）。" +
      "⭐ 嗅探是「看网络请求」，不回溯历史：打开本工具前先播放一次视频，" +
      "或刷新页面让它重新请求。返回按 HLS 优先、体积降序排列。",
    schema: z.object({
      tabId: z.number().optional().describe("标签页 id，省略用当前接管的页"),
      limit: z.number().optional().describe("返回条数，默认 100"),
    }),
    handler: async (a) => json(await bridge.send("media_list", a)),
  },
  {
    name: "media_clear",
    description: "清空媒体嗅探记录（某标签页或全部）。",
    schema: z.object({
      tabId: z.number().optional().describe("标签页 id，省略用当前接管的页"),
      all: z.boolean().optional().describe("true = 清空全部标签页的记录"),
    }),
    handler: async (a) => json(await bridge.send("media_clear", a)),
  },
  {
    name: "media_config",
    description: "开关媒体嗅探。默认开启；关掉后不再记录任何请求（省内存/更隐身）。",
    schema: z.object({
      enabled: z.boolean().optional().describe("是否开启嗅探"),
    }),
    handler: async (a) => json(await bridge.send("media_config", a)),
  },
  {
    name: "media_grab",
    description:
      "把网页媒体下载到本地（v1.5 新增）。支持 HLS(m3u8) 与直链(mp4/webm/mp3)。" +
      "⭐ HLS 会自动解析 master、并发下载分片、按序拼接；支持 AES-128 解密与 fMP4(EXT-X-MAP)。" +
      "⛔ 不支持 DRM（SAMPLE-AES / Widevine）—— 遇到会明确报错，不做绕过。" +
      "⚠️ 防盗链站点请传 referer（媒体请求的 Referer 头），否则常见 403。" +
      "输出：TS 流拼成 .ts（VLC 可播）；fMP4 拼成 .mp4。本机无 ffmpeg，故不做转码。",
    schema: z.object({
      url: z.string().describe("媒体地址（m3u8 或直链）"),
      outPath: z.string().optional().describe("输出绝对路径；省略则落到 <server>/_downloads/"),
      referer: z.string().optional().describe("防盗链场景必填"),
      concurrency: z.number().optional().describe("分片并发，默认 6（>8 易被 CDN 限速）"),
      maxSegments: z.number().optional().describe("只取前 N 段（试看/调试）"),
      timeoutMs: z.number().optional().describe("单个请求超时（毫秒），默认 60000；境外/慢站可调到 120000"),
    }),
    handler: async (a) => json(await mediaGrabCore(a)),
  },

  // ── 导航 ──
  {
    name: "navigate",
    description: "在当前接管的标签页打开指定 URL，并等待加载完成。",
    schema: z.object({
      url: z.string().describe("目标 URL"),
      timeoutMs: z.number().optional().describe("等待加载超时（毫秒），默认 30000"),
    }),
    handler: async (a) => {
      await bridge.send("navigate", a, (a.timeoutMs ?? 30000) + 10000);
      const info = await bridge.send("tab_get").catch(() => null);
      return text(`✅ 已打开 ${a.url}${info ? `\n当前页：${info.title || ""} — ${info.url}` : ""}`);
    },
  },
  {
    name: "go_back",
    description: "浏览器后退。",
    schema: z.object({}),
    handler: async () => json(await bridge.send("go_back")),
  },
  {
    name: "go_forward",
    description: "浏览器前进。",
    schema: z.object({}),
    handler: async () => json(await bridge.send("go_forward")),
  },
  {
    name: "reload",
    description: "刷新当前页。",
    schema: z.object({}),
    handler: async () => json(await bridge.send("reload")),
  },

  // ── 页面读取 ──
  {
    name: "snapshot",
    description:
      "获取当前页面所有可见交互元素的快照（按钮/输入框/链接等），带 ref 编号和坐标。" +
      "这是了解页面结构、决定点哪里的首选方式（比截图省 token，比 HTML 干净）。",
    schema: z.object({
      maxNodes: z.number().optional().describe("最多返回多少个元素，默认 400"),
    }),
    handler: async (a) => {
      const r = await bridge.send("dom_snapshot", a);
      if (!r.nodes || r.nodes.length === 0) return text("（页面没有找到可见交互元素）");
      const lines = r.nodes.map((n: any) => {
        const parts = [`[${n.ref}]`, `<${n.tag}${n.type ? " " + n.type : ""}>`];
        if (n.name) parts.push(`"${n.name}"`);
        if (n.placeholder) parts.push(`placeholder="${n.placeholder}"`);
        if (n.href) parts.push(`→ ${n.href.slice(0, 80)}`);
        parts.push(`@(${n.x},${n.y})`);
        return parts.join(" ");
      });
      return text(
        `页面共 ${r.nodes.length} 个可见交互元素：\n\n` + lines.join("\n")
      );
    },
  },
  {
    name: "get_page_text",
    description: "读取当前页面可见文本（innerText）。适合快速了解页面内容。",
    schema: z.object({
      maxChars: z.number().optional().describe("最大字符数，默认 20000"),
    }),
    handler: async (a) => {
      const r = await bridge.send("page_text", a);
      return text(r.text || "（页面无文本）");
    },
  },
  {
    name: "eval",
    description:
      "在页面上下文里执行 JavaScript 并返回结果（支持 await）。用于提取数据、检查状态。",
    schema: z.object({
      expression: z.string().describe("JS 表达式，如 document.title 或 (async()=>{...})()"),
    }),
    handler: async (a) => {
      const r = await bridge.send("eval", a);
      return typeof r.value === "string" ? text(r.value) : json(r.value);
    },
  },

  // ── 交互 ──
  {
    name: "click",
    description:
      "点击元素。三选一定位：selector（CSS）、text（可见文字）、ref（snapshot 返回的 @eN）。" +
      "使用真实鼠标事件，页面的 JS 会正常响应。",
    schema: z.object({
      selector: z.string().optional().describe("CSS 选择器"),
      text: z.string().optional().describe("元素文字（模糊匹配）"),
      ref: z.string().optional().describe("snapshot 返回的 ref，如 @e3"),
      double: z.boolean().optional().describe("是否双击"),
    }),
    handler: async (a) => json(await bridge.send("click", a)),
  },
  {
    name: "click_at",
    description: "在页面坐标 (x,y) 处点击（相对视口左上角）。",
    schema: z.object({
      x: z.number(),
      y: z.number(),
      button: z.enum(["left", "right", "middle"]).optional(),
    }),
    handler: async (a) => json(await bridge.send("click_at", a)),
  },
  {
    name: "type",
    description:
      "输入文本（支持中文，走 CDP insertText，不会丢字乱码）。" +
      "可指定 selector/ref 先点击聚焦；submit=true 则输入后回车。",
    schema: z.object({
      text: z.string().describe("要输入的文本"),
      selector: z.string().optional().describe("目标输入框的 CSS 选择器"),
      ref: z.string().optional().describe("目标输入框的 ref"),
      submit: z.boolean().optional().describe("输入后是否按回车"),
    }),
    handler: async (a) => json(await bridge.send("type", a)),
  },
  {
    name: "press_key",
    description:
      "按键。常用：Enter / Tab / Escape / Backspace / ArrowUp/Down/Left/Right。",
    schema: z.object({ key: z.string().describe("键名") }),
    handler: async (a) => json(await bridge.send("press_key", a)),
  },
  {
    name: "scroll",
    description: "滚动页面。deltaY>0 向下，<0 向上。可指定元素位置或坐标。",
    schema: z.object({
      deltaY: z.number().optional().describe("纵向滚动量，默认 300"),
      deltaX: z.number().optional().describe("横向滚动量，默认 0"),
      selector: z.string().optional().describe("在此元素位置滚动"),
      x: z.number().optional(),
      y: z.number().optional(),
    }),
    handler: async (a) => json(await bridge.send("scroll", a)),
  },
  {
    name: "wait_for_selector",
    description: "等待某个元素出现，常用于等页面动态渲染。",
    schema: z.object({
      selector: z.string(),
      timeoutMs: z.number().optional().describe("默认 15000"),
    }),
    handler: async (a) => {
      const r = await bridge.send("wait_for_selector", a, (a.timeoutMs ?? 15000) + 5000);
      return text(r.ok ? `✅ 元素已出现：${a.selector}` : `⏱️ 超时，元素未出现：${a.selector}`);
    },
  },
  {
    name: "upload_file",
    description:
      "给页面的 <input type=file> 设置本地文件（不会弹系统对话框）。files 传绝对路径数组。",
    schema: z.object({
      selector: z.string().describe("file input 的 CSS 选择器"),
      files: z.array(z.string()).describe("本地文件绝对路径"),
    }),
    handler: async (a) => json(await bridge.send("upload_file", a)),
  },
  {
    name: "wait",
    description: "等待指定毫秒。",
    schema: z.object({ ms: z.number().default(1000) }),
    handler: async (a) => json(await bridge.send("wait", a)),
  },

  // ── 截图 ──
  {
    name: "screenshot",
    description:
      "截取标签页。支持 format(png/jpeg/webp)、quality(0-100，仅 jpeg/webp)、clip(裁剪区域)、fullPage。" +
      "⚠️ 默认 PNG 整页可达数百 KB，做视觉确认建议 format='jpeg' + quality=70，必要时配 clip 缩小区域。" +
      "页面不可见时会自动切到前台（传 noActivate 可跳过）。",
    schema: z.object({
      fullPage: z.boolean().optional().describe("是否整页截图（默认仅可见区域）"),
      format: z
        .enum(["png", "jpeg", "webp"])
        .optional()
        .describe("图片格式，默认 png；jpeg/webp 可显著减小体积"),
      quality: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("压缩质量 0-100，仅对 jpeg/webp 生效，建议 70-80"),
      clip: z
        .object({
          x: z.number().describe("左上角 x（CSS 像素）"),
          y: z.number().describe("左上角 y（CSS 像素）"),
          width: z.number().positive().describe("宽（CSS 像素）"),
          height: z.number().positive().describe("高（CSS 像素）"),
          scale: z.number().positive().optional().describe("缩放倍数，默认 1"),
        })
        .optional()
        .describe(
          "只截该区域（CSS 像素）。⚠️ 与整页截图的设备像素不等于同一坐标系，别按截图目测的像素直接填"
        ),
      tabId: z.number().optional().describe("目标标签页（默认当前接管的）"),
      noActivate: z.boolean().optional().describe("true：不自动把标签页切到前台"),
    }),
    handler: async (a) => bridge.send("screenshot", a),
    image: true,
  },

  // ── 扩展自重载（改完扩展代码免人工点刷新）──
  {
    name: "ext_reload",
    description:
      "重载扩展本身。改了扩展代码后用它，不必去 chrome://extensions 手点刷新。" +
      "重载后 WebSocket 会断，chrome.alarms 会在约 30 秒内自动连回。",
    schema: z.object({
      delayMs: z.number().optional().describe("延迟重载毫秒，默认 300"),
    }),
    handler: async (a) => json(await bridge.send("self_reload", a)),
  },

  // ── 批量动作（借鉴 WorkBuddy cua_execute 的 batch 思路）──
  {
    name: "batch",
    description:
      "⭐ 一次下发多个动作，顺序执行，省掉逐条往返。每步形如 {action:'click', payload:{ref:'@e2'}}。" +
      "适合「点开菜单→输入→回车→截图」这类固定流程；遇错默认中断并回报已完成步骤。" +
      "注意：每步仍会经过守卫等待，总耗时是各步之和；截图结果只回报字节数，不内联图片。",
    schema: z.object({
      steps: z
        .array(
          z.object({
            action: z.string().describe("动作名：click/type/press_key/hover/scroll/wait/eval/snapshot/navigate…"),
            payload: z.record(z.any()).optional().describe("该动作的参数"),
            waitMs: z.number().optional().describe("本步完成后额外等待的毫秒数"),
          })
        )
        .min(1)
        .max(50)
        .describe("动作序列，最多 50 步"),
      stopOnError: z.boolean().optional().describe("默认 true：遇错即停"),
      timeoutMs: z.number().optional().describe("单步超时，默认 60000"),
    }),
    handler: async (a) => json(await batchCore(a)),
  },

  // ── 泛用 CDP ──
  {
    name: "cdp",
    description:
      "直接发送任意 Chrome DevTools Protocol 命令（逃生舱）。如 method='Network.getCookies'。",
    schema: z.object({
      method: z.string(),
      params: z.record(z.any()).optional(),
    }),
    handler: async (a) => json(await bridge.send("cdp", a)),
  },

  // ═════════════════ 安全守卫（guard） ═════════════════
  {
    name: "guard_stats",
    description:
      "⭐ 查看守卫运行统计：累计拦截数、限速数、累计等待时长、鼠标轨迹次数、当前是否夜间静默。" +
      "用你的登录态操作浏览器前，建议先看一眼。",
    schema: z.object({}),
    handler: async () => json(await bridge.send("guard_stats")),
  },
  {
    name: "guard_config",
    description:
      "⭐ 查看/修改守卫配置。可调：enabled（总开关）、delayMin/delayMax（动作间隔）、" +
      "mousePath（鼠标轨迹开关）、rateMaxActions/rateMaxNav（秒级窗口限额）、" +
      "quietHoursEnabled/quietStart/quietEnd（夜间静默）、" +
      "unlockSensitive（解锁敏感动作，⚠️ 仅当确需发帖/支付/删除时临时开启）。" +
      "不传参数则只读当前配置。",
    schema: z.object({
      enabled: z.boolean().optional().describe("守卫总开关"),
      delayMin: z.number().optional().describe("动作前最小延迟 ms"),
      delayMax: z.number().optional().describe("动作前最大延迟 ms"),
      typeDelayMin: z.number().optional().describe("逐字输入最小间隔 ms"),
      typeDelayMax: z.number().optional().describe("逐字输入最大间隔 ms"),
      mousePath: z.boolean().optional().describe("是否分段移动鼠标"),
      rateMaxActions: z.number().optional().describe("60s 窗口内最多动作数"),
      rateMaxNav: z.number().optional().describe("60s 窗口内最多导航数"),
      quietHoursEnabled: z.boolean().optional().describe("是否启用夜间静默"),
      quietStart: z.number().optional().describe("静默开始小时（0-23）"),
      quietEnd: z.number().optional().describe("静默结束小时（0-23）"),
      unlockSensitive: z.boolean().optional().describe("⚠️ 解锁敏感动作（发帖/支付/删除）"),
    }),
    handler: async (a) => json(await bridge.send("guard_config", a)),
  },

  // ═════════════════ W2 · 交互完整性 ═════════════════
  {
    name: "hover",
    description:
      "⭐ 把鼠标悬停到元素上（selector/text/ref 三选一）。" +
      "很多网站的导航菜单、tooltip、下拉列表**必须先悬停才展开**——纯 click 点不到。",
    schema: z.object({
      selector: z.string().optional(),
      text: z.string().optional(),
      ref: z.string().optional(),
      holdMs: z.number().optional().describe("悬停停留毫秒，默认 300"),
    }),
    handler: async (a) => json(await bridge.send("hover", a)),
  },
  {
    name: "drag",
    description:
      "⭐ 拖拽：从起点元素拖到终点元素或坐标。用于滑块验证、拖拽排序、地图平移。" +
      "起点用 fromSelector/fromText/fromRef，终点用 toSelector/toText/toRef 或 toX/toY。",
    schema: z.object({
      fromSelector: z.string().optional(),
      fromText: z.string().optional(),
      fromRef: z.string().optional(),
      toSelector: z.string().optional(),
      toText: z.string().optional(),
      toRef: z.string().optional(),
      toX: z.number().optional(),
      toY: z.number().optional(),
    }),
    handler: async (a) => json(await bridge.send("drag", a)),
  },
  {
    name: "select_option",
    description: "⭐ 选择 <select> 下拉框的选项（按 value 或 label 文字）。会自动派发 input/change 事件。",
    schema: z.object({
      selector: z.string().describe("select 元素的 CSS 选择器"),
      value: z.string().optional().describe("按 option 的 value 匹配"),
      label: z.string().optional().describe("按 option 的显示文字匹配"),
    }),
    handler: async (a) => json(await bridge.send("select_option", a)),
  },
  {
    name: "type_human",
    description:
      "⭐ 逐字输入。与 type 的区别：不用一次性 insertText，而是**逐字符**输入、" +
      "字符间有固定间隔。适用于带输入防抖、联想下拉的表单。" +
      "中文自动处理（ASCII 逐键、中文逐字插入）。",
    schema: z.object({
      text: z.string().describe("要输入的文本"),
      selector: z.string().optional(),
      ref: z.string().optional(),
      clear: z.boolean().optional().describe("先清空输入框"),
      submit: z.boolean().optional().describe("输入后回车"),
    }),
    handler: async (a) => json(await bridge.send("type_human", a)),
  },
  {
    name: "scroll_into_view",
    description: "把元素滚动到视口中央，并返回其坐标（用于后续精确操作）。",
    schema: z.object({
      selector: z.string().optional(),
      text: z.string().optional(),
      ref: z.string().optional(),
    }),
    handler: async (a) => json(await bridge.send("scroll_into_view", a)),
  },
  {
    name: "scroll_to_bottom",
    description:
      "⭐ 滚动到底（自动判断是否还有新内容）。用于**无限滚动列表**——反复滚到底，直到页面高度连续两轮不变。",
    schema: z.object({
      maxRounds: z.number().optional().describe("最多滚动轮数，默认 10"),
      settleMs: z.number().optional().describe("每轮滚动后等待毫秒，默认 800"),
    }),
    handler: async (a) => json(await bridge.send("scroll_to_bottom", a)),
  },

  // ═════════════════ W3 · 等待条件族 ═════════════════
  {
    name: "wait_for_text",
    description: "⭐ 等页面出现某段文字（轮询 innerText）。比 wait_for_selector 更贴合“等内容出来”的直觉。",
    schema: z.object({
      text: z.string().describe("要等待的文字"),
      timeoutMs: z.number().optional().describe("默认 15000"),
      intervalMs: z.number().optional().describe("轮询间隔，默认 250"),
    }),
    handler: async (a) => {
      const r = await bridge.send("wait_for_text", a, (a.timeoutMs ?? 15000) + 5000);
      return text(r.ok ? `✅ 文字已出现：${a.text}` : `⏱️ 超时，文字未出现：${a.text}`);
    },
  },
  {
    name: "wait_for_url",
    description: "⭐ 等 URL 变化。传 contains（包含子串）或 regex（正则）。常用于等跳转完成。",
    schema: z.object({
      contains: z.string().optional().describe("URL 包含的子串"),
      regex: z.string().optional().describe("URL 匹配的正则"),
      timeoutMs: z.number().optional().describe("默认 15000"),
    }),
    handler: async (a) => {
      const r = await bridge.send("wait_for_url", a, (a.timeoutMs ?? 15000) + 5000);
      return text(r.ok ? `✅ URL 已匹配：${a.contains || a.regex}` : `⏱️ 超时，URL 未匹配：${a.contains || a.regex}`);
    },
  },
  {
    name: "wait_for_function",
    description:
      "⭐ 等任意 JS 表达式返回真值。最强的等待原语——可组合出任何条件（如等某个全局变量出现、等数据加载完）。",
    schema: z.object({
      expression: z.string().describe("返回真值的 JS 表达式，如 window.__DATA__ !== undefined"),
      timeoutMs: z.number().optional().describe("默认 15000"),
      intervalMs: z.number().optional().describe("轮询间隔，默认 250"),
    }),
    handler: async (a) => {
      const r = await bridge.send("wait_for_function", a, (a.timeoutMs ?? 15000) + 5000);
      return text(r.ok ? `✅ 条件已满足：${a.expression}` : `⏱️ 超时，条件未满足：${a.expression}`);
    },
  },
  {
    name: "wait_for_load",
    description: "⭐ 等页面加载状态。state='interactive' 或 'complete'（默认）。",
    schema: z.object({
      state: z.enum(["interactive", "complete"]).optional(),
      timeoutMs: z.number().optional().describe("默认 20000"),
    }),
    handler: async (a) => {
      const r = await bridge.send("wait_for_load", a, (a.timeoutMs ?? 20000) + 5000);
      return text(r.ok ? `✅ 已加载：${a.state ?? "complete"}` : `⏱️ 加载超时`);
    },
  },
  {
    name: "wait_for_selector_gone",
    description: "⭐ 等元素**消失**（常用于等 loading 遮罩消失）。",
    schema: z.object({
      selector: z.string(),
      timeoutMs: z.number().optional().describe("默认 15000"),
    }),
    handler: async (a) => {
      const r = await bridge.send("wait_for_selector_gone", a, (a.timeoutMs ?? 15000) + 5000);
      return text(r.ok ? `✅ 元素已消失：${a.selector}` : `⏱️ 超时，元素仍在：${a.selector}`);
    },
  },

  // ═════════════════ W4 · 存储与网络 ═════════════════
  {
    name: "get_cookies",
    description:
      "⭐ 读取指定 URL（默认当前页）的 cookies（只读）。" +
      "value 默认脱敏为 ***，需要真实值请传 includeValues=true（⚠️ 含敏感凭据，勿外传）。",
    schema: z.object({
      url: z.string().optional().describe("目标 URL，默认当前标签页"),
      includeValues: z.boolean().optional().describe("是否返回真实 cookie value"),
    }),
    handler: async (a) => json(await bridge.send("get_cookies", a)),
  },
  {
    name: "set_cookie",
    description: "⭐ 写入 cookie（⚠️ 改变站点状态，默认被守卫拦截，需先 unlockSensitive）。",
    schema: z.object({
      url: z.string(),
      name: z.string(),
      value: z.string(),
      domain: z.string().optional(),
      path: z.string().optional(),
      secure: z.boolean().optional(),
      httpOnly: z.boolean().optional(),
      sameSite: z.enum(["no_restriction", "lax", "strict"]).optional(),
      expirationDate: z.number().optional(),
    }),
    handler: async (a) => json(await bridge.send("set_cookie", a)),
  },
  {
    name: "delete_cookie",
    description: "⭐ 删除 cookie（⚠️ 改变站点状态，默认被守卫拦截）。",
    schema: z.object({
      url: z.string(),
      name: z.string(),
    }),
    handler: async (a) => json(await bridge.send("delete_cookie", a)),
  },
  {
    name: "storage_get",
    description: "⭐ 读取页面的 localStorage / sessionStorage。不传 key 则返回全部。",
    schema: z.object({
      area: z.enum(["local", "session"]).optional().describe("默认 local"),
      key: z.string().optional().describe("只读某个 key"),
    }),
    handler: async (a) => json(await bridge.send("storage_get", a)),
  },
  {
    name: "storage_set",
    description: "⭐ 写 localStorage / sessionStorage（⚠️ 改变站点状态，默认被守卫拦截）。",
    schema: z.object({
      area: z.enum(["local", "session"]).optional(),
      key: z.string(),
      value: z.string(),
    }),
    handler: async (a) => json(await bridge.send("storage_set", a)),
  },
  {
    name: "console_start",
    description:
      "⭐ 开始抓取页面控制台日志（hook console.log/warn/error + 未捕获异常）。" +
      "⚠️ 只能抓『注入之后』产生的日志。用于诊断页面报错。",
    schema: z.object({}),
    handler: async () => json(await bridge.send("console_start")),
  },
  {
    name: "console_logs",
    description: "⭐ 取回已抓取的控制台日志。可按 level 过滤。",
    schema: z.object({
      level: z.enum(["log", "info", "warn", "error", "debug", "uncaught", "unhandledrejection"]).optional(),
      limit: z.number().optional().describe("最多返回条数，默认 100"),
    }),
    handler: async (a) => json(await bridge.send("console_logs", a)),
  },
  {
    name: "network_start",
    description: "⭐ 开始抓取网络请求（只读，最多缓存 800 条）。用于分析接口、定位数据来源。",
    schema: z.object({}),
    handler: async () => json(await bridge.send("network_start")),
  },
  {
    name: "network_log",
    description: "⭐ 取回已抓取的网络请求（含 URL / 方法 / 状态码 / 类型）。可用 filter 正则过滤 URL。",
    schema: z.object({
      filter: z.string().optional().describe("URL 正则过滤"),
      limit: z.number().optional().describe("最多返回条数，默认 100"),
    }),
    handler: async (a) => json(await bridge.send("network_log", a)),
  },
  {
    name: "network_stop",
    description: "停止网络抓取并返回捕获总数。",
    schema: z.object({}),
    handler: async () => json(await bridge.send("network_stop")),
  },

  // ═════════════════ W5 · 文件与批量编排 ═════════════════
  {
    name: "download_file",
    description:
      "⭐ 下载文件。两种模式：① 传 url（直链）→ 直接下载；" +
      "② 传 dir（目录）→ 设置该标签页的下载行为，配合页面内点击触发下载。" +
      "filename 可指定保存文件名（直链模式）。",
    schema: z.object({
      url: z.string().optional().describe("直链 URL"),
      filename: z.string().optional().describe("保存文件名（可选）"),
      dir: z.string().optional().describe("页面内下载的保存目录（绝对路径）"),
    }),
    handler: async (a) => json(await bridge.send("download_file", a)),
  },
  {
    name: "download_list",
    description: "⭐ 查看最近的下载记录（文件名 / 状态 / 已下载字节 / 错误）。",
    schema: z.object({
      limit: z.number().optional().describe("默认 20"),
    }),
    handler: async (a) => json(await bridge.send("download_list", a)),
  },
  {
    name: "tabs_batch",
    description:
      "⭐ 批量标签页操作。op=open（批量开 URL，串行带节奏）/ close（按 id 批量关）/" +
      "close_by_url（按 URL 正则批量关）/ close_others（只留一个）。",
    schema: z.object({
      op: z.enum(["open", "close", "close_by_url", "close_others"]),
      urls: z.array(z.string()).optional().describe("op=open 时的 URL 列表"),
      tabIds: z.array(z.number()).optional().describe("op=close 时的标签页 id 列表"),
      tabId: z.number().optional().describe("op=close_others 时保留的标签页"),
      pattern: z.string().optional().describe("op=close_by_url 时的 URL 正则"),
    }),
    handler: async (a) => json(await bridge.send("tabs_batch", a)),
  },
  {
    name: "cdp_batch",
    description: "⭐ 一次发送多条 CDP 命令（减少往返）。commands=[{method, params}]。",
    schema: z.object({
      commands: z.array(z.object({ method: z.string(), params: z.record(z.any()).optional() }))
        .describe("CDP 命令列表"),
    }),
    handler: async (a) => json(await bridge.send("cdp_batch", a)),
  },
  {
    name: "extract",
    description:
      "⭐ 批量提取元素内容。items=[{key, selector, attr?, multiple?, limit?}]。" +
      "比多次 eval 高效，是『抓列表数据』的首选。",
    schema: z.object({
      items: z.array(z.object({
        key: z.string().optional(),
        selector: z.string(),
        attr: z.string().optional().describe("取属性（如 href/src），省略取文本"),
        multiple: z.boolean().optional().describe("是否取所有匹配元素"),
        limit: z.number().optional(),
      })),
    }),
    handler: async (a) => json(await bridge.send("extract", a)),
  },

  // ══════════════════════════════════════════════════════════
  //  ⭐ v1.4 新增：观察与诊断族（集成自 BrowserMCP 的成熟设计）
  //
  //  设计理念（借鉴 BrowserMCP 的"操作-反馈闭环"）：
  //    Agent 不该"盲操作"——点击前先 highlight_element 指出目标，
  //    点击后用 extract_aria_snapshot 核对结果。
  //    这些工具**只读、无副作用**，因此不消耗守卫配额。
  // ══════════════════════════════════════════════════════════
  {
    name: "highlight_element",
    description:
      "⭐ 高亮闪烁元素（默认 1.2s 红框）。**点击前先高亮，肉眼确认没点歪**——" +
      "这是操作-反馈闭环的关键一环，比事后看截图快得多。",
    schema: z.object({
      selector: z.string().optional(),
      text: z.string().optional(),
      ref: z.string().optional(),
      durationMs: z.number().optional().describe("高亮持续毫秒，默认 1200"),
      color: z.string().optional().describe("CSS 颜色，默认 #ff3b30"),
      tabId: z.number().optional(),
    }),
    handler: async (a) => json(await bridge.send("highlight_element", a)),
  },
  {
    name: "extract_aria_snapshot",
    description:
      "⭐ 语义化 DOM 快照：只保留可交互元素（链接/按钮/输入框），裁剪为给 LLM 读的紧凑清单。" +
      "含 role/name/坐标/disabled/checked。**判断『页面长什么样』的首选**，比截 DOM 省 90% token。",
    schema: z.object({
      maxNodes: z.number().optional().describe("最多返回节点数，默认 400"),
      tabId: z.number().optional(),
    }),
    handler: async (a) => json(await bridge.send("extract_aria_snapshot", a)),
  },
  {
    name: "inject_css",
    description:
      "注入临时 CSS（如隐藏遮挡浮层、扩大点击区域、强制显示隐藏元素）。同 id 会覆盖。",
    schema: z.object({
      css: z.string().describe("CSS 文本"),
      id: z.string().optional().describe("样式标签 id，默认 __xyBridgeInjected"),
      tabId: z.number().optional(),
    }),
    handler: async (a) => json(await bridge.send("inject_css", a)),
  },
  {
    name: "remove_injected_css",
    description: "移除由 inject_css 注入的样式。",
    schema: z.object({
      id: z.string().optional(),
      tabId: z.number().optional(),
    }),
    handler: async (a) => json(await bridge.send("remove_injected_css", a)),
  },
  {
    name: "get_selected_text",
    description: "读取用户当前选中的文字（含输入框内选区）。",
    schema: z.object({ tabId: z.number().optional() }),
    handler: async (a) => json(await bridge.send("get_selected_text", a)),
  },
  {
    name: "get_images",
    description: "列出页面图片（src/alt/尺寸/是否可见）。抓取素材、检查图是否加载失败时用。",
    schema: z.object({
      includeHidden: z.boolean().optional().describe("是否含不可见图片"),
      limit: z.number().optional(),
      tabId: z.number().optional(),
    }),
    handler: async (a) => json(await bridge.send("get_images", a)),
  },
  {
    name: "get_meta_tags",
    description: "读取页面 meta 信息：title/description/canonical/lang/og:*/twitter:*。",
    schema: z.object({ tabId: z.number().optional() }),
    handler: async (a) => json(await bridge.send("get_meta_tags", a)),
  },
  {
    name: "get_forms",
    description:
      "⭐ 列出页面所有表单及字段清单（name/id/type/placeholder/required）。" +
      "**填表前先看清单，避免盲填**。密码字段值以 *** 返回。",
    schema: z.object({ tabId: z.number().optional() }),
    handler: async (a) => json(await bridge.send("get_forms", a)),
  },
  {
    name: "get_page_dimensions",
    description: "页面尺寸与滚动位置（viewport/page/scroll/DPR）。判断是否需要滚动时用。",
    schema: z.object({ tabId: z.number().optional() }),
    handler: async (a) => json(await bridge.send("get_page_dimensions", a)),
  },
  {
    name: "focus",
    description: "聚焦元素（不点击）。比 click 更轻，适合只想让输入框获得焦点的场景。",
    schema: z.object({
      selector: z.string().optional(),
      text: z.string().optional(),
      ref: z.string().optional(),
      tabId: z.number().optional(),
    }),
    handler: async (a) => json(await bridge.send("focus", a)),
  },
  {
    name: "get_elements_count",
    description: "统计匹配元素数量。判断『内容加载出来没有』的轻量手段（比等 selector 更快）。",
    schema: z.object({
      selector: z.string(),
      tabId: z.number().optional(),
    }),
    handler: async (a) => json(await bridge.send("get_elements_count", a)),
  },
  {
    name: "set_element_attribute",
    description:
      "设置/移除元素属性（调试用：补 missing 属性、强制启用禁用按钮）。" +
      "⚠️ 会产生副作用，走安全守卫。",
    schema: z.object({
      selector: z.string(),
      name: z.string(),
      value: z.string().optional().describe("省略或空串表示移除该属性"),
      tabId: z.number().optional(),
    }),
    handler: async (a) => json(await bridge.send("set_element_attribute", a)),
  },
  {
    name: "console_errors",
    description: "读取页面已收集的控制台错误（需先 console_start）。排查『点了没反应』时用。",
    schema: z.object({
      limit: z.number().optional(),
      tabId: z.number().optional(),
    }),
    handler: async (a) => json(await bridge.send("console_errors", a)),
  },
  {
    name: "guard_selftest",
    description:
      "⭐ 守卫自检：在浏览器里实测各配置项的取值与拦截逻辑是否正常工作。" +
      "**部署后第一件事就调它**，确认守卫真的生效（而不是配置写了没跑）。",
    schema: z.object({ tabId: z.number().optional() }),
    handler: async (a) => json(await bridge.send("guard_selftest", a)),
  },
];

// ─────────────────────────── MCP Server ───────────────────────────

const server = new Server(
  { name: "chrome-mcp-bridge", version: "1.6.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.schema) as any,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find((t) => t.name === req.params.name);
  if (!tool) {
    return { content: [{ type: "text", text: `未知工具：${req.params.name}` }], isError: true };
  }
  try {
    const parsed = tool.schema.parse(req.params.arguments ?? {});
    const result = await tool.handler(parsed);

    // 截图工具：把 base64 转成 MCP image content
    if (tool.image && result && result.base64) {
      return {
        content: [
          { type: "image", data: result.base64, mimeType: "image/png" },
        ],
      };
    }
    return result;
  } catch (e: any) {
    return {
      content: [{ type: "text", text: `❌ ${e?.message ?? String(e)}` }],
      isError: true,
    };
  }
});

// ─────────────────────────── 启动 ───────────────────────────

async function main() {
  try {
    await bridge.start();
  } catch (e: any) {
    console.error(`[xy-bridge] WebSocket 启动失败：${e.message}`);
    process.exit(1);
  }

  // ⭐ v1.5：把本地工具注册给 /call，让「HTTP 调试」与「MCP 工具」走同一套逻辑
  bridge.registerLocal("media_grab", mediaGrabCore);
  // ⭐ batch 同理：纯 Node 侧循环，扩展里没有这个 action
  bridge.registerLocal("batch", batchCore);

  // 状态变化日志（stderr，不污染 stdio 协议）
  const iv = setInterval(() => {
    const on = bridge.isConnected();
    if (on !== (globalThis as any).__lastConn) {
      (globalThis as any).__lastConn = on;
      console.error(`[xy-bridge] 扩展${on ? "已连接" : "已断开"}`);
    }
  }, 1000);
  iv.unref();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[xy-bridge] MCP server 就绪，等待扩展连接 ws://127.0.0.1:${PORT}`);
}

main().catch((e) => {
  console.error("[xy-bridge] fatal:", e);
  process.exit(1);
});
