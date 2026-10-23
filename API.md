# 扩展适配 API

## 当前页面插件：推荐

用户已在面板连接后：

```js
const abort = new AbortController();
const response = await window.OpenCodeGoBridge.request({
  model: chosenModelId, // 从 await OpenCodeGoBridge.models() 返回的 data 选择
  messages: [{ role: 'user', content: 'Write an add function.' }],
  max_tokens: 256,
  stream: false,
}, { conversation: stableLocalTaskId, signal: abort.signal });
if (!response.ok) throw new Error((await response.json()).error.message);
const completion = await response.json();
// 后续历史请保留整个 assistant message，包含 go_bridge / tool_calls / reasoning_content。
```

`conversation` 必填稳定的本地会话标识，仅用于内存映射，实际上游发送不含标题/正文的随机 UUID。`stream:true` 返回标准 Chat SSE Response；调用方需检查每个事件的 `error`，不能仅凭 HTTP 200 认为生成成功。用 AbortController 取消。`models()` 不验证 Key，只读公开目录。`dispose()` 清理临时会话、恢复配置并移除本扩展 fetch 包装，远端撤销失败仍先清理本地。

## 后台或独立集成

本版本仅提供酒馆插件内的同源兼容入口，不监听额外端口，不提供开放 CORS，也不是只用一个 Bearer Key 就能访问的公共代理。

基路径 `/api/plugins/opencode-go-bridge`。每次需要：

- 酒馆当前用户登录会话 cookie。
- `X-CSRF-Token`：酒馆当前会话 token。
- `x-st-go-client: 1`。
- 推理/撤销再带 `x-st-go-token`：连接时随机生成的临时令牌，绑定该酒馆用户。
- 推理还带 `x-opencode-session: stgo_<20–80位字母数字下划线短横线>`，按会话稳定、随机、不包含用户名称或聊天内容。

| 方法 | 路径 | 请求 |
|---|---|---|
| POST | `/status` | `{}`，匿名公开模型目录经服务端缓存，仍要求酒馆身份/CSRF |
| GET | `/v1/models` | 与 status 相同，返回含 protocol/capabilities 的目录 |
| POST | `/session` | `{ "key": "使用者自己的Key", "usageAcknowledged": true }`，返回 token/expires |
| DELETE | `/session` | 无 body，撤销自己的 token |
| POST | `/v1/chat/completions` | 标准 Chat JSON 子集，自动选官方协议 |
| POST | `/generate` | 前端内部封装 `{payload,native,sessionId}`，普通扩展优先用兼容入口 |

后台插件若固定路径/认证方式而不可改配置，需要其开发者接入这些接口；不能把临时令牌当原始 Go Key 传给第三方服务。不要让后台请求借用其他用户的会话。浏览器 API 可复用当前临时连接，后台集成可为该用户注册自己的内存会话；这属于安装后的集成配置，不由本包自动替其他扩展完成。

## 保真与错误

请求上限8MiB；每令牌最多4个进行中请求、最长5分钟；最多64个临时连接/每用户8个；最长8小时TTL，60秒清理巡检，访问时也检查过期。平台自身 body-parser 限制可能更严格，本插件的 JSON 上限在解析后检查。

SSE事件上限1MiB；转换流总量16MiB。解析错误、未知内容、上游错误、缺少终结、socket断流均返回脱敏 `go_stream_error`；调用者仍必须识别连接自身中断。Responses 最终结果与已输出增量不一致会失败。Messages 检查块结束和停止原因。结束标记会关闭上游读取。

不保真字段返回 `conversion_unsupported`，例如 Messages 的 strict tools、Responses 的非零 frequency_penalty、未知消息内容。某些跨协议中性的默认值（例如 n=1、penalty=0）可以省略。拒绝丢失思考签名；原始 `go_bridge` 与编辑后的可见文本/工具或显式思考冲突会报错。缓存恢复仅当前临时连接有效，最多128条/4MiB；重复可见回答对应不同元数据时拒绝猜测。

HTTP认证/上游拒绝保留状态但不透传原始响应正文或头；不会记录 Key、消息或上游 body。固定 opencode.ai Go URL、禁止重定向，不接受用户指定任意上游域。图片 URL 只传给 Go，本服务器不主动下载图片；上游是否接受图片由模型决定。
