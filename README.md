# OpenCode Go Bridge for SillyTavern — 0.2.0 Preview

一个可独立分发的前端扩展 + 酒馆服务端插件。安装完成后，在扩展面板输入使用者自己的 Console API Key，即可创建独立 Go 连接；服务端自动添加真实的客户端 User-Agent 和稳定会话头。不会要求使用者手写请求头。

支持把酒馆 Chat Completions 请求转换为 Go 的 **Chat、Responses、Anthropic Messages** 协议，包含流式/非流式、函数工具、输入图片结构、思考元数据、取消和错误。各模型是否支持某能力仍取决于官方服务，不根据名称盲目开启。

**这是预览版：mock 测试通过，不等于已使用真实订阅联调。** 不内置密钥、不共享订阅、不持久保存 Go Key、不自动回退按量端点。不能承诺拦截其他插件的所有独立请求。

## 使用边界

- 官方 Go 定位典型 coding-agent 流量，并支持第三方客户端使用自己的身份头。普通酒馆角色聊天没有取得明确官方用途许可。本插件不伪装 OpenCode、Cursor 等客户端，不改变请求性质、不绕过拒绝；使用者应先核实用途。面板勾选说明不是官方授权。
- 即使始终调用 Go 地址，账户若开启 **Extra usage**，超额仍可能消耗余额。本插件不能关闭或检测该账户开关，也不会代为开启，不能保证绝不额外计费。
- 需要能安装服务端插件的 SillyTavern Node 服务。浏览器扩展不能可靠设置 User-Agent；**只安装前端不能完成接入**。
- 用户同源安装的扩展与酒馆服务管理员处于同一信任边界。仅安装可信扩展；这里没有为恶意同源 JavaScript 提供隔离沙箱。

依据：[Go 官方文档](https://opencode.ai/v2/docs/console/go/)、[Inference API](https://opencode.ai/v2/docs/console/api/inference/)、[服务条款](https://opencode.ai/legal/terms-of-service)。核实日期：2026-10-23。

## 从 GitHub 安装（无需拆 ZIP）

仓库：<https://github.com/luoyuewuyi/sillytavern-opencode-go-bridge>。这是 **0.2.0 Preview**；发布许可尚未选定，公开可见不等于授予开源再分发许可。

推荐管理员一次运行完整安装脚本。已有 Git 和 Node >=20，不下载或安装依赖；先查看 dry-run，再执行并输入提示的完整目标路径确认：

**macOS / Linux**

```sh
git clone https://github.com/luoyuewuyi/sillytavern-opencode-go-bridge.git
cd sillytavern-opencode-go-bridge
sh install.sh --st-root "/path/to/SillyTavern" --dry-run --enable-server-plugins --expect-version 0.2.0
sh install.sh --st-root "/path/to/SillyTavern" --enable-server-plugins --expect-version 0.2.0
```

**Windows PowerShell**

```powershell
git clone https://github.com/luoyuewuyi/sillytavern-opencode-go-bridge.git
cd sillytavern-opencode-go-bridge
.\install.ps1 --st-root "C:\SillyTavern" --dry-run --enable-server-plugins --expect-version 0.2.0
.\install.ps1 --st-root "C:\SillyTavern" --enable-server-plugins --expect-version 0.2.0
```

如果执行策略不允许运行 `.ps1`，不必降低系统策略：用 `node install/install.mjs` 替换 `.\install.ps1`，参数保持相同。脚本不会运行提权或修改执行策略。

将示例路径换成安装者自己的酒馆根目录。`--enable-server-plugins` 是对唯一配置改动的显式许可：必要时把 `config.yaml` 顶层 `enableServerPlugins` 设为 true，先保存原文件。已启用则不改配置。真正写入还会要求输入完整目标路径；自动化可审阅 dry-run 后使用 `--confirm-root "同一完整路径"`。不自动改网络、权限、认证、CSRF、其他插件或任何 Key，也不重启酒馆。

完成后管理员自行重启酒馆、刷新页面，在 **OpenCode Go Bridge** 面板填写自己的 Key，点击“连接”。自动创建 Go 配置及恢复快照；正常使用无须再手写头部或复制 Key 到酒馆普通 API 框。仅安装前端不会完成后端接入。

### 用酒馆“安装扩展”按钮

把仓库 URL 粘贴到酒馆扩展安装器即可拉取前端；`manifest.json`、`index.js` 位于仓库根。随后管理员进入该扩展的 Git 目录，执行：

```sh
node install/install.mjs --st-root "/path/to/SillyTavern" --backend-only --enable-server-plugins --dry-run
node install/install.mjs --st-root "/path/to/SillyTavern" --backend-only --enable-server-plugins
```

`--backend-only` 保留由酒馆管理的前端 Git 目录；脚本不会覆盖或搬走它。若无管理员/服务器插件权限，本发行版不能只靠浏览器完成接入。

完整安装只写入两个专属目录，以及有需要且获显式许可时的配置项：

```text
public/scripts/extensions/third-party/sillytavern-opencode-go-bridge/
plugins/opencode-go-bridge/
.opencode-go-bridge-installer/   # 专属备份、事务记录、短期安装锁
```

更多更新、回滚、卸载和容器说明见 [INSTALL.md](INSTALL.md)。不要同时保留两个不同目录的前端副本；若此前手动安装了 0.1.0，请先断开并禁用旧前端，再由管理员检查旧目录。

### 自动连接的版本条件

需要酒馆 Connection Manager、公开命令接口及 `SillyTavern.getContext()`；只读参考版本为 ST 1.18.0。自动路径拒绝当前预设中的自定义 YAML 和提示词后处理。若接口缺失，取消自动创建，手动建干净的 Chat Completion → Custom 连接，URL 使用 `https://opencode-go.invalid/v1`，普通 Custom API Key 保持空。该保留域名只作专用路由标记，禁用扩展后不会转去其他付费服务。

## 日常使用和恢复

- 已选模型由调用方保留；面板模型是缺失模型时的默认值，首次自动创建时也使用它。更改已有主聊天模型请用酒馆模型选择器/Go 连接配置。
- 思考默认保留调用方设置，未指定时采用上游默认。可选“上游默认”清除显式思考参数，或手填官方支持的 `reasoning_effort`。不声称所有模型支持相同档位。
- Go Key 只在服务端内存，浏览器只留随机临时令牌；每个浏览器页面连接独立，绑定酒馆登录用户，最长 8 小时。刷新会丢失本地令牌，旧服务端会话到期清理；主动断开会立即撤销并取消进行中请求。
- 网络断开导致撤销未确认时，仍清理本地状态并尝试恢复，明确提示服务端可能保留到 TTL。服务重启会清空全部内存会话。
- 流式错误通过 `error` 事件返回，随后结束；普通 HTTP 错误只显示脱敏状态。没有自动重试、身份伪装、计费回退。
- signed/encrypted reasoning 通过 `go_bridge` 元数据原样往返。对于丢弃扩展字段的酒馆客户端，服务端只在同用户临时连接、会话、模型和可见内容精确匹配时恢复；编辑或歧义会明确拒绝。刷新、过期、历史编辑、切模型时不能保证恢复先前思考签名，需要原始元数据或新会话。

## 其他插件

走当前页面 `fetch('/api/backends/chat-completions/generate')` 且明确选择 Go URL 的调用自动接入，包括已测试的 LittleWhiteBox Host Client 请求构造。其他供应商的请求保持原样。

独立插件优先使用 `window.OpenCodeGoBridge.request(...)`，示例见 [API.md](API.md)。可选实验开关只接管当前页面直接发往官方 Go Chat URL 的 fetch；不拦截任意 URL、后台 HTTP、iframe、Worker、已捕获旧 fetch 的客户端。后台插件若其代码/设置允许，需要一次性适配同源兼容端点、酒馆登录 cookie、CSRF 和自己的临时令牌。固定原生路由且无法配置的插件需要上游插件改造，不能宣传零配置覆盖。

## 开发与交付

源码包中：仓库根目录前端，`server/` 后端，`tests/` 自动化测试，`evidence/` 测试记录和匿名公开目录快照。Node >=20；验证环境 Node 22.23.1。无需安装依赖：

```sh
node --test tests/*.test.mjs
node scripts/prepare-release.mjs
node scripts/build.mjs
```

构建输出两个 ZIP 和对应版本的 `SHA256SUMS-<版本>`。构建白名单排除依赖目录、个人路径、运行配置和凭据。源码测试中只有明确标记的假 Key。

详细参见 [兼容矩阵](COMPATIBILITY.md)、[API](API.md)、[调查记录](RESEARCH.md)、[测试与审查](TESTING.md)、[变更记录](CHANGELOG.md)。许可尚未选定；非 OpenCode 或 SillyTavern 官方产品。
