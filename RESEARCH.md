# 官方资料与原生路径核实

核实日期：2026-10-23。只读取软件源代码和官方公开资料；没有读取真实密钥、聊天正文或运行用户酒馆。

OpenCode 官方：[Go](https://opencode.ai/v2/docs/console/go/)、[Inference API](https://opencode.ai/v2/docs/console/api/inference/)、[条款](https://opencode.ai/legal/terms-of-service)。当前 Chat 端点为 `/inference/go/openai/v1/chat/completions`；公开目录为 `/inference/go/v1/models`。两者基地址不同。官方支持真实第三方客户端标识，要求每会话稳定的 `x-opencode-session`；不需要伪装 OpenCode。普通角色聊天用途未获明确确认。

官方 Go 协议并不统一；Chat、Responses、Anthropic Messages 等有不同端点。本版本仅为已验证的原生 Custom Chat 请求补头，不改变用户选择。目录不提供足以证明每个模型的 tools/vision/reasoning 能力字段，因此不自动开启能力。Go Extra usage 开启时仍可能扣余额，不保证只因 URL 含 Go 就不会额外收费。

## ST 1.18.0

文件 `src/endpoints/backends/chat-completions.js`：

- status 第 1758–1762 行：Custom 读取原生 secret 引用，并将 `custom_include_headers` 合并到 headers。
- status 第 1987–1997 行：给用户基地址追加 `/models`，headers 合并在原生 Authorization 之后。
- generate 第 2304–2321 行：Custom 分支使用同一头合并逻辑。
- generate 第 2576–2585 行：服务端 fetch 发送合并后的头。前端浏览器不能直接指定 UA，并不意味着原生代理不能。
- OpenAI reverse_proxy 分支没有合并 Custom headers；要覆盖它必须改变来源或认证流程，本透明版本明确不做。

`src/util.js` 第 821 行的 `mergeObjectWithYaml` 支持 YAML 对象和对象数组。JSON 映射是可用输入。`public/lib.js` 公开 yaml，`public/script.js` 公开 `SillyTavern.libs`。

`public/scripts/openai.js` 第 4431 行起允许 Custom 跳过状态检查；原生 `custom_model_id` 支持手填模型。目录失败无需把聊天基地址改成目录基地址。

## ST 1.14.0

从 [官方 1.14.0 标签](https://github.com/SillyTavern/SillyTavern/tree/1.14.0)只读取得源文件。`src/endpoints/backends/chat-completions.js` 第 1416、1879 行分别在 status/generate 合并自定义头。实际函数（含该版本非 async 的 generate 包装）已在 mock 环境执行，认证由 fake 原生 secret 完成，扩展不参与取 Key。

## 小白 X

LittleWhiteBox 3.1.9，来源 [RT15548/LittleWhiteBox](https://github.com/RT15548/LittleWhiteBox)。`shared/host-llm/chat-completions/client.js` 使用原生 status/generate，但独立 OpenAI-compatible builder 构造 `chat_completion_source: openai` 与 `reverse_proxy`。两条真实客户端流/非流 mock 测试证明本扩展保持其原样；不宣称已补 UA。

独立 SDK/direct fetch、固定后台调用和 iframe 并非当前页面 Custom fetch，不能用一个透明前端扩展保证全部覆盖。
