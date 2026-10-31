/**
 * 守卫逻辑自测（不需要浏览器）
 *
 *   node tests/guard.test.mjs
 *
 * 用最小 chrome.* 桩跑 extension/guard.js，验证四类约束：
 * 敏感动作拦截 / 只读放行 / 夜间静默 / 同域限速。
 */
globalThis.chrome = {
  storage: { local: { get: async () => ({}), set: async () => {} } },
};

const g = await import("../extension/guard.js");

let pass = 0;
let fail = 0;
const ck = (name, cond) => {
  if (cond) {
    pass++;
    console.log("PASS", name);
  } else {
    fail++;
    console.log("FAIL", name);
  }
};

// 1) 敏感动作默认拦截
try {
  await g.guardBefore("click", { host: "a.test", kind: "action", texts: ["发布文章"] });
  ck("敏感动作被拦", false);
} catch (e) {
  ck("敏感动作被拦", /敏感动作/.test(e.message));
}

// 2) 只读动作放行
try {
  await g.guardBefore("snapshot", { host: "a.test", kind: "read" });
  ck("只读放行", true);
} catch {
  ck("只读放行", false);
}

// 3) 显式解锁后放行
g.setSensitiveUnlock(true);
try {
  await g.guardBefore("click", { host: "a.test", kind: "action", texts: ["发布文章"] });
  ck("解锁后放行", true);
} catch {
  ck("解锁后放行", false);
}
g.setSensitiveUnlock(false);

// 4) 夜间静默
await g.saveGuardConfig({ quietHoursEnabled: true, quietStart: 0, quietEnd: 24 });
try {
  await g.guardBefore("click", { host: "b.test", kind: "read" });
  ck("夜间静默拦截", false);
} catch (e) {
  ck("夜间静默拦截", /夜间静默/.test(e.message));
}
await g.saveGuardConfig({ quietHoursEnabled: false });

// 5) 同域限速
const lim = g.getGuardConfig().rateMaxActions;
let hit = null;
for (let i = 0; i < lim + 5; i++) {
  try {
    await g.guardBefore("read_probe", { host: "c.test", kind: "action" });
  } catch (e) {
    hit = e.message;
    break;
  }
}
ck(`限速触发（第 ${lim + 1} 次）`, !!hit && /限速/.test(hit));

// 6) 节奏相关函数形状
const k = g.keyRhythm();
ck("keyRhythm 形状", typeof k.hold === "number" && k.rollout === false);
ck("bezierPath 点数", g.bezierPath(0, 0, 100, 100, 4).length === 4);
ck("clickOffset 居中", g.clickOffset().dx === 0);
ck("shouldTypo 关闭", g.shouldTypo() === false);

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
