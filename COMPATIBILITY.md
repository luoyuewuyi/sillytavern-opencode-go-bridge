# 兼容矩阵

状态含义：**tested/mock** = 自动化夹具通过；**source-inspected** = 只读确认实现路径；**live-unverified** = 未在实际服务/账号执行。这里没有任何真实账号推理验证。

| 环境/路径 | 实现范围 | 证据与限制 |
|---|---|---|
| ST 1.18.0 主聊天 | Go 专用 Custom / OpenAI reverse_proxy 经过当前页面 fetch 到同源插件 | source-inspected + tested/mock；真实启动 live-unverified |
| ST ChatCompletionService / ConnectionManagerRequestService | 同原生 generate/status 路径 | source-inspected + tested/mock 请求形状；未枚举全部扩展 |
| 记忆扩展 generateQuietPrompt/generateRaw、文本表情分类 | 使用当前原生 Chat 连接的分支可接入 | source-inspected；全部功能组合 live-unverified |
| LittleWhiteBox 3.1.9 Host Client | 原生 generate/status；三协议流/非流工具输出 | 真实客户端源模块 + mock 上游，6 个测试；不是运行 LWB UI |
| LWB OpenAI SDK / vector 直接 fetch | 明确 Go Chat URL、当前页面 fetch 且启用实验开关，或公开 API | Request/string mock；SDK 捕获旧 fetch、独立 realm 不保证覆盖 |
| LWB 后台 loopback client | 浏览器路由无法接管 | 源码固定原生路径；需该插件提供适配接口或修改自身后台，不会自动生效 |
| 图像描述专用 endpoint、翻译专用 endpoint | 不接管不同的后端路由 | 可由扩展作者接公开 API；不等于全酒馆模型入口 |
| 桌面 Node、可写插件目录的 VPS | 架构支持前后端分装 | 安装者自行启用/重启；实际安装 live-unverified |
| Docker/Podman | 架构支持挂载后端 plugins 和前端目录 | 容器内 Node>=20、权限、持久卷、TLS/代理需安装者配置；live-unverified |
| 托管平台允许服务器插件 | 条件支持 | 须有认证、CSRF、Node fetch/Web Streams 和管理员安装权限 |
| 只准浏览器扩展的托管平台、静态网页 | 本发行版不支持 | 无法靠浏览器设置真实 UA，也没有已实现的独立 sidecar |
| 其他酒馆版本/分支 | 运行时检测，缺少接口则拒绝或手动配置 | 不承诺支持全部旧版本；req.user/profile、req.session.csrfToken 改动需适配 |

安装脚本及平台验证另见 [INSTALL.md](INSTALL.md) 和 [TESTING.md](TESTING.md)；仓库根 manifest 支持 Git 扩展安装器，后端仍需管理员脚本。

## 协议能力（转换能力不等于模型能力）

| 功能 | Chat | Responses → Chat | Messages → Chat |
|---|---|---|---|
| 非流式 / SSE | tested/mock | tested/mock | tested/mock |
| 工具定义、调用、结果往返 | 原样保留 | function_call / function_call_output | tool_use / tool_result |
| 工具流、空参数 `{}` | 原样保留 | 增量并核验完整结果 | 增量，空参数补合法 JSON |
| 图片输入 | 原样保留 | input_image 保留 URL/detail | HTTPS URL 或 base64 image；非 auto detail 拒绝 |
| 思考输出/历史 | reasoning_content 原样 | summary + encrypted_content 元数据 | thinking/signature/redacted 元数据 |
| 思考设置 | 调用方值/默认 | reasoning.effort | thinking / output_config.effort；上游可拒绝 |
| 取消/超时/错误 | tested/mock | tested/mock | tested/mock |
| schema 输出 | 传递 | text.format | 明确拒绝不能保真的 response_format |
| strict tools | 传递 | 传递 | 当前转换明确拒绝 |
| 特定模型 vision/tools/reasoning | **unverified** | **unverified** | **unverified** |

通用不支持：Gemini 协议、音频、图片生成、内置 web-search、legacy functions/function_call、自定义 YAML 覆盖、原生提示词后处理。模型选择仅为实时 Go 目录与已核实协议映射的交集；新增/协议变化需要更新映射，不能从名称推断。

没有按量回退，不代表账户 Extra usage 不会扣款。403/429 不触发客户端伪装、换域或重试。
