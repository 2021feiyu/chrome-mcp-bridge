/**
 * 小羽桥 · Chrome Bridge —— background service worker
 *
 * 职责：
 *   1. 连接本地 MCP server 的 WebSocket（ws://127.0.0.1:9223）
 *   2. 收到指令后，用 chrome.debugger 把 CDP 命令打到「当前激活标签页」
 *   3. 把结果回传
 *
 * 关键点：chrome.debugger 是「浏览器给自己开的调试权限」，
 * 不受「外部进程不能 attach 运行中 Chrome」这条 Chrome 136+ 安全策略限制。
 */

import {
  guardBefore,
  bezierPath,
  mousePathConfig,
  clickOffset,
  clickHoldMs,
  keyRhythm,
  shouldTypo,
  resetTempo,
  pacedDelay,
  noteMousePath,
  loadGuardConfig,
  saveGuardConfig,
  getGuardConfig,
  getGuardStats,
  setSensitiveUnlock,
} from "./guard.js";

const WS_URL = "ws://127.0.0.1:9223";
const PROTOCOL_VERSION = "1.5";
const KEEPALIVE_ALARM = "xy-keepalive";

let ws = null;
let connected = false;      // server 连接状态
let attachedTabId = null;   // 当前已 attach 的标签页
let reconnectTimer = null;
let desiredConnected = false; // 用户是否点了 Connect（内存镜像）
let heartbeatTimer = null;    // WebSocket 心跳

// ── ⭐ MV3 保活机制（三重保险，实测得出） ──
//
// 背景：MV3 service worker 空闲约 30s 被 Chrome 终止，WebSocket 随之静默关闭。
// Chrome 116+ 起：「收发 WebSocket 消息」算作活动，会重置空闲计时器。
//
// 因此需要：
//   ① WebSocket 心跳（每 20s 发 ping）→ 让 worker 在正常通信时保持存活
//   ② chrome.alarms（最小 30s）→ worker 被杀了也能「把它唤醒」重连
//   ③ 监听器顶层同步注册 → Chrome 唤醒 worker 时能立刻收到事件

/** ⚠️ Chrome 硬限制：alarm 周期最小 0.5 分钟（30s），小于此值不被接受 */
const KEEPALIVE_PERIOD_MIN = 0.5;
const HEARTBEAT_MS = 20000; // 20s，必须 < 30s 空闲窗口

function ensureKeepalive() {
  try {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MIN });
  } catch (_) {}
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: "ping", t: Date.now() })); } catch (_) {}
    }
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// 从 storage 同步恢复用户意愿（避免 SW 重启后内存变量归零导致不重连）
async function restoreDesired() {
  try {
    const r = await chrome.storage.local.get(["desiredConnected"]);
    desiredConnected = !!(r && r.desiredConnected);
  } catch (_) {
    desiredConnected = false;
  }
  return desiredConnected;
}

async function setDesired(v) {
  desiredConnected = v;
  try { await chrome.storage.local.set({ desiredConnected: v }); } catch (_) {}
}

// ─────────────────────────── 状态广播 ───────────────────────────

function state() {
  return {
    connected,
    attachedTabId,
    desired: desiredConnected,
  };
}

async function broadcast() {
  // 1) 更新 badge
  try {
    const s = state();
    if (s.connected && s.attachedTabId != null) {
      await chrome.action.setBadgeText({ text: "ON" });
      await chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
    } else if (s.desired) {
      await chrome.action.setBadgeText({ text: "…" });
      await chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
    } else {
      await chrome.action.setBadgeText({ text: "" });
    }
  } catch (_) { /* ignore */ }

  // 2) 通知 popup（若开着）
  try {
    await chrome.runtime.sendMessage({ type: "state", state: state() });
  } catch (_) { /* popup 可能没开，忽略 */ }
}

// ─────────────────────────── WebSocket ───────────────────────────

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  ensureKeepalive(); // 启动保活
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    connected = true;
    console.log("[bridge] WebSocket connected");
    // ⭐ 握手声明身份：server 只认 role=extension 的连接为主连接
    ws.send(JSON.stringify({ type: "hello", version: PROTOCOL_VERSION, role: "extension" }));
    startHeartbeat(); // ⭐ 启动心跳，保 service worker 存活
    broadcast();
  };

  ws.onmessage = async (evt) => {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch (_) {
      return;
    }
    if (msg.type === "pong") return; // 心跳应答
    await handleCommand(msg);
  };

  ws.onclose = () => {
    connected = false;
    stopHeartbeat();
    console.log("[bridge] WebSocket closed");
    broadcast();
    // ⭐ 断线即重连（不依赖内存变量，主动读 storage）
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose 会跟着触发，这里不重复处理
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    // ⭐ 每次重连前同步确认用户意愿（SW 重启后内存变量可能为 false）
    const want = desiredConnected || (await restoreDesired());
    if (want) connect();
  }, 1500);
}

function sendWs(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

// ─────────────────────────── chrome.debugger 封装 ───────────────────────────

async function attachToTab(tabId) {
  // ⭐⭐⭐ 必须抢在任何 CDP 命令之前（2026-10-22 修 v1.6.1）
  // 教训：v1.6 把 ensureTabVisible 放在本函数**末尾**，结果
  //   ① 已 attach 同一页时走下面的 early return，根本执行不到；
  //   ② 下面那句健康检查 Runtime.evaluate 本身就是 CDP 调用，
  //      在 hidden 页面会挂死 —— 于是永远走不到末尾。
  // 所以置前只能放在最前面，且只能用扩展 API 判断（见 ensureTabVisible）。
  if (NEEDS_FOREGROUND.has(currentAction)) {
    try { await ensureTabVisible(tabId); } catch (_) {}
  }

  if (attachedTabId === tabId) {
    // 已 attach 同一标签页，检查是否还活着
    // ⭐ 加 2s 超时：hidden 页面上这个探针会无限挂，不能让健康检查变成卡死点
    try {
      await Promise.race([
        chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
          expression: "1",
          returnByValue: true,
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("probe timeout")), 2000)),
      ]);
      return;
    } catch (_) {
      attachedTabId = null; // 掉了或探测超时，重来
    }
  }

  if (attachedTabId != null && attachedTabId !== tabId) {
    try { await chrome.debugger.detach({ tabId: attachedTabId }); } catch (_) {}
    attachedTabId = null;
  }

  // ⭐ 提前拦截：Chrome 禁止扩展用 debugger 操作内部页（chrome:// / edge:// / about: 等）
  // 否则报 "Cannot access a chrome:// URL"，对使用者毫无信息量。
  try {
    const t = await chrome.tabs.get(tabId);
    const proto = (t.url || "").split(":")[0];
    if (proto === "chrome" || proto === "edge" || proto === "about" || proto === "chrome-extension") {
      throw new Error(
        `无法接管该标签页：它是浏览器内部页（${t.url}）。` +
        `请先在浏览器里打开一个普通网页（http/https），例如 https://www.baidu.com/`
      );
    }
  } catch (e) {
    if (e && /无法接管/.test(e.message)) throw e;
    // tabs.get 本身失败（标签页可能已关闭）——继续尝试 attach，让它报原始错误
  }

  // ⭐ 校准（Chrome 官方文档 / shengsheng.fun 实践）：
  //    attach 会用掉一次"调试会话"；若后续任何步骤抛错而不 detach，
  //    会话会一直挂在浏览器上（表现为"处理中"卡死，且下次 attach 报已附加）。
  //    因此这里用 try 包住，失败时主动回退内部状态。
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    attachedTabId = null;
    throw new Error(`attach 失败：${e && e.message ? e.message : e}`);
  }
  attachedTabId = tabId;

  // 开启必要域
  // ⭐ 校准（zylos.ai）：域只启用一次，常驻连接复用——
  //    "每个命令新建连接 + 每次都 enable 域"是 CDP 反模式（每条 ~500-800ms 开销）。
  //    本扩展是常驻 WebSocket，域在 attach 时统一开一次即可。
  const domains = ["Page", "DOM", "Runtime", "Network"];
  for (const d of domains) {
    try { await chrome.debugger.sendCommand({ tabId }, `${d}.enable`); } catch (_) {}
  }

  // ⭐ 反冻结（2026-10-12 加）：后台标签页会被 Chrome 冻结（rAF 不跑、定时器节流），
  //    会导致依赖页面异步的操作挂住。这里显式把生命周期置为 active。
  //    注意：这不会把标签页"切到前台"（那是 tab_select 的事），只是解除后台冻结。
  try {
    await chrome.debugger.sendCommand({ tabId }, "Page.setWebLifecycleState", { state: "active" });
  } catch (_) {}

  await broadcast();
}

async function detachCurrent() {
  if (attachedTabId != null) {
    try { await chrome.debugger.detach({ tabId: attachedTabId }); } catch (_) {}
    attachedTabId = null;
  }
  await broadcast();
}

// ⭐⭐⭐ 页面不可见时自动置前（2026-10-22 加）
//
// 血泪背景：`Page.setWebLifecycleState("active")` 只解了「后台冻结」，
//   没解「不可见」。窗口被别的窗口遮挡 / 最小化 / 标签页被切走时，
//   document.visibilityState = "hidden"，此时 Input.dispatchMouseEvent
//   与 Runtime.evaluate 会挂起直到内部超时（实测 click 45s 超时、
//   另一次 30.8s 才返回），表现为「桥卡死」。
//
// ⚠️ 检测本身不能用 Runtime.evaluate —— 它在 hidden 页面同样会挂。
//   只能用扩展 API（chrome.windows / chrome.tabs），这类调用不经过渲染进程。
//
// 覆盖三种 hidden 来源：
//   ① 窗口最小化       → windows.update {state:"normal"}
//   ② 窗口失焦/被遮挡   → windows.update {focused:true}
//   ③ 标签页非活动      → tabs.update {active:true}
//
// 只在「确实需要改变」时才动手；已在前台则零开销、不抢焦点。
// 单次可跳过：payload.noActivate = true。
let autoActivateTab = true;
/** 当前正在执行的动作（供 attachToTab 判断是否需要前台） */
let currentAction = "";
let currentPayload = {};

const NEEDS_FOREGROUND = new Set([
  "click", "click_at", "type", "type_human", "press_key", "hover", "drag",
  "scroll", "scroll_into_view", "scroll_to_bottom", "select_option",
  "upload_file", "screenshot",
]);

async function ensureTabVisible(tabId) {
  if (!autoActivateTab) return false;
  if (currentPayload && currentPayload.noActivate) return false;
  try {
    const t = await chrome.tabs.get(tabId);
    let changed = false;

    if (t.windowId != null) {
      try {
        const w = await chrome.windows.get(t.windowId);
        if (w.state === "minimized") {
          await chrome.windows.update(t.windowId, { state: "normal" });
          changed = true;
        }
        // 被遮挡 / 失焦同样会让页面进入 hidden
        if (!w.focused) {
          await chrome.windows.update(t.windowId, { focused: true });
          changed = true;
        }
      } catch (_) {}
    }

    if (!t.active) {
      try { await chrome.tabs.update(tabId, { active: true }); changed = true; } catch (_) {}
    }

    if (changed) {
      // 让渲染进程确认已切回前台，再放行后续输入事件
      try { await chrome.debugger.sendCommand({ tabId }, "Page.bringToFront"); } catch (_) {}
      await sleep(120);
    }
    return changed;
  } catch (_) {
    return false;
  }
}

// chrome.debugger 被外部（如 DevTools 打开）抢走时的处理
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === attachedTabId) {
    attachedTabId = null;
    broadcast();
  }
});

// ⭐⭐⭐ 自动应答原生对话框（2026-10-12 加）
//
// 血泪背景：`chrome.tabs.update(tabId,{url})` 导航时，若页面有 beforeunload
//   监听（B 站专栏编辑器就有），Chrome 会弹出「离开此网站？」原生确认框。
//   **原生对话框会阻塞该标签页的渲染进程** → 之后所有 Runtime.evaluate /
//   DOM.* / Page.captureScreenshot 全部超时（表现为「桥卡死」，极具迷惑性）。
//   实测：连 chrome.debugger.sendCommand 本身也会挂住。
//
// 解法：监听 Page.javascriptDialogOpening 事件，立刻 accept/dismiss。
//   该事件由浏览器进程推送，**不受渲染进程阻塞影响**，所以一定能收到。
//
// 策略：beforeunload 类对话框 → dismiss（accept=true 表示"离开"，
//   会对未保存内容生效；但我们的场景是「要导航走」，所以 accept=true）。
//   其它类型（alert/confirm/prompt）→ 默认 accept。
let autoDismissDialogs = true;   // 可用 set_dialog_policy 开关

function installDialogAutoHandler() {
  try {
    chrome.debugger.onEvent.addListener(async (source, method, params) => {
      if (method !== "Page.javascriptDialogOpening") return;
      if (!autoDismissDialogs) return;
      const type = (params && params.type) || "";
      try {
        await chrome.debugger.sendCommand(
          { tabId: source.tabId },
          "Page.handleJavaScriptDialog",
          { accept: true }
        );
        console.log("[bridge] 自动应答原生对话框:", type, (params && params.message) || "");
      } catch (e) {
        console.warn("[bridge] 应答对话框失败:", String(e));
      }
    });
  } catch (_) {}
}
installDialogAutoHandler();

// ⭐ 网络请求抓取（只读，按需开启）
// 只缓冲「已 network_start 的标签页」，不主动抓取，避免无谓开销与隐私风险。
chrome.debugger.onEvent.addListener((source, method, params) => {
  const buf = networkCapture[source.tabId];
  if (!buf || !buf.on) return;
  try {
    if (method === "Network.requestWillBeSent") {
      buf.reqs.push({
        t: Date.now(), id: params.requestId, method: params.request?.method,
        url: params.request?.url, type: params.type,
        headers: params.request?.headers, postData: params.request?.postData,
        status: null, mimeType: null,
      });
      if (buf.reqs.length > 800) buf.reqs.splice(0, buf.reqs.length - 800);
    } else if (method === "Network.responseReceived") {
      const r = buf.reqs.find((x) => x.id === params.requestId);
      if (r) { r.status = params.response?.status; r.mimeType = params.response?.mimeType; }
    } else if (method === "Network.loadingFailed") {
      const r = buf.reqs.find((x) => x.id === params.requestId);
      if (r) { r.failed = true; r.error = params.errorText; }
    }
  } catch (_) { /* 忽略 */ }
});

// ══════════════════════════════════════════════════════════════
// ⭐⭐⭐ 网页媒体嗅探（v1.5 · 2026-10-17）
//
// 【做什么】被动观察网络响应，把「像媒体」的 URL 按标签页记下来。
//   · 只观察，不拦截、不改写（MV3 的 webRequest 只能观察，blocking 已移除）
//   · 三重判定：URL 后缀 → 响应头 Content-Type → Content-Length（避免误收 .js）
//   · 按 tab 隔离、去重、导航时清空
//
// 【不做什么】
//   · 不解析 m3u8（那是 server 的活：下载 + 合并都在 Node 端，扩展内存扛不住长视频）
//   · 不碰 DRM（Widevine / SAMPLE-AES 一律不处理，只如实报告"疑似加密"）
//   · 不读响应体（只读头，避免把页面拖慢）
//
// 【为什么放扩展】webRequest 能看见「页面自己发的请求」，包括 blob 播放器背后的
//   m3u8 分片请求 —— 这是 fetch/XHR hook 做不到的部分（猫抓 Cat Catch 同款思路）。
// ══════════════════════════════════════════════════════════════

const MEDIA_EXT_RE = /\.(m3u8|mpd|mp4|webm|flv|mov|mkv|m4v|mp3|m4a|aac|ogg|opus|wav|flac)(\?|#|$)/i;
const MEDIA_MIME_RE = /^(video|audio)\//i;
const MEDIA_MAX_PER_TAB = 300;
const MEDIA_KEEP_TABS = 20;
let mediaSniffEnabled = true;
const mediaByTab = new Map(); // tabId -> Map<url, item>

/** 把响应头数组变成小写 key 的普通对象 */
function headersToObj(hs) {
  const out = {};
  if (!Array.isArray(hs)) return out;
  for (const h of hs) {
    if (h && h.name) out[String(h.name).toLowerCase()] = h.value;
  }
  return out;
}

/** 判定 + 归一化一条媒体记录（返回 null 表示不是媒体） */
function classifyMedia(url, mime, size) {
  const extHit = MEDIA_EXT_RE.test(url);
  const mimeHit = MEDIA_MIME_RE.test(mime || "");
  if (!extHit && !mimeHit) return null;
  let type = "other";
  if (/\.m3u8(\?|#|$)/i.test(url) || /mpegurl/i.test(mime || "")) type = "hls";
  else if (/\.mpd(\?|#|$)/i.test(url) || /dash\+xml/i.test(mime || "")) type = "dash";
  else if (/\.mp4(\?|#|$)/i.test(url) || /^video\/mp4/i.test(mime || "")) type = "mp4";
  else if (/^video\//i.test(mime || "")) type = "video";
  else if (/^audio\//i.test(mime || "")) type = "audio";
  else if (/\.(mp3|m4a|aac|ogg|opus|wav|flac)(\?|#|$)/i.test(url)) type = "audio";
  return { type, mime: mime || "", size: Number(size) || 0 };
}

function rememberMedia(tabId, url, info) {
  let m = mediaByTab.get(tabId);
  if (!m) {
    m = new Map();
    mediaByTab.set(tabId, m);
    // 只保留最近 N 个标签页的记录，防止长时间运行内存膨胀
    if (mediaByTab.size > MEDIA_KEEP_TABS) {
      const oldest = mediaByTab.keys().next().value;
      if (oldest !== tabId) mediaByTab.delete(oldest);
    }
  }
  const prev = m.get(url);
  if (prev) {                       // 去重：同 URL 只保留最新的大小/类型
    prev.size = info.size || prev.size;
    prev.mime = info.mime || prev.mime;
    prev.lastSeen = Date.now();
    return;
  }
  m.set(url, {
    url,
    type: info.type,
    mime: info.mime,
    size: info.size,
    firstSeen: Date.now(),
    lastSeen: Date.now(),
  });
  if (m.size > MEDIA_MAX_PER_TAB) {
    // 超量时丢最早的（多数是分片，分片本来也不该单独列）
    const first = m.keys().next().value;
    m.delete(first);
  }
}

// ⚠️ MV3 铁律：监听器必须在顶层**同步**注册，不能放在 await / 事件回调里。
//    否则 service worker 被唤醒时事件已经错过。
try {
  chrome.webRequest.onResponseStarted.addListener(
    (d) => {
      if (!mediaSniffEnabled) return;
      if (!d || d.tabId == null || d.tabId < 0) return;
      try {
        const hs = headersToObj(d.responseHeaders);
        const cls = classifyMedia(d.url || "", hs["content-type"] || "", hs["content-length"] || 0);
        if (cls) rememberMedia(d.tabId, d.url, cls);
      } catch (_) { /* 嗅探失败绝不能影响主链路 */ }
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
  );
} catch (e) {
  // 没给 webRequest 权限时会走到这里 —— 静默降级，其余功能不受影响
  console.warn("[media] 嗅探未启用（缺 webRequest 权限？）", e && e.message);
}

// 导航到新页面 → 清空该 tab 的旧记录（否则会把上一个视频的地址带进来）
try {
  chrome.webNavigation.onCommitted.addListener((d) => {
    if (d && d.frameId === 0 && d.tabId != null) mediaByTab.delete(d.tabId);
  });
} catch (_) { /* webNavigation 权限可选 */ }

// 标签页关闭 → 释放
try {
  chrome.tabs.onRemoved.addListener((tabId) => { mediaByTab.delete(tabId); });
} catch (_) {}

/** 按体积/类型排序（大的、hls 优先 —— 用户多半要的是主视频不是广告） */
function sortMedia(items) {
  const w = (t) => (t === "hls" ? 0 : t === "dash" ? 1 : t === "mp4" ? 2 : t === "video" ? 3 : 4);
  return items.sort((a, b) => {
    const dw = w(a.type) - w(b.type);
    if (dw) return dw;
    return (b.size || 0) - (a.size || 0);
  });
}

// ─────────────────────────── 指令处理 ───────────────────────────

// ══════════════════════════════════════════════════════════════
// ⭐⭐⭐ 动作幂等层（v1.5 · 2026-10-17）
//
// 【病根】server 端 bridge.send() 有 60s 超时，超时就 reject 并从 pending 删除；
//   但扩展端 dispatch 还在跑。跑完 sendWs({id,...}) 时 server 已删 pending → 回包被丢弃。
//   调用方看到「超时」，操作实际已执行 → 重试 = 重复点击/重复输入。
//   （例如标题重复输入、话题重复发布，都是这个机制。）
//
// 【解法】给每个动作一个 opId + 终态记录：
//   · 超时不再等于失败 —— 返回 { code:"PENDING", opId }
//   · 调用方用 op_status(opId) 查真实结果，而不是「等 5–60 秒再猜」
//   · 只有 done/error 才是结论；pending 就是还在跑
//
// 【TTL】10 分钟。超过这个时间的 pending 标 stale（多半是 CDP 挂死，要重 attach）。
// ══════════════════════════════════════════════════════════════

const OP_TTL_MS = 10 * 60 * 1000;
const OP_MAX = 300;
const ops = new Map(); // opId -> { opId, action, status, t0, t1, result, error, code }

function opBegin(opId, action) {
  const rec = {
    opId, action, status: "pending",
    t0: Date.now(), t1: 0,
    result: null, error: null, code: null,
  };
  ops.set(opId, rec);
  if (ops.size > OP_MAX) {
    // 先清已终态的旧记录，再清过期的
    for (const [k, v] of ops) {
      if (v.status !== "pending") { ops.delete(k); if (ops.size <= OP_MAX) break; }
    }
    if (ops.size > OP_MAX) {
      for (const [k, v] of ops) {
        if (Date.now() - v.t0 > OP_TTL_MS) ops.delete(k);
        if (ops.size <= OP_MAX) break;
      }
    }
  }
  return rec;
}

function opFinish(opId, ok, payload) {
  const rec = ops.get(opId);
  if (!rec) return;
  rec.status = ok ? "done" : "error";
  rec.t1 = Date.now();
  if (ok) rec.result = payload;
  else { rec.error = errText(payload); rec.code = payload?.code || "E_ACTION"; }
}

function opQuery(opId) {
  const rec = ops.get(opId);
  if (!rec) {
    return { found: false, opId, hint: "无此 opId（可能已超出 10 分钟 TTL，或 server 未下发 opId）" };
  }
  const ageMs = Date.now() - rec.t0;
  let status = rec.status;
  // pending 但超过 TTL → stale（多半 CDP 挂死，不会再有回包）
  if (status === "pending" && ageMs > OP_TTL_MS) status = "stale";
  return {
    found: true,
    opId: rec.opId,
    action: rec.action,
    status,
    ageMs,
    durationMs: rec.t1 ? rec.t1 - rec.t0 : null,
    result: rec.result,
    error: rec.error,
    code: rec.code,
  };
}

/** 统一错误文本（Error / 字符串 / 对象 都能拿到人话） */
function errText(e) {
  if (!e) return "unknown error";
  if (typeof e === "string") return e;
  if (e.message) return e.message;
  try { return JSON.stringify(e); } catch { return String(e); }
}

/** 带错误码的失败 —— 让调用方能判断"该重试 / 该改参数 / 该重连" */
function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function handleCommand(msg) {
  const { id, action, payload } = msg || {};
  if (!id) return;

  // ⭐ op_status 自身不进 ops（否则查状态也会产生新状态，递归）
  if (action === "op_status") {
    try {
      sendWs({ id, ok: true, result: opQuery(payload?.opId) });
    } catch (e) {
      sendWs({ id, ok: false, error: errText(e), code: "E_STATUS" });
    }
    return;
  }

  // ⭐ 新增：ops_list（诊断用，看最近动作的终态分布）
  if (action === "ops_list") {
    const list = Array.from(ops.values())
      .sort((a, b) => b.t0 - a.t0)
      .slice(0, payload?.limit || 30)
      .map((r) => ({
        opId: r.opId, action: r.action, status: r.status,
        ageMs: Date.now() - r.t0, durationMs: r.t1 ? r.t1 - r.t0 : null, code: r.code,
      }));
    sendWs({ id, ok: true, result: { count: ops.size, list } });
    return;
  }

  const opId = msg.opId || null;
  if (opId) opBegin(opId, action);

  try {
    const result = await dispatch(action, payload);
    if (opId) opFinish(opId, true, result);
    sendWs({ id, opId, ok: true, result });
  } catch (e) {
    if (opId) opFinish(opId, false, e);
    sendWs({
      id, opId, ok: false,
      error: errText(e),
      code: (e && e.code) || "E_ACTION",
      // ⭐ 结构化错误上下文：让调用方能精确决策，而不是从中文消息里 regex 抠
      ...(e && e.retryAfterMs != null ? { retryAfterMs: e.retryAfterMs } : {}),
      ...(e && e.retryAfterSec != null ? { retryAfterSec: e.retryAfterSec } : {}),
      ...(e && e.rateWindowSec != null ? { rateWindowSec: e.rateWindowSec } : {}),
      ...(e && e.limit != null ? { current: e.current, limit: e.limit, host: e.host } : {}),
      ...(e && e.matchedPattern ? { matchedPattern: e.matchedPattern } : {}),
      ...(e && e.hint ? { hint: e.hint } : {}),
    });
  }
}

async function dispatch(action, payload = {}) {
  currentAction = action;
  currentPayload = payload || {};
  switch (action) {
    // ---- 元信息 ----
    case "status":
      return {
        connected,
        attachedTabId,
        version: PROTOCOL_VERSION,
        media: {
          enabled: mediaSniffEnabled,
          tabs: mediaByTab.size,
          pendingOps: Array.from(ops.values()).filter((r) => r.status === "pending").length,
        },
      };

    // ⭐ 媒体嗅探：列出某标签页已观察到的媒体资源
    //   payload.tabId 不传 → 用当前 attach 的 tab；都没有 → 报错（不瞎猜）
    case "media_list": {
      let tabId = payload?.tabId;
      if (tabId == null) tabId = attachedTabId;
      // ⭐ 兜底：没 attach 过就用当前激活页（媒体嗅探天然是"看眼前这页"）
      if (tabId == null) {
        const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
        tabId = active?.id ?? null;
      }
      if (tabId == null) throw fail("E_NO_TAB", "没有可用的标签页：请传 tabId，或先 tab_attach / 切到一个普通网页");
      const m = mediaByTab.get(tabId);
      const items = m ? Array.from(m.values()) : [];
      const limit = payload?.limit || 100;
      const sorted = sortMedia(items).slice(0, limit);
      return {
        tabId,
        count: items.length,
        returned: sorted.length,
        enabled: mediaSniffEnabled,
        items: sorted,
        hint: items.length === 0
          ? "没嗅到媒体：① 确认已开启嗅探 ② 重新播放一次视频（嗅探是「看请求」，不回溯历史）③ 有些站用 blob:，需要 server 端 media_grab 直接抓 m3u8"
          : null,
      };
    }

    case "media_clear": {
      if (payload?.all) { mediaByTab.clear(); return { ok: true, cleared: "all" }; }
      const tabId = payload?.tabId ?? attachedTabId;
      if (tabId == null) throw fail("E_NO_TAB", "没有可用的标签页");
      const had = mediaByTab.get(tabId)?.size || 0;
      mediaByTab.delete(tabId);
      return { ok: true, tabId, cleared: had };
    }

    case "media_config": {
      if (payload && typeof payload.enabled === "boolean") mediaSniffEnabled = payload.enabled;
      return { ok: true, enabled: mediaSniffEnabled };
    }

    // ⭐ 守卫配置（读 / 写）
    case "guard_config": {
      if (payload && Object.keys(payload).length) {
        if (typeof payload.unlockSensitive === "boolean") {
          setSensitiveUnlock(payload.unlockSensitive);
          const { unlockSensitive, ...rest } = payload;
          if (Object.keys(rest).length) await saveGuardConfig(rest);
        } else {
          await saveGuardConfig(payload);
        }
      }
      return { ok: true, config: getGuardConfig(), sensitiveUnlocked: getGuardStats().sensitiveUnlocked };
    }

    // ⭐ 守卫统计（只读诊断）
    case "guard_stats":
      return getGuardStats();

    case "tabs_list": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({
        id: t.id,
        title: t.title,
        url: t.url,
        active: t.active,
        windowId: t.windowId,
      }));
    }

    case "tab_attach": {
      let tabId = payload.tabId;
      if (tabId == null) {
        const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!active) throw new Error("no active tab");
        tabId = active.id;
      }
      await attachToTab(tabId);
      return { attachedTabId, url: (await chrome.tabs.get(tabId)).url };
    }

    case "tab_detach":
      await detachCurrent();
      return { ok: true };

    case "tab_get": {
      const tabId = await requireTab(payload.tabId);
      const tab = await chrome.tabs.get(tabId);
      return { id: tab.id, url: tab.url, title: tab.title, active: tab.active };
    }

    case "tab_select": {
      const tabId = await requireTab(payload.tabId);
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, { active: true });
      // ⭐ v1.5：同时把窗口提到前台。
      //    2026-10-17 实测：窗口最小化时 innerWidth/innerHeight = 0，
      //    所有元素坐标失效、click 必然报"视口外"—— 只切标签页不够。
      let windowFocused = false;
      if (tab.windowId != null) {
        try { await chrome.windows.update(tab.windowId, { focused: true }); windowFocused = true; } catch (_) {}
      }
      return { ok: true, tabId, windowId: tab.windowId, windowFocused };
    }

    // ⭐ 新建标签页（2026-10-12 加）
    // 关键价值：chrome.tabs.create **不触发 beforeunload 弹窗**，
    // 因此在遇到「离开此网站？」阻塞旧页时，用「新建 + 关旧」来脱困。
    case "tab_create": {
      const t = await chrome.tabs.create({
        url: payload.url || "about:blank",
        active: payload.active !== false,
      });
      if (payload.waitMs) await sleep(payload.waitMs);
      return { ok: true, tabId: t.id, url: t.url || payload.url };
    }

    // ⭐ 关闭标签页（2026-10-12 加）
    // ⚠️ chrome.tabs.remove 不弹 beforeunload（Chrome 对扩展的既定行为），
    //    所以「关旧页」不会卡住。若被 debugger attach，先 detach。
    case "tab_close": {
      const tabId = await requireTab(payload.tabId);
      if (attachedTabId === tabId) {
        try { await chrome.debugger.detach({ tabId }); } catch (_) {}
        attachedTabId = null;
      }
      await chrome.tabs.remove(tabId);
      await broadcast();
      return { ok: true, closed: tabId };
    }

    // ⭐ 原生对话框自动应答开关（2026-10-12 加）
    case "dialog_policy": {
      if (payload && typeof payload.autoDismiss === "boolean") {
        autoDismissDialogs = payload.autoDismiss;
      }
      // 附带主动清理：若当前正卡着弹窗，尝试应答一次
      let cleared = false;
      if (payload && payload.clearNow && attachedTabId != null) {
        try {
          await chrome.debugger.sendCommand(
            { tabId: attachedTabId },
            "Page.handleJavaScriptDialog",
            { accept: true }
          );
          cleared = true;
        } catch (_) {}
      }
      return { ok: true, autoDismissDialogs, cleared };
    }

    // ---- 导航 ----
    case "navigate": {
      // ⚠️ 顺序很重要：导航只用 tabs API，**不需要 debugger**。
      // 之前先 attachToTab 会因当前页是 chrome:// 而抛错 → 导航根本执行不了。
      // 所以 navigate 不复用 requireTab（后者会拒绝 chrome:// 页）。

      // ⭐ 安全守卫：导航限速（比一般动作更严）
      const navHost = hostOfUrl(payload.url || "");
      const navGuard = await guardBefore("navigate", { host: navHost, kind: "nav", texts: [payload.url] });

      let tabId = payload.tabId;
      if (tabId == null) tabId = attachedTabId;
      if (tabId == null) {
        const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (active) {
          tabId = active.id;
        } else {
          // 没有任何标签页 → 新建一个
          const t = await chrome.tabs.create({ url: payload.url });
          await waitForLoad(t.id, payload.timeoutMs ?? 30000);
          return { ok: true, url: payload.url, tabId: t.id, created: true, _guard: navGuard._guard };
        }
      }

      await chrome.tabs.update(tabId, { url: payload.url });
      await waitForLoad(tabId, payload.timeoutMs ?? 30000);

      // 导航到 http(s) 后才 attach（若仍是内部页，attach 会失败，但不影响导航本身）
      let attachErr = null;
      try {
        const t = await chrome.tabs.get(tabId);
        if (/^https?:/.test(t.url || "")) {
          await attachToTab(tabId);
        } else {
          attachErr = `页面 ${t.url} 不是 http(s)，无法 attach`;
        }
      } catch (e) {
        attachErr = String(e && e.message ? e.message : e);
      }
      return { ok: true, url: payload.url, tabId, attached: !attachErr, attachError: attachErr, _guard: navGuard._guard };
    }

    case "go_back": {
      const tabId = await requireTab(payload.tabId);
      await chrome.tabs.goBack(tabId);
      await waitForLoad(tabId, payload.timeoutMs ?? 20000);
      return { ok: true };
    }

    case "go_forward": {
      const tabId = await requireTab(payload.tabId);
      await chrome.tabs.goForward(tabId);
      await waitForLoad(tabId, payload.timeoutMs ?? 20000);
      return { ok: true };
    }

    case "reload": {
      const tabId = await requireTab(payload.tabId);
      await chrome.tabs.reload(tabId);
      await waitForLoad(tabId, payload.timeoutMs ?? 20000);
      return { ok: true };
    }

    // ⭐ 远程热重载扩展自身（改完 background.js 不必让用户去 chrome://extensions 点）
    case "ext_reload": {
      setTimeout(() => { try { chrome.runtime.reload(); } catch (_) {} }, 300);
      return { ok: true, note: "扩展将在 300ms 后重载" };
    }

    // ---- 页面读取 ----
    case "eval": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      // ⚠️ 加超时保护：页面被冻结 / 表达式永不 resolve 时不能无限挂住
      const res = await Promise.race([
        chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
          expression: payload.expression,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
        }),
        new Promise((_r, rej) =>
          setTimeout(() => rej(new Error("eval 超时（页面可能被冻结或表达式永不返回）")), payload.timeoutMs ?? 15000)
        ),
      ]);
      if (res.exceptionDetails) {
        throw new Error(
          res.exceptionDetails.text ||
          (res.exceptionDetails.exception && res.exceptionDetails.exception.description) ||
          "eval failed"
        );
      }
      return { value: res.result && res.result.value };
    }

    case "page_text": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const res = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: "document.body ? document.body.innerText : ''",
        returnByValue: true,
      });
      let text = (res.result && res.result.value) || "";
      const max = payload.maxChars ?? 20000;
      if (text.length > max) text = text.slice(0, max) + "\n...[truncated]";
      return { text };
    }

    case "page_html": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const res = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: "document.documentElement.outerHTML",
        returnByValue: true,
      });
      let html = (res.result && res.result.value) || "";
      const max = payload.maxChars ?? 100000;
      if (html.length > max) html = html.slice(0, max) + "<!-- truncated -->";
      return { html };
    }

    case "dom_snapshot": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const script = buildSnapshotScript(payload.maxNodes ?? 400);
      const res = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: script,
        returnByValue: true,
      });
      return { nodes: (res.result && res.result.value) || [] };
    }

    // ---- 交互 ----
    case "click": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      return await doClick(tabId, payload);
    }

    case "click_at": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const host = await hostOfTab(tabId);
      await guardBefore("click_at", { host, kind: "action" });
      await mouseClickAt(tabId, payload.x, payload.y, payload.button ?? "left");
      return { ok: true };
    }

    case "type": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      return await doType(tabId, payload);
    }

    case "press_key": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const host = await hostOfTab(tabId);
      await guardBefore("press_key", { host, kind: "action", texts: [payload.key] });
      await pressKey(tabId, payload.key, payload.modifiers ?? 0);
      return { ok: true };
    }

    // ═══════════════ W2 · 交互完整性 ═══════════════

    // ⭐ 悬停（hover）
    // 触发 CSS :hover 菜单、tooltip、下拉列表——很多站点的导航必须先悬停。
    case "hover": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const host = await hostOfTab(tabId);
      const guard = await guardBefore("hover", { host, kind: "action", texts: [payload.selector, payload.text, payload.ref] });
      const resolved = await resolveElement(tabId, { selector: payload.selector, text: payload.text, ref: payload.ref });
      if (!resolved) throw new Error(`hover 目标未找到`);
      await mouseMoveTo(tabId, resolved.x, resolved.y);
      // 悬停后停留一会儿，让 :hover 的 CSS/JS 有时间生效
      await sleep(gaussianLocal(payload.holdMs ?? 300, (payload.holdMs ?? 300) + 250));
      return { ok: true, x: resolved.x, y: resolved.y, _guard: guard._guard };
    }

    // ⭐ 拖拽（drag）
    // 从元素 A 拖到元素 B（或坐标）。用于滑块、拖拽排序、地图平移。
    case "drag": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const host = await hostOfTab(tabId);
      const guard = await guardBefore("drag", { host, kind: "action", texts: [payload.fromSelector, payload.toSelector] });

      const from = await resolveElement(tabId, {
        selector: payload.fromSelector, text: payload.fromText, ref: payload.fromRef,
      });
      if (!from) throw new Error("drag 起点未找到");

      let to;
      if (payload.toX != null && payload.toY != null) {
        to = { x: payload.toX, y: payload.toY };
      } else {
        to = await resolveElement(tabId, {
          selector: payload.toSelector, text: payload.toText, ref: payload.toRef,
        });
        if (!to) throw new Error("drag 终点未找到");
      }

      // 按下 → 沿贝塞尔移动（drag 事件需要中间态）→ 抬起
      await mouseMoveTo(tabId, from.x, from.y);
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1,
      });
      const pts = bezierPath(from.x, from.y, to.x, to.y, gaussianLocal(12, 24));
      for (const p of pts) {
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
          type: "mouseMoved", x: p.x, y: p.y, button: "left", buttons: 1,
        });
        await sleep(gaussianLocal(10, 28));
      }
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1,
      });
      lastMouse = { x: to.x, y: to.y };
      return { ok: true, from, to, _guard: guard._guard };
    }

    // ⭐ 下拉选择（<select>）
    case "select_option": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const host = await hostOfTab(tabId);
      const guard = await guardBefore("select_option", { host, kind: "action", texts: [payload.selector, payload.value, payload.label] });

      const sel = JSON.stringify(payload.selector);
      const wantVal = payload.value != null ? JSON.stringify(String(payload.value)) : null;
      const wantLabel = payload.label != null ? JSON.stringify(String(payload.label)) : null;

      const fn = `(function(){
        var s = document.querySelector(${sel});
        if (!s || s.tagName !== 'SELECT') return { ok:false, reason:'not a select' };
        var opts = Array.from(s.options);
        var target = null;
        ${wantVal ? `target = opts.find(o => o.value === ${wantVal});` : ""}
        ${wantLabel ? `if (!target) target = opts.find(o => (o.textContent||'').trim() === ${wantLabel});` : ""}
        if (!target) return { ok:false, reason:'option not found', options: opts.map(o=>o.value+':'+o.textContent.trim()).slice(0,20) };
        var setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
        if (setter && setter.set) setter.set.call(s, target.value); else s.value = target.value;
        s.dispatchEvent(new Event('input', { bubbles: true }));
        s.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok:true, value: s.value, label: target.textContent.trim() };
      })()`;
      const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: fn, returnByValue: true });
      const v = r.result && r.result.value;
      if (!v || !v.ok) throw new Error(`select_option 失败：${v ? v.reason : "unknown"}`);
      return { ...v, _guard: guard._guard };
    }

    // ⭐ 逐字输入（逐字符发送键盘事件）
    case "type_human": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      return await doTypeHuman(tabId, payload);
    }

    // ⭐ 滚动到元素（而非盲滚）
    case "scroll_into_view": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const resolved = await resolveElement(tabId, { selector: payload.selector, text: payload.text, ref: payload.ref });
      if (!resolved) throw new Error("scroll_into_view 目标未找到");
      return { ok: true, x: resolved.x, y: resolved.y };
    }

    // ⭐ 滚动到底 / 滚动加载更多
    // 用于"无限滚动"列表：反复滚到底直到没有新内容。
    case "scroll_to_bottom": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const host = await hostOfTab(tabId);
      await guardBefore("scroll_to_bottom", { host, kind: "action" });

      const maxRounds = payload.maxRounds ?? 10;
      const settleMs = payload.settleMs ?? 800;
      let rounds = 0, lastHeight = 0, stableTimes = 0;

      for (let i = 0; i < maxRounds; i++) {
        const before = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
          expression: "document.documentElement.scrollHeight",
          returnByValue: true,
        });
        const h = before.result && before.result.value;

        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
          type: "mouseWheel", x: payload.x ?? 500, y: payload.y ?? 400, deltaX: 0, deltaY: 2000,
        });
        await sleep(settleMs);
        rounds++;

        const after = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
          expression: "document.documentElement.scrollHeight",
          returnByValue: true,
        });
        const h2 = after.result && after.result.value;

        if (h2 === h && h2 === lastHeight) {
          stableTimes++;
          if (stableTimes >= 2) break; // 连续两轮高度不变 → 到底了
        } else {
          stableTimes = 0;
        }
        lastHeight = h2;
      }
      return { ok: true, rounds, finalHeight: lastHeight };
    }

    // ═══════════════ W3 · 等待条件族 ═══════════════

    case "wait_for_text": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const ok = await waitForCondition(
        tabId,
        `(document.body && document.body.innerText || '').includes(${JSON.stringify(payload.text)})`,
        payload.timeoutMs ?? 15000, payload.intervalMs ?? 250
      );
      return { ok, text: payload.text };
    }

    case "wait_for_url": {
      const tabId = await requireTab(payload.tabId);
      const ok = await waitForCondition(
        tabId,
        payload.regex
          ? `new RegExp(${JSON.stringify(payload.regex)}).test(location.href)`
          : `location.href.includes(${JSON.stringify(payload.contains || "")})`,
        payload.timeoutMs ?? 15000, payload.intervalMs ?? 200, /* needAttach */ false
      );
      return { ok, url: payload.contains || payload.regex };
    }

    case "wait_for_function": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const ok = await waitForCondition(tabId, payload.expression, payload.timeoutMs ?? 15000, payload.intervalMs ?? 250);
      return { ok, expression: payload.expression };
    }

    // ⭐ wait_for_load：等 readyState 达到目标（比 waitForLoad 更可控）
    case "wait_for_load": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const want = payload.state ?? "complete"; // interactive | complete
      const ok = await waitForCondition(
        tabId,
        `(function(){ var s = document.readyState; return ${JSON.stringify(want)} === 'interactive' ? (s === 'interactive' || s === 'complete') : s === 'complete'; })()`,
        payload.timeoutMs ?? 20000, 200
      );
      return { ok, state: want };
    }

    // ⭐ 等待元素消失（常用于等 loading 遮罩消失）
    case "wait_for_selector_gone": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const ok = await waitForCondition(
        tabId,
        `!document.querySelector(${JSON.stringify(payload.selector)})`,
        payload.timeoutMs ?? 15000, 250
      );
      return { ok, selector: payload.selector };
    }

    // ═══════════════ W4 · 存储与网络（只读优先） ═══════════════

    // ⭐ 读 cookies
    case "get_cookies": {
      const tabId = await requireTab(payload.tabId);
      const t = await chrome.tabs.get(tabId);
      const cookies = await chrome.cookies.getAll({ url: payload.url || t.url });
      return {
        ok: true,
        count: cookies.length,
        cookies: cookies.map((c) => ({
          name: c.name, value: payload.includeValues ? c.value : "***",
          domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly,
          sameSite: c.sameSite, expirationDate: c.expirationDate,
        })),
      };
    }

    /**
     * ⭐ 写 cookie —— 属于「改变站点状态」的动作，默认需显式解锁。
     * 用途：切换实验分组、恢复登录态（如迁移环境）。
     */
    case "set_cookie": {
      const tabId = await requireTab(payload.tabId).catch(() => null);
      const t = tabId ? await chrome.tabs.get(tabId) : null;
      const host = t ? hostOfUrl(t.url) : "unknown";
      await guardBefore("set_cookie", { host, kind: "action", texts: [payload.name] });
      const res = await chrome.cookies.set({
        url: payload.url,
        name: payload.name,
        value: payload.value,
        domain: payload.domain,
        path: payload.path ?? "/",
        secure: payload.secure,
        httpOnly: payload.httpOnly,
        sameSite: payload.sameSite,
        expirationDate: payload.expirationDate,
      });
      return { ok: true, cookie: res ? { name: res.name, domain: res.domain } : null };
    }

    case "delete_cookie": {
      const tabId = await requireTab(payload.tabId).catch(() => null);
      const t = tabId ? await chrome.tabs.get(tabId) : null;
      const host = t ? hostOfUrl(t.url) : "unknown";
      await guardBefore("delete_cookie", { host, kind: "action", texts: [payload.name] });
      await chrome.cookies.remove({ url: payload.url, name: payload.name });
      return { ok: true };
    }

    // ⭐ 读 localStorage / sessionStorage
    case "storage_get": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const which = payload.area === "session" ? "sessionStorage" : "localStorage";
      const fn = `(function(){
        var s = ${which};
        ${payload.key ? `var v = s.getItem(${JSON.stringify(payload.key)}); return { key: ${JSON.stringify(payload.key)}, value: v };` : ""}
        var out = {}; for (var i=0;i<s.length;i++){ var k=s.key(i); out[k]=s.getItem(k); }
        return { count: s.length, data: out };
      })()`;
      const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: fn, returnByValue: true });
      return { ok: true, area: which, ...(r.result && r.result.value || {}) };
    }

    // ⭐ 写 storage（改变站点状态，需显式解锁）
    case "storage_set": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const host = await hostOfTab(tabId);
      await guardBefore("storage_set", { host, kind: "action", texts: [payload.key] });
      const which = payload.area === "session" ? "sessionStorage" : "localStorage";
      const fn = `(function(){
        try { ${which}.setItem(${JSON.stringify(payload.key)}, ${JSON.stringify(String(payload.value))}); return { ok:true, value: ${which}.getItem(${JSON.stringify(payload.key)}) }; }
        catch(e){ return { ok:false, reason: String(e) }; }
      })()`;
      const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: fn, returnByValue: true });
      return { ok: true, ...(r.result && r.result.value || {}) };
    }

    case "storage_remove": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const host = await hostOfTab(tabId);
      await guardBefore("storage_remove", { host, kind: "action", texts: [payload.key] });
      const which = payload.area === "session" ? "sessionStorage" : "localStorage";
      const fn = `(function(){ ${which}.removeItem(${JSON.stringify(payload.key)}); return { ok:true }; })()`;
      const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: fn, returnByValue: true });
      return { ok: true, ...(r.result && r.result.value || {}) };
    }

    /**
     * ⭐ 抓控制台日志。
     * 方式：注入一段脚本 hook console.*，把日志存到 window.__xyLogs。
     * ⚠️ 只能抓「注入之后」产生的日志（历史日志无法回溯）。
     */
    case "console_start": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const hook = `(function(){
        if (window.__xyLogsHooked) return { already: true };
        window.__xyLogs = window.__xyLogs || [];
        var LEVELS = ['log','info','warn','error','debug'];
        LEVELS.forEach(function(lv){
          var orig = console[lv];
          console[lv] = function(){
            try {
              var args = Array.prototype.slice.call(arguments).map(function(a){
                try { return typeof a === 'object' ? JSON.stringify(a) : String(a); } catch(e){ return String(a); }
              });
              window.__xyLogs.push({ t: Date.now(), level: lv, args: args });
              if (window.__xyLogs.length > 500) window.__xyLogs.shift();
            } catch(e){}
            return orig.apply(console, arguments);
          };
        });
        window.addEventListener('error', function(e){
          window.__xyLogs.push({ t: Date.now(), level: 'uncaught', args: [String(e.message)] });
        });
        window.addEventListener('unhandledrejection', function(e){
          window.__xyLogs.push({ t: Date.now(), level: 'unhandledrejection', args: [String(e.reason)] });
        });
        window.__xyLogsHooked = true;
        return { hooked: true };
      })()`;
      const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: hook, returnByValue: true });
      return { ok: true, ...(r.result && r.result.value || {}) };
    }

    case "console_logs": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const fn = `(function(){
        var logs = window.__xyLogs || [];
        var level = ${JSON.stringify(payload.level || null)};
        if (level) logs = logs.filter(function(l){ return l.level === level; });
        return { count: logs.length, logs: logs.slice(${-(payload.limit ?? 100)}) };
      })()`;
      const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: fn, returnByValue: true });
      return { ok: true, ...(r.result && r.result.value || {}) };
    }

    case "console_clear": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: "window.__xyLogs = []", returnByValue: true });
      return { ok: true };
    }

    /**
     * ⭐ 抓网络请求（只读）。
     * 用 CDP Network domain 的事件流 —— 但扩展的 chrome.debugger.onEvent
     * 是全局监听，这里改为「按需开启 + 缓冲到内存」的模式。
     */
    case "network_start": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      networkCapture[tabId] = { on: true, reqs: [], startedAt: Date.now() };
      try { await chrome.debugger.sendCommand({ tabId }, "Network.enable"); } catch (_) {}
      return { ok: true, note: "已开始抓取网络请求（最多缓存 800 条）" };
    }

    case "network_log": {
      const tabId = await requireTab(payload.tabId);
      const buf = networkCapture[tabId];
      if (!buf) return { ok: true, count: 0, requests: [], note: "未开启抓取，请先 network_start" };
      let reqs = buf.reqs;
      if (payload.filter) {
        try { const re = new RegExp(payload.filter); reqs = reqs.filter((r) => re.test(r.url)); } catch (_) {}
      }
      const limit = payload.limit ?? 100;
      return { ok: true, count: reqs.length, requests: reqs.slice(-limit) };
    }

    case "network_clear": {
      const tabId = await requireTab(payload.tabId);
      if (networkCapture[tabId]) networkCapture[tabId].reqs = [];
      return { ok: true };
    }

    case "network_stop": {
      const tabId = await requireTab(payload.tabId);
      const n = networkCapture[tabId] ? networkCapture[tabId].reqs.length : 0;
      delete networkCapture[tabId];
      try { await chrome.debugger.sendCommand({ tabId }, "Network.disable"); } catch (_) {}
      return { ok: true, captured: n };
    }

    // ═══════════════ W5 · 文件下载与批量编排 ═══════════════

    /**
     * ⭐ 下载文件。
     * 两条路：
     *   ① 若给的是 <a download> 或直链 → 用 chrome.downloads.download（推荐，简单可靠）
     *   ② 若是页面内触发（点按钮弹出下载）→ 用 Page.setDownloadBehavior 指定目录
     */
    case "download_file": {
      const tabId = await requireTab(payload.tabId).catch(() => null);
      const host = tabId ? await hostOfTab(tabId) : "unknown";
      await guardBefore("download_file", { host, kind: "action", texts: [payload.url, payload.filename] });

      if (payload.url) {
        // 方式①：直链下载
        const id = await chrome.downloads.download({
          url: payload.url,
          filename: payload.filename || undefined,
          saveAs: false,
        });
        return { ok: true, downloadId: id, mode: "direct" };
      }

      if (tabId != null && payload.dir) {
        // 方式②：设置该标签页的下载目录（配合页面内点击触发下载）
        try {
          await chrome.debugger.sendCommand({ tabId }, "Page.setDownloadBehavior", {
            behavior: "allow",
            downloadPath: payload.dir,
          });
          return { ok: true, mode: "behavior", dir: payload.dir };
        } catch (e) {
          // 回退到 Browser domain（较新 Chrome）
          await chrome.debugger.sendCommand({ tabId }, "Browser.setDownloadBehavior", {
            behavior: "allow", downloadPath: payload.dir,
          });
          return { ok: true, mode: "browser-behavior", dir: payload.dir };
        }
      }
      throw new Error("download_file 需要 url（直链）或 dir（页面内下载目录）");
    }

    /** ⭐ 列出已下载的文件（查结果） */
    case "download_list": {
      const items = await chrome.downloads.search({
        limit: payload.limit ?? 20,
        orderBy: ["-startTime"],
      });
      return {
        ok: true,
        count: items.length,
        items: items.map((d) => ({
          id: d.id, filename: d.filename, url: d.url,
          state: d.state, bytesReceived: d.bytesReceived,
          totalBytes: d.totalBytes, error: d.error,
        })),
      };
    }

    /**
     * ⭐ 批量标签页操作。
     * 支持：open（批量开）/ close（批量关）/ close_others / close_by_url
     */
    case "tabs_batch": {
      const op = payload.op;
      if (op === "open") {
        const urls = payload.urls || [];
        const host = hostOfUrl(urls[0] || "");
        await guardBefore("tabs_batch", { host, kind: "nav", texts: urls });
        const out = [];
        for (const u of urls) {
          const t = await chrome.tabs.create({ url: u, active: false });
          out.push({ tabId: t.id, url: u });
          await sleep(gaussianLocal(300, 900)); // 批量开页也要有节奏
        }
        return { ok: true, opened: out.length, tabs: out };
      }
      if (op === "close") {
        const ids = payload.tabIds || [];
        for (const id of ids) {
          if (attachedTabId === id) { try { await chrome.debugger.detach({ tabId: id }); } catch (_) {} attachedTabId = null; }
          try { await chrome.tabs.remove(id); } catch (_) {}
        }
        await broadcast();
        return { ok: true, closed: ids.length };
      }
      if (op === "close_by_url") {
        let re; try { re = new RegExp(payload.pattern); } catch { throw new Error("pattern 无效"); }
        const all = await chrome.tabs.query({});
        const victims = all.filter((t) => re.test(t.url || "")).map((t) => t.id);
        for (const id of victims) {
          if (attachedTabId === id) { try { await chrome.debugger.detach({ tabId: id }); } catch (_) {} attachedTabId = null; }
          try { await chrome.tabs.remove(id); } catch (_) {}
        }
        await broadcast();
        return { ok: true, closed: victims.length, tabIds: victims };
      }
      if (op === "close_others") {
        const keep = payload.tabId ?? attachedTabId;
        const all = await chrome.tabs.query({});
        const victims = all.filter((t) => t.id !== keep).map((t) => t.id);
        for (const id of victims) {
          if (attachedTabId === id) { try { await chrome.debugger.detach({ tabId: id }); } catch (_) {} attachedTabId = null; }
          try { await chrome.tabs.remove(id); } catch (_) {}
        }
        await broadcast();
        return { ok: true, kept: keep, closed: victims.length };
      }
      throw new Error(`tabs_batch 不支持 op=${op}（支持 open/close/close_by_url/close_others）`);
    }

    /** ⭐ 一次发多条 CDP 命令（减少往返） */
    case "cdp_batch": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const cmds = payload.commands || [];
      const results = [];
      for (const c of cmds) {
        try {
          const r = await chrome.debugger.sendCommand({ tabId }, c.method, c.params ?? {});
          results.push({ method: c.method, ok: true, result: r });
        } catch (e) {
          results.push({ method: c.method, ok: false, error: String(e && e.message ? e.message : e) });
        }
      }
      return { ok: true, count: results.length, results };
    }

    /** ⭐ 元素批量提取：一次拿多个元素的文本/属性（比多次 eval 高效） */
    case "extract": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const list = payload.items || [];
      const results = [];
      for (const it of list) {
        try {
          const sel = JSON.stringify(it.selector);
          const attr = it.attr ? JSON.stringify(it.attr) : null;
          const fn = it.multiple
            ? `Array.from(document.querySelectorAll(${sel})).map(function(e){ return ${attr ? `e.getAttribute(${attr})` : "(e.innerText||e.textContent||'').trim()"}; }).slice(0, ${it.limit ?? 100})`
            : `(function(){ var e = document.querySelector(${sel}); return e ? ${attr ? `e.getAttribute(${attr})` : "(e.innerText||e.textContent||'').trim()"} : null; })()`;
          const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: fn, returnByValue: true });
          results.push({ key: it.key || it.selector, value: r.result && r.result.value });
        } catch (e) {
          results.push({ key: it.key || it.selector, error: String(e && e.message ? e.message : e) });
        }
      }
      return { ok: true, count: results.length, results };
    }

    case "scroll": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const host = await hostOfTab(tabId);
      await guardBefore("scroll", { host, kind: "action" });
      await doScroll(tabId, payload);
      return { ok: true };
    }

    case "upload_file": {
      // 通过 CDP setFileInputFiles 设置文件（但不弹系统对话框）
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const host = await hostOfTab(tabId);
      await guardBefore("upload_file", { host, kind: "action", texts: [payload.selector, ...(payload.files || [])] });
      const nodeId = await resolveNodeId(tabId, payload.selector);
      const res = await chrome.debugger.sendCommand({ tabId }, "DOM.setFileInputFiles", {
        files: payload.files,
        nodeId,
      }).catch(async () => {
        // 退回 objectId 方式
        const obj = await resolveObjectId(tabId, payload.selector);
        return await chrome.debugger.sendCommand({ tabId }, "DOM.setFileInputFiles", {
          files: payload.files,
          objectId: obj,
        });
      });
      return { ok: true, result: res };
    }

    case "wait": {
      await sleep(payload.ms ?? 1000);
      return { ok: true };
    }

    case "wait_for_selector": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const ok = await waitForSelector(tabId, payload.selector, payload.timeoutMs ?? 15000);
      return { ok, selector: payload.selector };
    }

    // ══════════════════════════════════════════════════════════
    //  ⭐ v1.4 新增：观察与诊断族（集成自 BrowserMCP）
    //
    //  这些工具的定位是"让 Agent 看得更清楚"——不产生副作用，
    //  因此**不过守卫**（只读不计数、不限速）。
    // ══════════════════════════════════════════════════════════

    // 元素高亮闪烁：操作前先"指出"要动哪个元素
    //   集成自 BrowserMCP 的 highlight_element。
    //   对 Agent 自检极有用——点击前后各高亮一次，肉眼确认没点歪。
    case "highlight_element": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const r = await resolveElement(tabId, { selector: payload.selector, text: payload.text, ref: payload.ref });
      if (!r) throw new Error(`元素未找到：${payload.selector ?? payload.text ?? payload.ref}`);
      const duration = payload.durationMs ?? 1200;
      const color = JSON.stringify(payload.color ?? "#ff3b30");
      const fn = `(function(){
        var el = window.__xyBridgeEl;
        if (!el) return false;
        var old = el.style.outline, oldOff = el.style.outlineOffset, oldPos = el.style.position, oldZ = el.style.zIndex;
        el.style.outline = '3px solid ' + ${color};
        el.style.outlineOffset = '2px';
        try { el.style.position = el.style.position || 'relative'; el.style.zIndex = '2147483646'; } catch(_){}
        setTimeout(function(){
          el.style.outline = old; el.style.outlineOffset = oldOff;
          el.style.position = oldPos; el.style.zIndex = oldZ;
        }, ${duration});
        return true;
      })()`;
      await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: fn, returnByValue: true });
      return { ok: true, x: r.x, y: r.y, durationMs: duration };
    }

    // 注入 CSS：临时改页面样式（如扩大点击区域、隐藏遮挡层、强制显示隐藏元素）
    case "inject_css": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const cssId = payload.id || "__xyBridgeInjected";
      const css = JSON.stringify(payload.css || "");
      const fn = `(function(){
        var id = ${JSON.stringify(cssId)};
        var old = document.getElementById(id);
        if (old) old.remove();
        var s = document.createElement('style');
        s.id = id; s.textContent = ${css};
        (document.head || document.documentElement).appendChild(s);
        return s.textContent.length;
      })()`;
      const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: fn, returnByValue: true });
      return { ok: true, id: cssId, bytes: r.result && r.result.value };
    }

    case "remove_injected_css": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const id = JSON.stringify(payload.id || "__xyBridgeInjected");
      const fn = `(function(){ var e = document.getElementById(${id}); if (e) { e.remove(); return true; } return false; })()`;
      const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: fn, returnByValue: true });
      return { ok: true, removed: !!(r.result && r.result.value) };
    }

    // 读取用户当前选中的文字
    case "get_selected_text": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const fn = `(function(){
        var sel = window.getSelection ? String(window.getSelection()) : '';
        var a = document.activeElement;
        if (!sel && a && a.value !== undefined && a.selectionStart != null && a.selectionEnd != null) {
          sel = a.value.slice(a.selectionStart, a.selectionEnd);
        }
        return sel;
      })()`;
      const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: fn, returnByValue: true });
      return { ok: true, text: (r.result && r.result.value) || "" };
    }

    // 页面所有图片（含 src / alt / 尺寸 / 是否可见）
    case "get_images": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const fn = `(function(){
        return Array.from(document.images).map(function(im){
          var r = im.getBoundingClientRect();
          return { src: im.currentSrc || im.src, alt: im.alt || '', w: Math.round(r.width), h: Math.round(r.height),
                   naturalW: im.naturalWidth, naturalH: im.naturalHeight, visible: r.width > 0 && r.height > 0 };
        }).filter(function(x){ return ${payload.includeHidden ? "true" : "x.visible"}; }).slice(0, ${payload.limit ?? 200});
      })()`;
      const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: fn, returnByValue: true });
      return { ok: true, images: (r.result && r.result.value) || [] };
    }

    // 页面 meta 标签（title/description/og:*）——SEO、分享卡片、内容摘要
    case "get_meta_tags": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const fn = `(function(){
        var out = { title: document.title, url: location.href,
                    description: '', canonical: '', lang: document.documentElement.lang || '' };
        Array.from(document.querySelectorAll('meta')).forEach(function(m){
          var n = (m.getAttribute('name') || m.getAttribute('property') || '').toLowerCase();
          var c = m.getAttribute('content') || '';
          if (n === 'description') out.description = c;
          else if (n && (n.indexOf('og:') === 0 || n.indexOf('twitter:') === 0)) out[n] = c;
        });
        var link = document.querySelector('link[rel="canonical"]');
        if (link) out.canonical = link.href;
        return out;
      })()`;
      const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: fn, returnByValue: true });
      return { ok: true, meta: (r.result && r.result.value) || {} };
    }

    // 页面所有表单及其字段——填表前先看清单，避免盲填
    case "get_forms": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const fn = `(function(){
        return Array.from(document.forms).map(function(f, fi){
          var fields = Array.from(f.querySelectorAll('input,textarea,select')).map(function(el){
            return { name: el.name || '', id: el.id || '', type: el.type || el.tagName.toLowerCase(),
                     placeholder: el.placeholder || '', required: !!el.required,
                     value: (el.type === 'password' ? '***' : (el.value || '')).slice(0, 60) };
          });
          return { index: fi, name: f.name || '', id: f.id || '', action: f.action || '', method: (f.method || 'get').toUpperCase(), fields: fields };
        });
      })()`;
      const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: fn, returnByValue: true });
      return { ok: true, forms: (r.result && r.result.value) || [] };
    }

    // 页面尺寸与滚动位置
    case "get_page_dimensions": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const fn = `(function(){
        var d = document.documentElement, b = document.body || {};
        var sh = Math.max(d.scrollHeight, b.scrollHeight || 0);
        var sw = Math.max(d.scrollWidth, b.scrollWidth || 0);
        return { viewportW: innerWidth, viewportH: innerHeight,
                 scrollX: Math.round(scrollX), scrollY: Math.round(scrollY),
                 pageW: sw, pageH: sh,
                 scrollableX: sw > innerWidth, scrollableY: sh > innerHeight,
                 devicePixelRatio: devicePixelRatio || 1 };
      })()`;
      const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: fn, returnByValue: true });
      return { ok: true, dims: (r.result && r.result.value) || {} };
    }

    // 聚焦元素（不点击）
    case "focus": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const r = await resolveElement(tabId, { selector: payload.selector, text: payload.text, ref: payload.ref });
      if (!r) throw new Error(`元素未找到：${payload.selector ?? payload.text ?? payload.ref}`);
      const sel = JSON.stringify(payload.selector || null);
      const fn = `(function(){
        var el = window.__xyBridgeEl;
        if (!el) return false;
        if (el.focus) el.focus();
        return document.activeElement === el;
      })()`;
      const res = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: fn, returnByValue: true });
      return { ok: true, focused: !!(res.result && res.result.value) };
    }

    // 统计匹配元素数量（判断"有没有加载出来"的轻量手段）
    case "get_elements_count": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const sel = JSON.stringify(payload.selector);
      const fn = `document.querySelectorAll(${sel}).length`;
      const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: fn, returnByValue: true });
      return { ok: true, selector: payload.selector, count: (r.result && r.result.value) ?? 0 };
    }

    // 设置元素属性（调试用：强制启用禁用按钮、补 missing 属性）
    case "set_element_attribute": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const host = await hostOfTab(tabId);
      await guardBefore("set_element_attribute", { host, kind: "action", texts: [payload.selector, payload.name, payload.value] });
      const sel = JSON.stringify(payload.selector);
      const name = JSON.stringify(payload.name);
      const value = JSON.stringify(payload.value ?? "");
      const fn = `(function(){
        var el = document.querySelector(${sel});
        if (!el) return false;
        if (${value} === null || ${value} === '') el.removeAttribute(${name}); else el.setAttribute(${name}, ${value});
        return el.getAttribute(${name});
      })()`;
      const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: fn, returnByValue: true });
      return { ok: true, value: r.result && r.result.value };
    }

    // 语义化 DOM 快照（a11y 树裁剪版）—— 给 LLM 读的"页面摘要"
    //   ⭐ 自动快照：captureAriaSnapshot 会在每个动作后由 server 端附加
    case "extract_aria_snapshot": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const maxNodes = payload.maxNodes ?? 400;
      const fn = `(function(){
        var SEL = 'a[href],button,input,textarea,select,[role],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
        var out = []; var n = 0;
        var all = document.querySelectorAll(SEL);
        for (var i = 0; i < all.length && n < ${maxNodes}; i++) {
          var e = all[i];
          var r = e.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          var cs = getComputedStyle(e);
          if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
          if (Math.abs(r.left) > 8000 || Math.abs(r.top) > 8000) continue;
          var tag = e.tagName.toLowerCase();
          var role = e.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'input' ? (e.type || 'textbox') : tag);
          var name = (e.getAttribute('aria-label') || e.innerText || e.value || e.placeholder || e.title || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
          var node = { role: role, name: name, tag: tag, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
          if (e.id) node.id = e.id;
          if (e.name) node.elname = e.name;
          if (e.type) node.type = e.type;
          if (e.checked != null && (e.type === 'checkbox' || e.type === 'radio')) node.checked = !!e.checked;
          if (e.disabled) node.disabled = true;
          if (e.href) node.href = String(e.href).slice(0, 120);
          out.push(node); n++;
        }
        return { url: location.href, title: document.title, count: out.length, nodes: out };
      })()`;
      const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: fn, returnByValue: true });
      return { ok: true, snapshot: (r.result && r.result.value) || { nodes: [] } };
    }

    // 控制台错误收集（配合 console_start / console_logs 使用）
    case "console_errors": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const fn = `(function(){ return (window.__xyConsoleErrors || []).slice(-${payload.limit ?? 50}); })()`;
      const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: fn, returnByValue: true });
      return { ok: true, errors: (r.result && r.result.value) || [] };
    }

    // ⭐ 守卫自检：在真实扩展环境里验证拦截逻辑
    //   目的：证明"守卫真的在跑"，而不是配置写了没生效。
    case "guard_selftest": {
      const sample = (fn, n = 500) => {
        const a = [];
        for (let i = 0; i < n; i++) a.push(fn());
        a.sort((x, y) => x - y);
        return { min: a[0], p10: a[Math.floor(n * 0.1)], p50: a[Math.floor(n * 0.5)], p90: a[Math.floor(n * 0.9)], max: a[n - 1] };
      };
      const cfgNow = getGuardConfig();

      // 1) 分布采样
      const dist = {
        pacedDelay: sample(() => { const d = pacedDelay(); resetTempo(); return d; }),
        clickHold: sample(() => clickHoldMs()),
        hold: sample(() => keyRhythm().hold),
        flight: sample(() => keyRhythm().flight),
        mouseSteps: sample(() => mousePathConfig().steps),
        mouseStepDelay: sample(() => mousePathConfig().stepDelay),
      };

      // 2) 拦截逻辑验证（用守卫真实跑一遍，观察是否按预期拒绝）
      const probes = {};
      // 敏感动作：应被拦
      try {
        await guardBefore("click", { host: "selftest.local", kind: "action", texts: ["发布文章"] });
        probes.sensitiveBlock = "FAIL（敏感词未拦截）";
      } catch (e) { probes.sensitiveBlock = /敏感动作/.test(e.message) ? "OK" : "FAIL：" + e.message; }
      // 解锁后：应放行
      setSensitiveUnlock(true);
      try {
        await guardBefore("click", { host: "selftest.local", kind: "read", texts: ["发布文章"] });
        probes.sensitiveUnlock = "OK";
      } catch (e) { probes.sensitiveUnlock = "FAIL：" + e.message; }
      setSensitiveUnlock(false);
      // 夜间静默：强制开→应拦
      const oldQuiet = cfgNow.quietHoursEnabled;
      await saveGuardConfig({ quietHoursEnabled: true, quietStart: 0, quietEnd: 24 });
      try {
        await guardBefore("click", { host: "selftest.local", kind: "read" });
        probes.quietHours = "FAIL（未拦截）";
      } catch (e) { probes.quietHours = /夜间静默/.test(e.message) ? "OK" : "FAIL：" + e.message; }
      await saveGuardConfig({ quietHoursEnabled: oldQuiet });
      // 限速：连打直到拒绝
      let throttled = null;
      const lim = getGuardConfig().rateMaxActions;
      for (let i = 0; i < lim + 5; i++) {
        try { await guardBefore("read_probe", { host: "ratetest.local", kind: "action" }); }
        catch (e) { throttled = e.message; break; }
      }
      probes.rateLimit = throttled && /限速/.test(throttled)
        ? `OK（第 ${lim + 1} 次被拒）` : "FAIL（未触发限速）：" + throttled;

      // 3) 点击偏移采样
      const offs = [];
      for (let i = 0; i < 300; i++) { const o = clickOffset(); offs.push(Math.hypot(o.dx, o.dy)); }
      offs.sort((a, b) => a - b);
      const offStats = { p50: +offs[150].toFixed(1), p90: +offs[270].toFixed(1), max: +offs[299].toFixed(1) };

      return {
        ok: true,
        configSnapshot: {
          enabled: cfgNow.enabled,
          blockSensitive: cfgNow.blockSensitive,
          mousePath: cfgNow.mousePath,
          tempoAutocorr: cfgNow.tempoAutocorr,
          rateMaxActions: cfgNow.rateMaxActions,
          typoProb: cfgNow.typoProb,
        },
        distributions: dist,
        clickOffsetPx: offStats,
        probes,
        verdict: Object.values(probes).every((v) => String(v).startsWith("OK"))
          ? "✅ 安全守卫工作正常" : "⚠️ 存在未通过项，见 probes",
      };
    }

    // ---- 截图 ----
    case "screenshot": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const format = payload.format ?? "png";
      // ⚠️ CDP 的 quality 只对 jpeg/webp 有效，png 传了会被忽略或报错
      const useQuality = (format === "jpeg" || format === "webp") && payload.quality != null;
      const params = {
        format,
        captureBeyondViewport: payload.fullPage ?? false,
        ...(useQuality ? { quality: Math.max(0, Math.min(100, Math.round(payload.quality))) } : {}),
        // ⚠️ CDP 的 Page.Viewport 要求 x/y/width/height/scale **全部必填**，
        //    少一个就 -32602 "mandatory field missing"（v1.6 踩过）
        ...(payload.clip
          ? {
              clip: {
                x: Number(payload.clip.x) || 0,
                y: Number(payload.clip.y) || 0,
                width: Number(payload.clip.width) || 1,
                height: Number(payload.clip.height) || 1,
                scale: Number(payload.clip.scale) || 1,
              },
            }
          : {}),
      };
      const res = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", params);
      return { base64: res.data, format, quality: useQuality ? params.quality : null };
    }

    // ---- 泛用 CDP 透传 ----
    case "cdp": {
      const tabId = await requireTab(payload.tabId);
      await attachToTab(tabId);
      const res = await chrome.debugger.sendCommand({ tabId }, payload.method, payload.params ?? {});
      return { result: res };
    }

    // ⭐ 自重载（2026-10-22 加）
    // 改完扩展代码后不必让人去 chrome://extensions 手点刷新：
    // 调一次本动作 → 扩展调用 chrome.runtime.reload() → service worker 重启加载新代码
    // → chrome.alarms 会在 ~30s 内把它自动连回 server（无需人工干预）。
    case "self_reload": {
      const delay = Math.max(0, Number(payload.delayMs ?? 300));
      setTimeout(() => {
        try { chrome.runtime.reload(); } catch (_) {}
      }, delay);
      return { ok: true, scheduledInMs: delay, note: "扩展将重载，随后由 alarms 自动重连" };
    }

    default:
      throw new Error(`unknown action: ${action}`);
  }
}

// ─────────────────────────── 辅助实现 ───────────────────────────

async function requireTab(explicit) {
  if (explicit != null) return explicit;
  if (attachedTabId != null) return attachedTabId;
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active) throw new Error("没有活动标签页；请传 tabId，或先调用 tab_attach");
  // ⭐ 友好提示：活动页若是浏览器内部页，直接说清楚（否则后续报错难懂）
  const proto = (active.url || "").split(":")[0];
  if (proto === "chrome" || proto === "edge" || proto === "about") {
    throw new Error(
      `当前活动标签页是浏览器内部页（${active.url}），扩展无法操作。` +
      `请先打开一个普通网页（http/https），或调用 navigate / tabs_list + tab_attach。`
    );
  }
  return active.id;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 网络抓取缓冲：tabId → { on, reqs[], startedAt } */
const networkCapture = {};

/**
 * 通用等待条件：轮询 JS 表达式直到为 true 或超时。
 * @param needAttach 是否需要先 attach（wait_for_url 不需要读 DOM，可省）
 */
async function waitForCondition(tabId, expression, timeoutMs, intervalMs = 250, needAttach = true) {
  if (needAttach) await attachToTab(tabId);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression,
        returnByValue: true,
      });
      if (res.result && res.result.value) return true;
    } catch (_) { /* 页面切换中可能短暂失败，继续轮询 */ }
    await sleep(intervalMs);
  }
  return false;
}

function waitForLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
  });
}

/** 用 CSS 选择器 / 文本 / ref 定位元素中心并发送真实鼠标事件 */
async function doClick(tabId, payload) {
  const { selector, text, ref, double } = payload;

  // ⭐ 安全守卫：敏感动作拦截 + 同域限速
  const host = await hostOfTab(tabId);
  const guard = await guardBefore("click", {
    host, kind: "action",
    texts: [selector, text, ref],
  });

  // 1) 解析元素
  const resolved = await resolveElement(tabId, { selector, text, ref });

  if (!resolved) {
    throw new Error(`element not found (selector=${selector ?? ""} text=${text ?? ""} ref=${ref ?? ""})`);
  }

  const { x, y, objectId } = resolved;

  // 2) 先 focus（若可聚焦）
  if (objectId) {
    try {
      await chrome.debugger.sendCommand({ tabId }, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function(){ try{ this.focus && this.focus(); }catch(e){} }",
        returnByValue: true,
      });
    } catch (_) {}
  }

  // 3) 真实鼠标事件
  await mouseClickAt(tabId, x, y, "left", double ? 2 : 1);

  // 4) 点击后回报「落点到底是什么元素」——便于判断有没有点歪
  const hitFn = `(function(){
    var e = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
    if (!e) return null;
    return { tag: e.tagName.toLowerCase(), text: (e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,50) };
  })()`;
  let hit = null;
  try {
    const hr = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: hitFn, returnByValue: true,
    });
    hit = hr.result && hr.result.value;
  } catch (_) {}

  return { ok: true, x: Math.round(x), y: Math.round(y), hit, _guard: guard._guard };
}

/** 取标签页的 host（用于限速维度） */
async function hostOfTab(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    return hostOfUrl(t.url);
  } catch { return "unknown"; }
}

function hostOfUrl(url) {
  try { return new URL(url).host; } catch { return "unknown"; }
}

/** 上次鼠标位置（用于生成自然轨迹的起点） */
let lastMouse = { x: 0, y: 0 };

/**
 * 鼠标移动到目标点。
 * 默认把移动拆成若干段连续的 mousemove，而不是一次跳到目标——
 * 拖拽、hover 菜单、canvas 绘图等场景需要中间的 mousemove 才会响应。
 */
async function mouseMoveTo(tabId, x, y) {
  const { enabled, steps, stepDelay } = mousePathConfig();
  if (!enabled) {
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    lastMouse = { x, y };
    return;
  }
  const pts = bezierPath(lastMouse.x, lastMouse.y, x, y, steps);
  for (const p of pts) {
    try {
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x: p.x, y: p.y,
      });
    } catch (_) { break; }
    await sleep(stepDelay);
  }
  lastMouse = { x, y };
  noteMousePath();
}

/**
 * 在坐标处点击。
 *
 * 事件顺序按浏览器真实链路发送：
 *   mouseover → mouseenter → mousemove → mousedown → mouseup → click
 * 只发 down/up 时，依赖 hover 的下拉菜单、拖拽手柄不会响应。
 *
 * 落点取元素中心；按下与抬起之间留出 holdMs，让页面能感知一次完整点击。
 */
async function mouseClickAt(tabId, x, y, button = "left", clickCount = 1, opts = {}) {
  const buttons = button === "right" ? 2 : button === "middle" ? 4 : 1;
  const { jitter = true } = opts;

  for (let i = 1; i <= clickCount; i++) {
    // ① 落点高斯偏移（同一元素多次点击也要有微小差异）
    let px = x, py = y;
    if (jitter) {
      const { dx, dy } = clickOffset();
      px = x + dx; py = y + dy;
    }

    // ② 贝塞尔移动到落点
    await mouseMoveTo(tabId, px, py);

    // ③ mouseover / mouseenter —— 补齐事件链，保证依赖 hover 的菜单能展开
    for (const type of ["mouseOver", "mouseEnter"]) {
      try {
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
          type, x: px, y: py, button, buttons,
        });
      } catch (_) { /* 某些 Chrome 版本对 mouseEnter 不认，忽略 */ }
    }
    await sleep(Math.round(8 + Math.random() * 22));

    // ④ 按下 → 保持 → 抬起
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: px, y: py, button, buttons, clickCount: i,
    });
    await sleep(clickHoldMs());
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: px, y: py, button, buttons, clickCount: i,
    });

    // ⑤ 双击的第二下要更紧凑（双击间隔通常 80–200ms）
    if (i < clickCount) await sleep(Math.round(80 + Math.random() * 120));
  }
}

/**
 * 输入文本。
 *
 * ⚠️ 关键：`Input.insertText` 只在**焦点位于可编辑元素**时才生效。
 * 原实现「点坐标 → 立刻 insertText」在 React/Vue 懒渲染页面会失败
 * （点击时真正的 <input> 还没挂上，或点击落到了外层容器上）。
 *
 * 现在的流程：
 *   ① 定位并点击（若给了 selector/ref）
 *   ② **验证 document.activeElement 是可编辑元素**
 *   ③ 不是则尝试 el.focus()，仍不行则直接 setValue（兜底，触发 input 事件）
 *   ④ 最后 insertText
 */
async function doType(tabId, payload) {
  const { selector, text, ref, submit, human } = payload;

  // ⭐ 安全守卫
  const host = await hostOfTab(tabId);
  const guard = await guardBefore("type", {
    host, kind: "action",
    texts: [selector, text, ref],
  });

  let el;      // 供 eval 使用的定位表达式
  if (selector) el = `document.querySelector(${JSON.stringify(selector)})`;
  else if (ref) el = `(window.__xyBridgeRefs && window.__xyBridgeRefs[${JSON.stringify(ref)}])`;

  // ① 点击聚焦
  if (el) {
    const resolved = await resolveElement(tabId, { selector, ref });
    if (!resolved) throw new Error(`input not found (selector=${selector ?? ""} ref=${ref ?? ""})`);
    await mouseClickAt(tabId, resolved.x, resolved.y, "left");
    await sleep(120);
  }

  // ② 检查焦点是否在可编辑元素上
  const focusCheck = `(function(){
    var a = document.activeElement;
    if (!a) return { focused: false, reason: 'no activeElement' };
    var tag = a.tagName.toLowerCase();
    var editable = (tag === 'input' || tag === 'textarea') || a.isContentEditable || a.getAttribute('role') === 'textbox';
    return { focused: editable, tag: tag, id: a.id || '', cls: (a.className||'').toString().slice(0,60) };
  })()`;

  let fc = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression: focusCheck, returnByValue: true,
  });
  let info = fc.result && fc.result.value;

  // ③ 焦点不对 → 主动 focus 目标元素
  if (!info || !info.focused) {
    if (el) {
      const focusFn = `(function(){
        var e = ${el};
        if (!e) return false;
        if (e.focus) e.focus();
        if (e.click && document.activeElement !== e) { try { e.click(); } catch(_){} }
        var a = document.activeElement;
        var tag = a ? a.tagName.toLowerCase() : '';
        return !!a && (tag === 'input' || tag === 'textarea' || a.isContentEditable || a.getAttribute('role') === 'textbox');
      })()`;
      const fr = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: focusFn, returnByValue: true,
      });
      const ok = fr.result && fr.result.value;
      await sleep(80);
      if (!ok) {
        // ④ 兜底：直接设值 + 派发事件（绕过焦点问题）
        const setFn = `(function(){
          var e = ${el};
          if (!e) return { ok:false, reason:'element not found' };
          var proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          var setter = Object.getOwnPropertyDescriptor(proto, 'value');
          if (setter && setter.set) setter.set.call(e, ${JSON.stringify(text)});
          else e.value = ${JSON.stringify(text)};
          e.dispatchEvent(new Event('input', { bubbles: true }));
          e.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok:true, value: e.value, mode:'setValue' };
        })()`;
        const sr = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
          expression: setFn, returnByValue: true,
        });
        const sres = sr.result && sr.result.value;
        if (sres && sres.ok) {
          if (submit) { await sleep(100); await pressKey(tabId, "Enter"); }
          return { ok: true, mode: "setValue", length: text.length, verified: sres.value === text };
        }
        throw new Error(`无法聚焦输入框（焦点在 <${info?.tag || "?"}> 上，且 setValue 兜底失败）`);
      }
    } else {
      throw new Error(`插入文本前焦点不在可编辑元素上（当前焦点 <${info?.tag || "?"}>）。请先用 click 点击输入框，或给 type 传 selector/ref。`);
    }
  }

  // ⑤ insertText（中文可靠）
  await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text });
  await sleep(80);

  // ⑥ 回读验证
  const verifyFn = `(function(){
    var a = document.activeElement;
    return a ? (a.value !== undefined ? a.value : a.innerText) : null;
  })()`;
  const vr = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression: verifyFn, returnByValue: true,
  });
  const actual = vr.result && vr.result.value;

  if (submit) {
    await sleep(100);
    await pressKey(tabId, "Enter");
  }

  return {
    ok: true,
    mode: "insertText",
    length: text.length,
    readback: typeof actual === "string" ? actual.slice(0, 100) : actual,
    verified: typeof actual === "string" && actual.includes(text),
    _guard: guard._guard,
  };
}

/**
 * ⭐ 逐字输入。
 *
 * 与 doType 的区别：不用 insertText 一次性塞入，而是**逐字符**发送
 * `Input.dispatchKeyEvent`（char 类型），字符之间有固定间隔。
 * 用途：带输入防抖、联想下拉、或只监听 keydown 的表单。
 *
 * ⚠️ 中文处理：CDP 的 keyDown 走 US 键盘映射，直接发中文会丢字。
 *    因此策略是——**ASCII 逐字发；中文等非 ASCII 片段走 insertText 小段插入**。
 */
async function doTypeHuman(tabId, payload) {
  const { selector, ref, text, submit, clear } = payload;
  if (typeof text !== "string") throw new Error("type_human 需要 text");

  const host = await hostOfTab(tabId);
  const guard = await guardBefore("type_human", {
    host, kind: "action",
    texts: [selector, text, ref],
  });

  let el;
  if (selector) el = `document.querySelector(${JSON.stringify(selector)})`;
  else if (ref) el = `(window.__xyBridgeRefs && window.__xyBridgeRefs[${JSON.stringify(ref)}])`;

  // ① 聚焦
  if (el) {
    const resolved = await resolveElement(tabId, { selector, ref });
    if (!resolved) throw new Error(`input not found (selector=${selector ?? ""} ref=${ref ?? ""})`);
    await mouseClickAt(tabId, resolved.x, resolved.y, "left");
    await sleep(gaussianLocal(80, 220));
  }

  // ② 清空（可选）
  if (clear && el) {
    const clearFn = `(function(){
      var e = ${el}; if (!e) return false;
      var proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(e, ''); else e.value = '';
      e.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`;
    try {
      await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: clearFn, returnByValue: true });
    } catch (_) {}
    await sleep(gaussianLocal(60, 160));
  }

  // ③ 逐字符：按住 holdMs → 抬起 → 等 flightMs 再发下一个
  //    保持固定的按键时长与间隔，让输入框的防抖/联想逻辑有机会响应
  let typed = 0;
  const chars = Array.from(text);
  let rolloutPending = null;   // 上一字符的 keyUp 延后到下一字符 keyDown 之后（Rollover）

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const { hold, flight, rollout } = keyRhythm();

    // Rollover：先把上一颗键的 keyUp 补发（若它被延迟了）
    if (rolloutPending) {
      try { await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", rolloutPending); } catch (_) {}
      rolloutPending = null;
    }

    if (ch.charCodeAt(0) < 128) {
      const code = ch.charCodeAt(0);
      const isUpper = /[A-Z]/.test(ch);
      const base = {
        key: ch,
        code: /[a-zA-Z]/.test(ch) ? "Key" + ch.toUpperCase() : (ch === " " ? "Space" : ""),
        windowsVirtualKeyCode: ch === " " ? 32 : code,
        nativeVirtualKeyCode: ch === " " ? 32 : code,
        text: isUpper ? ch : ch,
        unmodifiedText: ch.toLowerCase(),
      };
      try {
        // Shift 处理：大写字母先按住 Shift
        if (isUpper) {
          await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
            type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16, modifiers: 8,
          });
          await sleep(Math.round(20 + Math.random() * 40));
        }
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "keyDown", ...base, modifiers: isUpper ? 8 : 0 });
        // 保持 hold 时长后再抬起（不是原子发射）
        await sleep(hold);
        const up = { type: "keyUp", ...base, modifiers: isUpper ? 8 : 0 };
        if (rollout) rolloutPending = up;            // 延后抬起 → 形成重叠
        else await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", up);
        if (isUpper) {
          await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
            type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16,
          });
        }
        typed++;
      } catch (_) {}
    } else {
      // 非 ASCII（中文等）：逐字 insertText，保持时长无意义，只走飞行间隔
      try {
        await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text: ch });
        typed++;
      } catch (_) {}
    }

    // ④ 可选：邻键错误注入（默认关闭，仅用于测试纠错流程）
    const typo = shouldTypo();
    if (typo && i < chars.length - 1) {
      const wrong = nearKey(ch);
      if (wrong && wrong !== ch) {
        try {
          await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text: wrong });
          await sleep(typo.recognizeMs);   // 意识到打错了
          await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
            type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
          });
          await sleep(typo.backspaceMs);
          await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
            type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
          });
          await sleep(Math.round(60 + Math.random() * 120));
        } catch (_) {}
      }
    }

    // ⑤ 字间飞行（log-logistic 重尾）
    await sleep(flight);
  }

  // 收尾：补发遗留的 Rollover keyUp
  if (rolloutPending) {
    try { await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", rolloutPending); } catch (_) {}
    rolloutPending = null;
  }

  // ④ 回读
  const verifyFn = `(function(){
    var a = document.activeElement;
    return a ? (a.value !== undefined ? a.value : a.innerText) : null;
  })()`;
  let actual = null;
  try {
    const vr = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: verifyFn, returnByValue: true });
    actual = vr.result && vr.result.value;
  } catch (_) {}

  if (submit) {
    await sleep(gaussianLocal(100, 260));
    await pressKey(tabId, "Enter");
  }

  return {
    ok: true,
    mode: "human-typed",
    length: chars.length,
    typed,
    readback: typeof actual === "string" ? actual.slice(0, 120) : actual,
    verified: typeof actual === "string" && actual.includes(text),
    _guard: guard._guard,
  };
}

/** 本地高斯（避免为小停顿引入额外依赖） */
function gaussianLocal(lo, hi) {
  const mean = (lo + hi) / 2, std = (hi - lo) / 4;
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(lo, Math.min(hi, Math.round(mean + z * std)));
}

/** QWERTY 邻键表 —— 用于可选的"邻键错误注入"（默认关闭）。 */
const NEAR_KEYS = {
  q: "wa", w: "qes", e: "wrd", r: "etf", t: "ryg", y: "tuh", u: "yij", i: "uok", o: "ipl", p: "ol",
  a: "qsz", s: "awdx", d: "sefc", f: "drgv", g: "fthb", h: "gyjn", j: "hukm", k: "jil", l: "kop",
  z: "asx", x: "zsdc", c: "xdfv", v: "cfgb", b: "vghn", n: "bhjm", m: "njk",
};
function nearKey(ch) {
  const lower = ch.toLowerCase();
  const pool = NEAR_KEYS[lower];
  if (!pool) return null;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return ch === lower ? pick : pick.toUpperCase();
}

const KEY_CODES = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Space: { key: " ", code: "Space", keyCode: 32 },
};

async function pressKey(tabId, key, modifiers = 0) {
  const info = KEY_CODES[key] || { key, code: key, keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0 };
  const base = {
    modifiers,
    key: info.key,
    code: info.code,
    windowsVirtualKeyCode: info.keyCode,
    nativeVirtualKeyCode: info.keyCode,
    text: key.length === 1 ? key : undefined,
  };
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

async function doScroll(tabId, payload) {
  const { x = 500, y = 400, deltaX = 0, deltaY = 300, selector } = payload;
  let cx = x, cy = y;
  if (selector) {
    const r = await resolveElement(tabId, { selector });
    if (r) { cx = r.x; cy = r.y; }
  }
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseWheel", x: cx, y: cy, deltaX, deltaY,
  });
}

/** 解析元素 → 返回 {x, y, found}。支持 selector / text / ref(@eN) */
async function resolveElement(tabId, { selector, text, ref }) {
  // ⭐ 两步：① 先滚入视口 ② 等渲染稳定后**再**读坐标
  // （原实现 scrollIntoView 后立即读 rect —— 滚动是异步的，拿到的是旧坐标 → 点歪）
  const findFn = `function(){
    const sel = ${JSON.stringify(selector || null)};
    const txt = ${JSON.stringify(text || null)};
    const ref = ${JSON.stringify(ref || null)};
    let el = null;

    // ⭐ v1.5：可见性判定提到顶层 —— selector / text / ref **三条路径统一过滤隐藏副本**
    //   病根：原实现只有 text 路径过滤；selector 用 querySelector 直接取第一个，
    //   而部分站点会出现「同名元素 + 负坐标隐藏副本」→ 点到不存在的点。
    const isVisible = function(e){
      if (!e) return false;
      // ① 首选原生 API：会递归检查祖先链（display:none / visibility:hidden / content-visibility）
      if (typeof e.checkVisibility === 'function') {
        try { if (!e.checkVisibility({ checkOpacity:true, checkVisibilityCSS:true })) return false; } catch(_) {}
      }
      // ② 逐级向上检查祖先（兜底，防 API 不可用）
      let p = e;
      while (p && p !== document.documentElement) {
        const cs = getComputedStyle(p);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
        p = p.parentElement;
      }
      // ③ 尺寸与离屏
      const r = e.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      if (Math.abs(r.left) > 5000 || Math.abs(r.top) > 5000) return false;
      return true;
    };

    if (ref) {
      el = window.__xyBridgeRefs && window.__xyBridgeRefs[ref];
      // ref 可能因页面重渲染失效，重查一次
      if (el && !document.contains(el)) el = null;
      if (el && !isVisible(el)) el = null;
    } else if (sel) {
      const cands = Array.from(document.querySelectorAll(sel));
      // ⭐ 先可见 → 再兜底（兜底保留，防「元素有尺寸但被判定为不可见」的误杀）
      el = cands.find(isVisible) || cands[0] || null;
    } else if (txt) {
      const all = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"],label,span,div,p,li,h1,h2,h3'));
      const norm = s => (s||'').replace(/\\\\s+/g,' ').trim();
      const t = norm(txt);
      const exact = all.filter(e => norm(e.innerText||e.value||e.getAttribute('aria-label')||e.getAttribute('placeholder')) === t);
      const loose = all.filter(e => norm(e.innerText||'').includes(t));
      // 先可见精确 → 可见模糊 → 兜底任意
      el = exact.find(isVisible) || loose.find(isVisible) || exact[0] || loose[0];
    }
    if (!el) return null;
    window.__xyBridgeEl = el;               // 暂存，供第二步读取
    el.scrollIntoView({block:'center', inline:'center'});
    return true;
  }`;

  const r1 = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression: `(${findFn})()`,
    returnByValue: true,
    awaitPromise: false,
  });
  if (r1.exceptionDetails) throw new Error(r1.exceptionDetails.text || "resolve failed");
  if (!r1.result || !r1.result.value) return null;   // 元素没找到

  // ② 等滚动/布局稳定，再读真实坐标
  //  ⚠️ 坑（2026-10-12 实测）：原先用 requestAnimationFrame 等两帧——
  //     但**后台标签页的 rAF 会被 Chrome 冻结**，Promise 永不 resolve
  //     → sendCommand 永久挂住 → click 卡死（status/eval 都正常，只有 click 挂）。
  //     ⇒ 改用 setTimeout 双保险 + 竞速超时，绝不无限等。
  const readFn = `(function(){
    return new Promise(function(resolve){
      var done = false;
      function finish(){
        if (done) return;
        done = true;
        try {
          var el = window.__xyBridgeEl;
          if (!el) return resolve(null);
          var r = el.getBoundingClientRect();
          var cs = getComputedStyle(el);
          resolve({
            x: Math.round(r.left + r.width/2),
            y: Math.round(r.top + r.height/2),
            w: Math.round(r.width),
            h: Math.round(r.height),
            vw: innerWidth,
            vh: innerHeight,
            sx: Math.round(window.scrollX || 0),
            sy: Math.round(window.scrollY || 0),
            visible: cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0 && r.width > 0 && r.height > 0,
            // ⭐ v1.5：判据改成「中心点是否落在视口内」——
            //    原判据 r.left>=0 && r.right<=innerWidth 对「比视口宽的元素」必然失败，
            //    而点击只需要中心点可见。
            inViewport: (function(){
              var cx = r.left + r.width/2, cy = r.top + r.height/2;
              return cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight;
            })()
          });
        } catch (e) { resolve(null); }
      }
      // 双保险：rAF 若被冻结，靠 setTimeout 兜底；再不行靠外部超时
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function(){ setTimeout(finish, 0); });
      setTimeout(finish, 32);
      setTimeout(finish, 250);
    });
  })()`;

  const r2 = await Promise.race([
    chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: readFn,
      returnByValue: true,
      awaitPromise: true,
    }),
    new Promise((_res, rej) => setTimeout(() => rej(new Error("读取元素坐标超时（页面可能被后台冻结）")), 4000)),
  ]);
  if (r2.exceptionDetails) throw new Error(r2.exceptionDetails.text || "read rect failed");
  const val = r2.result && r2.result.value;
  if (!val) return null;

  // ⭐ 不再静默返回 (0,0)：坐标异常/元素不可见时明确报错
  // ⭐⭐ v1.5：先区分「页面根本没渲染」和「元素真的在视口外」——两者的处置完全不同。
  //    视口 0×0 的典型成因：Chrome 窗口最小化 / 标签页在后台 / 页面被冻结。
  //    此时所有元素坐标都会是 0，报「滚动未生效」会把人引到错误的方向。
  if (val.vw === 0 || val.vh === 0) {
    throw fail(
      "E_NOT_RENDERED",
      `页面未渲染（视口 ${val.vw}×${val.vh}）：Chrome 窗口可能被最小化，或标签页在后台。` +
      `处置：① 把 Chrome 窗口恢复（不能最小化）② 用 tab_select 切到该页再试`
    );
  }
  if (!val.visible) throw new Error("元素存在但不可见（display/visibility/opacity 或尺寸为 0）");
  if (!val.inViewport) {
    throw new Error(
      `元素中心点在视口外（x=${val.x}, y=${val.y}; 视口 ${val.vw}×${val.vh}），滚动未生效`
    );
  }

  // ⭐⭐ 坐标稳定性检测（校准：kdriver 的 getStableCoordinates）
  //
  //    血泪场景：SPA（React/Vue）里点击后组件重渲染、或滚动惯性未停、
  //    或字体懒加载导致布局位移——此时读到的坐标在"移动中"，
  //    点下去就落在错误位置（表现为"点了但没反应"或点错按钮）。
  //    解法：连读两次，位移 >5px 则重读一轮；两轮都不稳就用最新值 + 标记。
  let { x, y } = val;
  let stable = true;
  try {
    const second = await readRectOnce(tabId);
    if (second && (Math.abs(second.x - x) > 5 || Math.abs(second.y - y) > 5)) {
      stable = false;
      await sleep(120);                       // 等布局落定
      const third = await readRectOnce(tabId);
      if (third) { x = third.x; y = third.y; }
    }
  } catch (_) { /* 稳定性检测失败不阻断主流程 */ }

  return { x, y, stable };
}

/** 单次读取 __xyBridgeEl 的中心坐标（供稳定性检测复用） */
async function readRectOnce(tabId) {
  const fn = `(function(){
    var el = window.__xyBridgeEl;
    if (!el || !document.contains(el)) return null;
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
  })()`;
  try {
    const res = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: fn, returnByValue: true,
    });
    return (res && res.result && res.result.value) || null;
  } catch { return null; }
}

async function resolveNodeId(tabId, selector) {
  const doc = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument", { depth: -1 });
  const res = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector,
  });
  if (!res.nodeId) throw new Error(`selector not found: ${selector}`);
  return res.nodeId;
}

async function resolveObjectId(tabId, selector) {
  const res = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression: selector,
    returnByValue: false,
  });
  if (!res.result || !res.result.objectId) throw new Error(`selector not found: ${selector}`);
  return res.result.objectId;
}

async function waitForSelector(tabId, selector, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: `!!document.querySelector(${JSON.stringify(selector)})`,
        returnByValue: true,
      });
      if (res.result && res.result.value) return true;
    } catch (_) {}
    await sleep(250);
  }
  return false;
}

/** 生成 DOM 快照：可见可交互元素 + 稳定 ref（写入 window.__xyBridgeRefs） */
function buildSnapshotScript(maxNodes) {
  return `(function(){
    const MAX = ${maxNodes};
    const refs = {};
    let i = 0;
    const out = [];
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) return false;
      return true;
    };
    const nameOf = (el) => {
      const cands = [
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        el.getAttribute('title'),
        el.innerText,
        el.value,
        el.getAttribute('name'),
        el.getAttribute('alt'),
      ];
      for (const c of cands) {
        if (c && String(c).trim()) return String(c).replace(/\\s+/g,' ').trim().slice(0, 80);
      }
      return '';
    };
    const sel = 'a,button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[contenteditable="true"],[onclick],summary,label,option';
    const nodes = Array.from(document.querySelectorAll(sel));
    for (const el of nodes) {
      if (out.length >= MAX) break;
      if (!isVisible(el)) continue;
      const ref = '@e' + (++i);
      refs[ref] = el;
      const r = el.getBoundingClientRect();
      out.push({
        ref,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        role: el.getAttribute('role') || '',
        name: nameOf(el),
        href: el.tagName === 'A' ? (el.getAttribute('href') || '') : '',
        placeholder: el.getAttribute('placeholder') || '',
        x: Math.round(r.left + r.width/2),
        y: Math.round(r.top + r.height/2),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
    window.__xyBridgeRefs = refs;
    return out;
  })()`;
}

// ─────────────────────────── 消息入口 ───────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.type) return sendResponse({ ok: false });

    if (msg.type === "connect") {
      await setDesired(true);
      connect();
      // 顺手 attach 当前激活标签页
      try {
        const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (active) await attachToTab(active.id);
      } catch (e) {
        console.warn("[bridge] auto attach failed:", e);
      }
      await broadcast();
      return sendResponse({ ok: true, state: state() });
    }

    if (msg.type === "disconnect") {
      await setDesired(false);
      await detachCurrent();
      if (ws) { try { ws.close(); } catch (_) {} }
      connected = false;
      await broadcast();
      return sendResponse({ ok: true, state: state() });
    }

    if (msg.type === "get_state") {
      return sendResponse({ ok: true, state: state() });
    }

    // ⭐ popup 用：一次拿到守卫配置 + 统计
    if (msg.type === "guard_snapshot") {
      return sendResponse({ ok: true, config: getGuardConfig(), stats: getGuardStats() });
    }

    sendResponse({ ok: false, error: "unknown message type" });
  })();
  return true; // async
});

// ─────────────────────────── 生命周期 / 保活 ───────────────────────────

/**
 * ⭐⭐ 关键：onAlarm / onStartup / onInstalled 监听器
 * 必须**在顶层同步注册**（不能在 await 之后），
 * 否则 Chrome 唤醒 worker 投递事件时监听器还没挂上 → 事件丢失。
 */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  console.log("[bridge] alarm 唤醒，检查连接");
  if (!desiredConnected) {
    // 内存未初始化，异步读一次
    restoreDesired().then((want) => {
      if (want && !connected) connect();
    });
    return;
  }
  if (!connected) connect();
});

chrome.runtime.onStartup.addListener(() => { bootstrap(); });
chrome.runtime.onInstalled.addListener(() => { bootstrap(); });

// SW 每次被唤醒（含冷启动）都会执行顶层代码
async function bootstrap() {
  await loadGuardConfig();       // ⭐ 恢复守卫配置（否则 SW 重启后回到默认值）
  const want = await restoreDesired();
  if (want) {
    ensureKeepalive();
    connect();
  }
  broadcast();
}
bootstrap();
