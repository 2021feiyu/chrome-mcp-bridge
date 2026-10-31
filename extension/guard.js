/**
 * chrome-mcp-bridge · safety guard
 * ══════════════════════════════════════════════════════════════
 *
 * 这一层解决的是「别做错事」，不是「别被发现」。
 *
 *   ① 同域限速      —— 滑动窗口计数，导航比普通动作更严
 *   ② 敏感动作拦截  —— 发布/支付/删除类动作默认拒绝，需显式解锁
 *   ③ 夜间静默      —— 可选，指定时段内不执行任何动作
 *
 * 本文件**不做**输入伪装：不模拟人类打字节奏、不生成鼠标抖动、
 * 不注入错字。所有事件都是普通自动化事件，只约束「做什么」和「多频繁」。
 *
 * 所有约束都可观测：guard_stats 返回实时统计，每个动作的返回值里带
 * `_guard` 字段，说明这次调用命中了什么约束。
 */

// ─────────────────────────── 配置 ───────────────────────────

export const GUARD_DEFAULTS = {
  enabled: true,

  // 动作之间的固定间隔（毫秒）。给页面留出响应时间，避免连点。
  delayMin: 80,
  delayMax: 200,

  // 逐字输入的按键时长与字间间隔（毫秒）
  holdMs: 30,
  flightMs: 40,

  // 鼠标移动：分段直线移动，而不是一次瞬移
  mousePath: true,
  mouseStepsMin: 4,
  mouseStepsMax: 8,
  mouseStepDelay: 8,

  // ③ 同域限速（滑动窗口）
  rateWindowMs: 60000,    // 窗口长度：1 分钟
  rateMaxActions: 40,     // 窗口内最多动作数
  rateMaxNav: 8,          // 窗口内最多导航数（更严）
  rateScope: "host",      // 限速维度：host | global

  // ④ 敏感动作拦截（正则匹配 selector / text / url）
  blockSensitive: true,
  sensitivePatterns: [
    // 发布 / 提交 / 发送
    "发布", "发表", "提交", "发送", "上传.*发布", "publish", "post\\b", "submit",
    // 支付 / 下单 / 充值
    "支付", "付款", "下单", "购买", "充值", "结算", "确认.*付款", "pay\\b", "checkout",
    // 删除 / 注销 / 解绑
    "删除", "注销", "注销账号", "解绑", "解除绑定", "清空", "delete", "remove\\b",
    // 授权 / 同意 / 免密
    "同意授权", "允许", "开通", "免密", "自动续费",
  ],

  // 夜间静默（本地时间，跨零点用 start > end 表示）
  quietHoursEnabled: false,
  quietStart: 2,   // 02:00
  quietEnd: 7,     // 07:00

  // 兼容字段（popup / 自检读取，固定为 0）
  tempoAutocorr: 0,
  typoProb: 0,
};

// ─────────────────────────── 运行时状态 ───────────────────────────

let cfg = { ...GUARD_DEFAULTS };

/** 滑动窗口记录：[{t, host, kind}] */
let history = [];
/** 统计 */
const stats = {
  startedAt: Date.now(),
  actions: 0,          // 经过守卫的动作总数
  blocked: 0,          // 被拦截
  throttled: 0,        // 被限速
  delayedMs: 0,        // 累计等待时间
  mousePaths: 0,       // 分段移动次数
  typos: 0,            // 保留字段（本版本不注入错字，恒为 0）
  byAction: {},        // 按 action 计数
};
/** 敏感解锁（内存 + storage 持久化） */
let sensitiveUnlocked = false;
/** 最近一次限速原因（供诊断） */
let lastThrottle = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────── 节奏（固定值，不做伪装） ───────────────────────────

/** 动作之间的固定等待。返回值仅受配置影响，不引入随机分布。 */
export function pacedDelay() {
  return Math.max(0, Math.round(cfg.delayMin));
}

/** 保留接口：旧调用点用它重置"节奏状态"，本实现无需状态 */
export function resetTempo() { /* no-op */ }

/** 保留接口：旧调用点用它插入"思考停顿"，本实现不插入额外停顿 */
export async function maybeThinkingPause() { /* no-op */ }

/**
 * 直线路径采样：把 (x0,y0) → (x1,y1) 均分成 steps 段。
 * 仅用于让页面收到连续的 mousemove，而不是一次跳跃。
 */
export function bezierPath(x0, y0, x1, y1, steps = 8) {
  const n = Math.max(1, Math.min(64, Math.round(steps) || 8));
  const pts = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    pts.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t });
  }
  return pts;
}

/** 鼠标移动参数 */
export function mousePathConfig() {
  const lo = Math.max(1, Math.round(cfg.mouseStepsMin));
  const hi = Math.max(lo, Math.round(cfg.mouseStepsMax));
  return {
    enabled: !!cfg.mousePath,
    steps: Math.round((lo + hi) / 2),
    stepDelay: Math.max(0, Math.round(cfg.mouseStepDelay)),
  };
}

/** 点击落点偏移：精确落在元素中心（不制造"人性化"偏移） */
export function clickOffset() {
  return { dx: 0, dy: 0 };
}

/** 按下 → 抬起间隔 */
export function clickHoldMs() {
  return Math.max(0, Math.round(cfg.holdMs));
}

/** 逐字输入节奏 */
export function keyRhythm() {
  return {
    hold: Math.max(0, Math.round(cfg.holdMs)),
    flight: Math.max(0, Math.round(cfg.flightMs)),
    rollout: false,
  };
}

/** 是否注入错字：本版本恒为 false */
export function shouldTypo() { return false; }

/** 记录一次分段移动 */
export function noteMousePath() { stats.mousePaths++; }

// ─────────────────────────── 守卫主体 ───────────────────────────

function inQuietHours() {
  if (!cfg.quietHoursEnabled) return false;
  const h = new Date().getHours();
  const s = Number(cfg.quietStart);
  const e = Number(cfg.quietEnd);
  if (Number.isNaN(s) || Number.isNaN(e) || s === e) return false;
  // 跨零点：start > end，例如 22 → 7
  return s < e ? (h >= s && h < e) : (h >= s || h < e);
}

function findSensitive(texts) {
  const blob = (texts || [])
    .filter((t) => typeof t === "string" && t)
    .join("\n");
  if (!blob) return null;
  for (const p of cfg.sensitivePatterns) {
    try {
      if (new RegExp(p, "i").test(blob)) return p;
    } catch (_) { /* 无效正则忽略 */ }
  }
  return null;
}

function prune(now) {
  const floor = now - cfg.rateWindowMs;
  if (history.length > 2000) history = history.filter((r) => r.t >= floor);
  else {
    let i = 0;
    while (i < history.length && history[i].t < floor) i++;
    if (i > 0) history = history.slice(i);
  }
}

/**
 * 动作前置守卫。
 *
 * @param {string} action 动作名（click / type / navigate …）
 * @param {object} ctx    { host, kind: "nav"|"read"|"action", texts: [] }
 * @returns {{_guard: object}} 放行时返回本次约束信息
 * @throws  Error 命中夜间静默 / 敏感动作 / 限速
 */
export async function guardBefore(action, ctx = {}) {
  const host = ctx.host || "unknown";
  const kind = ctx.kind === "nav" ? "nav" : ctx.kind === "read" ? "read" : "action";

  stats.actions++;
  stats.byAction[action] = (stats.byAction[action] || 0) + 1;

  if (!cfg.enabled) return { _guard: { action, host, kind, skipped: "disabled" } };

  if (inQuietHours()) {
    stats.blocked++;
    throw new Error(
      `夜间静默：${cfg.quietStart}:00–${cfg.quietEnd}:00 内不执行动作（${action} @ ${host}）`
    );
  }

  if (cfg.blockSensitive && !sensitiveUnlocked && kind !== "read") {
    const hit = findSensitive(ctx.texts);
    if (hit) {
      stats.blocked++;
      throw new Error(`敏感动作需显式解锁：命中「${hit}」（${action} @ ${host}）`);
    }
  }

  const now = Date.now();
  prune(now);

  const limit = kind === "nav" ? cfg.rateMaxNav : cfg.rateMaxActions;
  const used = history.filter((r) => {
    if (r.kind !== kind) return false;
    return cfg.rateScope === "global" ? true : r.host === host;
  }).length;

  if (used >= limit) {
    stats.throttled++;
    lastThrottle = { at: now, host, kind, used, limit };
    throw new Error(
      `限速：${host} 在 ${Math.round(cfg.rateWindowMs / 1000)}s 内已执行 ${used} 次 ${kind}（上限 ${limit}）`
    );
  }

  history.push({ t: now, host, kind });

  const wait = pacedDelay();
  if (wait > 0) {
    stats.delayedMs += wait;
    await sleep(wait);
  }

  return { _guard: { action, host, kind, used: used + 1, limit } };
}

// ─────────────────────────── 配置与统计 ───────────────────────────

export async function loadGuardConfig() {
  try {
    const r = await chrome.storage.local.get(["guardConfig"]);
    if (r && r.guardConfig) cfg = { ...GUARD_DEFAULTS, ...r.guardConfig };
  } catch { /* 忽略 */ }
  return cfg;
}

export async function saveGuardConfig(patch = {}) {
  cfg = { ...cfg, ...patch };
  try { await chrome.storage.local.set({ guardConfig: cfg }); } catch { /* 忽略 */ }
  return cfg;
}

export function getGuardConfig() { return { ...cfg }; }

export function getGuardStats() {
  return {
    ...stats,
    uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000),
    recentWindow: history.length,
    lastThrottle,
    sensitiveUnlocked,
    quietNow: inQuietHours(),
  };
}

export function setSensitiveUnlock(v) {
  sensitiveUnlocked = !!v;
  return sensitiveUnlocked;
}
