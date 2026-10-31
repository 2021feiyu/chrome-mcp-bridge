const dot = document.getElementById("dot");
const btn = document.getElementById("btn");
const sServer = document.getElementById("s-server");
const sTab = document.getElementById("s-tab");
const sUrl = document.getElementById("s-url");

// 守卫面板元素
const gEnabled = document.getElementById("g-enabled");
const gDelay = document.getElementById("g-delay");
const gMouse = document.getElementById("g-mouse");
const gRate = document.getElementById("g-rate");
const gSensitive = document.getElementById("g-sensitive");
const gStats = document.getElementById("g-stats");

const pill = (on, textOn = "开启", textOff = "关闭") =>
  `<span class="pill ${on ? "on" : "off"}">${on ? textOn : textOff}</span>`;

/** 渲染守卫面板（直接向 background 请求，不走 server） */
function renderGuard() {
  chrome.runtime.sendMessage({ type: "guard_snapshot" }, (res) => {
    if (!res || !res.ok) {
      gEnabled.textContent = "不可用";
      return;
    }
    const { config: c, stats: s } = res;
    gEnabled.innerHTML = pill(c.enabled);
    gDelay.textContent = c.enabled ? `${c.delayMin}–${c.delayMax} ms` : "—";
    gMouse.innerHTML = pill(c.mousePath, `${c.mouseStepsMin}–${c.mouseStepsMax} 段`, "关闭");
    gRate.textContent = c.enabled ? `${c.rateMaxActions}/min（导航 ${c.rateMaxNav}）` : "—";
    gSensitive.innerHTML = c.blockSensitive
      ? (s.sensitiveUnlocked
          ? `<span class="pill off">已解锁</span>`
          : pill(true, `${c.sensitivePatterns.length} 类拦截`))
      : pill(false);
    gStats.textContent = `${s.blocked} / ${s.throttled}`;
  });
}

function render(st) {
  if (!st) return;
  const { connected, attachedTabId, desired } = st;

  if (connected && attachedTabId != null) {
    dot.className = "dot on";
    sServer.textContent = "已连接";
    sTab.textContent = "#" + attachedTabId;
    btn.textContent = "断开";
    btn.className = "off";
  } else if (desired) {
    dot.className = "dot wait";
    sServer.textContent = connected ? "已连接" : "连接中…";
    sTab.textContent = attachedTabId != null ? "#" + attachedTabId : "—";
    btn.textContent = "断开";
    btn.className = "off";
  } else {
    dot.className = "dot";
    sServer.textContent = "未连接";
    sTab.textContent = "—";
    btn.textContent = "连接到 MCP server";
    btn.className = "";
  }

  // 查当前标签页 URL
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    if (tabs[0]) {
      try { sUrl.textContent = new URL(tabs[0].url).hostname; } catch (_) { sUrl.textContent = "—"; }
      sUrl.title = tabs[0].url;
    }
  });
}

function refresh() {
  chrome.runtime.sendMessage({ type: "get_state" }, (res) => {
    if (res && res.state) render(res.state);
  });
  renderGuard();
}

btn.addEventListener("click", async () => {
  const st = await chrome.runtime.sendMessage({ type: "get_state" });
  const isOn = st && st.state && st.state.desired;
  const res = await chrome.runtime.sendMessage({ type: isOn ? "disconnect" : "connect" });
  if (res && res.state) render(res.state);
  setTimeout(refresh, 400);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "state") render(msg.state);
});

refresh();
setInterval(refresh, 2000);
