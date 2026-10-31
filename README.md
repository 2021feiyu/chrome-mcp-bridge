# Chrome MCP Bridge

**Drive your already-logged-in Chrome from any MCP client — no separate profile, no re-login, no cookie export.**

通过一个 Chrome 扩展 + 本地 MCP server，把**你正在用的那个浏览器标签页**接进任意 MCP 客户端：`click` / `type` / `snapshot` / `screenshot` / `eval` / 网络与 Cookie 读取，全部作用在真实登录态上。

```
MCP client ──stdio──► chrome-mcp-bridge ──WebSocket:9223──► Chrome 扩展 ──chrome.debugger──► 你的标签页
```

---

## 为什么需要它

从 **Chrome 136** 起，`--remote-debugging-port` 与默认用户目录同时使用时会被**静默拒绝**——端口不监听、不报错。加上"调试端口只在进程创建时生效"，外部进程从此无法接管一个已经在运行的 Chrome。

Playwright / Puppeteer 的常规解法是**另起一个干净 profile**：没有登录态、没有插件、没有你攒了两年的书签。

本项目的解法是让**浏览器内部**的扩展去调 `chrome.debugger`——这是浏览器给自己开的调试权限，不受"外部进程不能 attach"这条策略限制。这也是 BrowserMCP、Playwright MCP 等方案共同采用的架构；区别在于本项目的扩展是**开源、可改**的。

---

## 它提供什么

**74 个 MCP 工具**，按用途分组：

| 组 | 工具 |
|---|---|
| 连接与标签页 | `bridge_status` `tabs_list` `tab_attach` `tab_select` `tab_create` `tab_close` `tabs_batch` |
| 导航 | `navigate` `go_back` `go_forward` `reload` |
| 读取页面 | `snapshot` `get_page_text` `eval` `get_meta_tags` `get_forms` `get_images` `get_selected_text` `get_page_dimensions` `extract` `extract_aria_snapshot` |
| 交互 | `click` `click_at` `type` `type_human` `press_key` `hover` `drag` `select_option` `scroll` `scroll_into_view` `focus` `upload_file` |
| 等待 | `wait` `wait_for_selector` `wait_for_text` `wait_for_url` `wait_for_function` `wait_for_load` `wait_for_selector_gone` |
| 截图 | `screenshot`（支持整页、区域裁剪、jpeg 质量） |
| Cookie / 存储 | `get_cookies` `set_cookie` `delete_cookie` `storage_get` `storage_set` |
| 调试 | `console_start` `console_logs` `console_errors` `network_start` `network_logs` `network_stop` `inject_css` `highlight_element` |
| 下载 | `download_file` `download_list` |
| 批量 / 逃生舱 | `batch` `cdp` `cdp_batch` `ext_reload` |
| 安全守卫 | `guard_stats` `guard_config` `guard_selftest` |

几个可靠性设计：

- **`snapshot`**：返回页面可见交互元素（带 `ref` 与坐标），比截图更适合让模型"看懂"页面。
- **`op_status` / `opId`**：动作超时不等于失败。每个动作有唯一 `opId`，超时后可以用 `op_status` 查真实结果，避免"重试 = 重复点击"。
- **`batch`**：一串动作一次下发，省掉逐条往返。
- **`type_human`**：逐字符发送键盘事件，兼容带输入防抖 / 联想下拉 / 只听 `keydown` 的表单；中文自动走 `insertText` 插入，不丢字。

---

## 安装

### 1. 启动 server

```bash
cd server
npm install
npm run build
node dist/index.js
```

看到 `[bridge] MCP server 就绪，等待扩展连接 ws://127.0.0.1:9223` 即成功。这个进程要常驻。

### 2. 加载扩展

1. 打开 `chrome://extensions`
2. 打开右上角「开发者模式」
3. 「加载已解压的扩展程序」→ 选择本仓库的 `extension/` 目录
4. 把 **Chrome MCP Bridge** 固定到工具栏

### 3. 连接

1. 打开你要操作的网页
2. 点工具栏图标 → 「连接到 MCP server」
3. 图标变绿 `ON` 即接管成功（只接管你主动连接的那个标签页）

### 4. 配置 MCP 客户端

```json
{
  "mcpServers": {
    "chrome-mcp-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/chrome-mcp-bridge/server/dist/index.js"],
      "env": { "BRIDGE_PORT": "9223" }
    }
  }
}
```

健康检查（只读，不占用连接）：

```bash
curl http://127.0.0.1:9223/status
# {"connected":true,"port":9223,"clients":1}
```

---

## 安全边界

扩展跑在**你自己的登录态**里，所以默认是"多限制、少放行"：

| 约束 | 行为 |
|---|---|
| **敏感动作拦截** | 命中"发布 / 支付 / 删除 / 授权"等词的动作**默认拒绝**，需显式 `guard_config { unlockSensitive: true }` 临时解锁 |
| **同域限速** | 60 秒窗口内单域名动作数上限（默认 40 次、导航 8 次），超限直接报错而不是静默排队 |
| **夜间静默** | 可选：指定时段内不执行任何动作 |
| **只读工具免计费** | `snapshot` / `get_page_text` / `eval` 等只读工具不占用限速配额 |
| **一个标签页** | 只操作你点过"连接"的那个标签页；切换标签需重新 attach |

`guard_stats` 可以随时看累计拦截数、限速次数、当前是否夜间静默；`guard_selftest` 会在真实扩展环境里跑一遍拦截逻辑，确认守卫真的生效而不是配置写了没跑。

> 本项目**不做**输入伪装（不模拟人类打字节奏、不生成鼠标抖动、不注入错字）。它只约束"做什么"和"多频繁"，不试图规避站点的人机识别。请自行确认目标站点的使用条款。

---

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `bridge_status` 报"扩展未连接" | server 没开 / 扩展没点连接 | 先启 server，再点扩展连接 |
| 扩展 popup 一直"连接中…" | 端口被占用 | `netstat -ano \| findstr 9223`，关掉占用进程或改 `BRIDGE_PORT` |
| `Another debugger is already attached` | 该标签页开着 DevTools | 关掉 F12 再连 |
| `Cannot access a chrome:// URL` | 当前是浏览器内部页 | 先 `navigate` 到 http(s) 页面 |
| 扩展约 30 秒后掉线 | MV3 service worker 被回收 | 已用「心跳 + `chrome.alarms` + 监听器顶层注册」三重保险；仍频繁掉线请查 popup 里的 Service Worker 日志 |

---

## 与同类方案

| 方案 | 扩展源码 | 备注 |
|---|---|---|
| BrowserMCP | ❌ 闭源（只发商店） | 成熟、社区大；想改内部行为做不到 |
| Playwright MCP | ✅ | 需要完整 Playwright，另起浏览器上下文 |
| **本项目** | ✅ MIT | 轻量（一个扩展 + 一个 Node server），接管真实标签页，工具面更宽 |

---

## 目录结构

```
extension/            Chrome MV3 扩展
  background.js       service worker：WS 连接、CDP 分发、snapshot、点击/输入
  guard.js            安全守卫：同域限速 + 敏感动作拦截 + 夜间静默
  popup.html/js       连接状态与守卫面板
server/
  src/index.ts        MCP server：74 个工具定义
  src/bridge.ts       WebSocket 桥（含 /status 只读端点）
  src/media.ts        截图 / 媒体处理
tests/
  guard.test.mjs      守卫逻辑自测（不需要浏览器）
```

```bash
npm test        # 9 项断言：拦截 / 放行 / 静默 / 限速
```

---

## License

MIT
