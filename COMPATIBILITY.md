# 兼容范围

## 路径矩阵

| 原生调用 | 匹配地址 | 处理 |
|---|---|---|
| Custom `/api/backends/chat-completions/generate` | `https://opencode.ai/inference/go/openai/v1`，可有一个末尾 `/` | 只补 UA/session |
| Custom `/api/backends/chat-completions/status` | 上述地址或 `https://opencode.ai/inference/go/v1` | 只补 UA/session；地址不变 |
| OpenAI + `reverse_proxy`，包括小白 X 独立 Host OpenAI 客户端 | 任意 | 原样透传；ST 该分支不使用 Custom 请求头 |
| Claude / Responses / Gemini 等其他来源 | 任意 | 原样透传，未支持补头 |
| 直接浏览器请求 Go、后台、iframe、Worker、旧 fetch 引用 | 任意 | 不自动覆盖 |
| Zen 按量、旧 `/zen/go/v1`、其他域名/近似域名、含查询或片段的地址 | 任意 | 原样透传 |

只匹配当前页面同源的上述两个酒馆路由，POST JSON、`chat_completion_source: custom`。不支持把完整 `/chat/completions` URL 填入 Base URL。不会改变其他供应商请求的参数、外层请求头或正文。

模型目录与聊天基地址不同。透明补头不会纠正原生服务器的路径拼接。选择当前官方文档中的 Chat 模型并在原生栏手工填写模型 ID；不把 Responses/Messages 模型当成 Chat，也不自动筛除/替换用户的模型。

## 版本与环境证据

| 范围 | 已验证 | 未验证 |
|---|---|---|
| ST 1.14.0 | 官方标签源码，实际 Custom status/generate 函数及 mergeObjectWithYaml 在隔离 mock 环境执行 | 完整浏览器 UI、真实 Go 推理、真实部署 |
| ST 1.18.0 | 只读源码，同样实际路由函数与头合并 mock；公开 YAML 库与 Custom 手填模型/跳过状态检查代码 | 完整运行环境安装、真实 Go 推理 |
| 小白 X 3.1.9 | 实际 Host OpenAI 客户端模块流/非流透传测试，明确其不是 Custom 分支 | 其他模块、背景任务、独立 SDK 的 Go 补头 |
| 其他 ST 版本/分支 | 相同原生接口可能适用 | 未测试，不承诺全版本 |
| macOS / Windows / Linux | 便携 Node mock 可在 CI 运行 | 对应平台真实酒馆安装 |
| Docker / 托管 | 架构无需额外服务端插件 | 平台需允许前端扩展及 Custom 外连，限制各异 |

Headers 的 YAML 对象及对象数组通过酒馆已有 YAML 解析器读取，再按原生合并语义输出 JSON（合法 YAML）。除两个客户端头外全部保留；已有 UA 会改为真实扩展 UA。已有 session 若满足 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` 则保留，混合大小写重复项按输入顺序取最后项；无效值替换为随机 ID。格式错误仅对匹配的 Go 请求报错，不打印输入头。

同一页面内按群组、角色和聊天 ID 区分会话，只有随机值发送给 Go。未打开聊天时使用独立页面 ID；多个无聊天后台式任务无法从原生请求中可靠区分。页面刷新会重新生成，跨标签页不会共享映射；原调用方可提供稳定合法 session 以跨刷新延续。

本扩展不读酒馆 secrets 接口、没有 Key 输入框、没有日志输出、不新设 Authorization。原生认证、CSRF、网络代理、重定向、请求体限制、错误和取消行为继续由酒馆负责。SSE 原 Response/字节流直接返回，原生错误也不包装成成功；不能承诺改变某个酒馆版本自身的流错误处理。

思考、工具和图片字段在浏览器原生请求中保持原值；酒馆本身仍可能按模型/来源筛选字段。本扩展不补造这些能力，不承担协议适配器的职责。
