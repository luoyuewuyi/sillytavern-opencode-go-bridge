# 接入调查与架构决策

核实日期 2026-10-23。只读参考 ST 1.18.0 与 LittleWhiteBox 3.1.9（RT15548/LittleWhiteBox）。没有访问密钥文件、聊天正文或无关用户数据，没有写入、启动或修改参考安装。所有实现与 mock 在独立开发目录完成；以下路径均相对对应软件根目录，不包含个人路径。

## 用户价值与推荐架构

安装管理员一次性装前后端后，使用者只填自己的 Key；真实 UA、会话头、协议路由由插件承担。推荐 **前端选择/状态面板 + 最窄 fetch 路由 + 酒馆服务端受保护适配器**。

仅前端不能可靠设置受浏览器限制的 User-Agent。仅把原生 Custom URL 改成 Go 也无法透明处理不同模型所用的 Responses/Messages，且钥匙可能进入其他插件和原生调试路径。服务端插件让 Key 留在内存中，并在单一固定域发出请求。前端仅对显式 Go 配置生效，不全局改变非 Go 供应商。

浏览器不能截获后台、iframe、Worker 或已缓存原 fetch 的请求。因此另提供公开 Chat 兼容入口/页面 API；独立插件需要一次性显式接入。未实现独立 sidecar。不能安装服务端组件的托管平台在此发行版中不支持。

## 官方事实与尚未确认的事实

| 项目 | 官方证据/结论 |
|---|---|
| Go 端点 | [Go endpoints](https://opencode.ai/v2/docs/console/go/#endpoints)：当前前缀 `/inference/go`；旧搜索缓存 `/zen/go/v1` 不作为实现依据 |
| Chat | `https://opencode.ai/inference/go/openai/v1/chat/completions` |
| Responses | `https://opencode.ai/inference/go/openai/v1/responses` |
| Messages | `https://opencode.ai/inference/go/anthropic/v1/messages` |
| 模型目录 | `https://opencode.ai/inference/go/v1/models`；匿名只读获取成功，保存公开快照于 evidence |
| 认证 | [Inference API](https://opencode.ai/v2/docs/console/api/inference/)：Bearer Console key；无真实 Key 实测 |
| UA / session | [Go](https://opencode.ai/v2/docs/console/go/) 与 [Harnesses](https://opencode.ai/v2/docs/console/harnesses/)：自己的客户端 UA、按会话稳定的 x-opencode-session；不是伪装官方客户端 |
| 协议差异 | Go 官方目录表逐型号明确协议；GPT/Grok 等 Responses，GLM/Kimi/DeepSeek 等 Chat，部分 Qwen/MiniMax 等 Messages，不能全部送同一个 Chat 端点 |
| 订阅计费 | Go 文档说明 Extra usage 选项；固定 Go URL 不能保证账户没有超额余额扣费。没有自动开关该选项的实现 |
| 用途 | Go 面向 typical coding-agent traffic，第三方客户端可以接入；普通角色聊天是否允许未获得明确确认。遵守 [条款](https://opencode.ai/legal/terms-of-service)，不绕过拒绝 |
| 模型能力 | 公开 models 快照仅有 id/object/created/owned_by，不能据此证明 vision/tools/reasoning；UI 一律 unverified |
| Messages 流事件 | [Anthropic Streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)：内容块、JSON增量、thinking/signature和终止事件 |

数据快照36个 model ID；不是36个均受支持。静态协议表只含核实过的型号，实时目录过滤掉已下线型号；Gemini和未知协议拒绝。支持表是协议证据，不是能力推断。

## 实测源码调用路径

这里“实测”指读取源码并用真实 LWB 客户端构造器接 mock；没有运行现有酒馆。

| 位置 | 观察 |
|---|---|
| `public/scripts/openai.js` sendOpenAIRequest (~3044) | CHAT_COMPLETION_SETTINGS_READY 后 fetch `/api/backends/chat-completions/generate` |
| 同文件 status (~4437) | `/api/backends/chat-completions/status` |
| `public/scripts/custom-request.js` ChatCompletionService.sendRequest (~463) | 相同 generate 路径 |
| `public/scripts/extensions/shared.js` | ConnectionManagerRequestService 使用 ChatCompletionService |
| memory / expressions 扩展文本分支 | generateQuietPrompt / generateRaw / 原生 Chat 路径 |
| caption / translate 专用分支 | 独立后端 endpoint，不能声称全部被当前包装覆盖 |
| `src/endpoints/backends/chat-completions.js` | custom_url、reverse_proxy/proxy_password、供应商转换及调试输出；本插件 Key 不送入该处理器 |
| LWB `shared/host-llm/chat-completions/client.js` (~9,185,228,438) | status/generate 常量、openai reverse_proxy payload、createHostChatCompletionsClient 允许 fetch 注入；6个实际模块测试通过 |
| LWB `modules/agent-core/adapters/openai-compatible.js` (~992,1079) | OpenAI SDK dangerouslyAllowBrowser 以及直接 `${baseUrl}/chat/completions` fetch |
| LWB `modules/story-summary/vector/llm/llm-service.js` (~146) | 直接 fetch，与原生 host 路径不同 |
| LWB `server-plugin/littlewhitebox-server/draw-runs/loopback-host-client.js` | 后台固定原生路由白名单，浏览器无法接管 |

## 安全挂载证据

ST `src/server-main.js` 先设置 cookieSession（~155）和 setUserDataMiddleware（~164），然后设置 CSRF（~168–202，session.csrfToken 和 x-csrf-token），最后在启动阶段 loadPlugins（~313）。`src/plugin-loader.js` 读后端 package.json main，import模块，init(router)，将router挂在 `/api/plugins/<info.id>`（~213）。因此本项目 index.mjs 是由 main 正确加载的，而不是假设只能 index.js。

插件同时再次检查 `req.user.profile.handle`、cookie session CSRF、Origin host、临时token与用户绑定；CSRF缺失直接失败，不要求关闭防护。此顺序是 source-inspected，实际完整 Express 服务器启动仍 live-unverified。不同分支需要重新验证相同中间件契约。

Key和协议历史缓存不落磁盘、不日志输出；临时连接按登录用户和随机浏览器会话隔离。任意已获同源脚本执行权限的扩展仍处于信任边界中，不可能用这些头抵挡恶意同源代码。反向代理/平台全请求体日志策略不由本插件控制，管理员应避免记录含凭据的注册请求。

## 验收边界

已验证协议/安全/取消/DOM事件流程；未执行账号登录、真实收费请求、真实模型能力或供应商用途判定。没有把试验性兼容实现称作全平台上线完成。拒绝访问时只返回脱敏错误，合规替代是使用者向供应商核实用途，或自行选择明确支持该用途的其他服务；本插件不自动把请求转去其他服务。
