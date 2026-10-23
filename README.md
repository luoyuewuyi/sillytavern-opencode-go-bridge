# OpenCode Go Headers · 0.3.0 Preview

**酒馆纯前端扩展：安装后照常在酒馆原生连接设置里填地址、Key 和模型。**

扩展只给 OpenCode Go 的原生 Custom 请求补真实客户端 UA 和会话头。没有独立 Key 面板，不保存或读取酒馆密钥，不创建或切换连接预设；使用其他供应商时保持原请求不变。

## 安装与使用

1. 酒馆 → 扩展 → 安装扩展，粘贴：
   ```text
   https://github.com/luoyuewuyi/sillytavern-opencode-go-bridge
   ```
2. 安装后刷新页面，在酒馆原生连接设置选择 **Chat Completion → Custom / 自定义兼容接口**。
3. Base URL 填 `https://opencode.ai/inference/go/openai/v1`，在原生 **Custom API Key** 输入自己的 Key，模型栏填写官方支持 **Chat Completions** 的模型 ID，例如 `glm-5.2`，然后连接。

不需要终端、安装脚本、额外后端或第三方代理。扩展不会自动填写或改变上述设置。普通 OpenAI「反向代理」连接不是本扩展支持的 Custom 路径。

**模型下拉列表为空时，直接在原生“Enter a Model ID / 输入模型 ID”栏填写。** Go 模型目录在 `/inference/go/v1/models`，而原生 Custom 通常给聊天基地址追加 `/models`；本扩展不改地址，因此不保证下拉目录成功。ST 1.18 的 Custom 模式允许跳过状态检查，目录失败不等于聊天端点失败。不要把目录基地址当作聊天 Base URL。

## 扩展会做什么

- 仅匹配当前页面发往酒馆原生 `generate` / `status` 的 **Custom** 请求，以及下方文档列出的精确 Go URL。
- 将 `User-Agent` 设为真实扩展名 `sillytavern-opencode-go-bridge/0.3.0`。
- 自动生成不含聊天内容/名称的随机 `x-opencode-session`。同一页面会话中的同一聊天、重试及辅助请求保持一致；切换聊天使用不同 ID。刷新页面会开始新的 ID 生命周期。
- 保留已有合法会话头，保留其他自定义头和 Authorization，认证仍完全由酒馆处理。
- 不改模型、思考参数、工具、图片、正文或响应流。不强行开启模型能力，不转换协议。

## 已验证与限制

**已做 32 项便携 mock 测试，以及 ST 1.14.0 / 1.18.0 原始路由函数和头合并逻辑的隔离测试。尚未用真实 Go Key 推理，也未在运行中的酒馆安装验证。**

- 当前验证范围：Custom → Go **Chat Completions**。Responses、Anthropic Messages、Gemini 不宣称支持。
- 同页面扩展若继承当前 Custom 设置并走相同原生接口，可一起补头。小白 X 3.1.9 的独立 Host OpenAI / `reverse_proxy` 路径、后台、iframe、Worker、缓存旧 fetch 的调用不自动覆盖。扩展不会为了覆盖它们而替换认证或接管配置。
- 桌面、容器和托管酒馆均需要允许第三方前端扩展、保留原生 Custom 代理、服务器能够访问 Go；无需允许服务端插件。受限平台或修改过原生接口的分支需另测。
- 官方当前 `/inference/go/...` 路径在白名单内；旧 `/zen/go/v1` 尚未核实，原样透传。Zen 按量端点和其他供应商也不补头。

[OpenCode Go 官方说明](https://opencode.ai/v2/docs/console/go/)要求客户端使用自身 UA、稳定会话标识和典型编程代理流量；普通角色聊天用途未得到明确确认。本扩展不伪装受限客户端，不绕过拒绝。账户若开启 **Extra usage**，超限仍可能扣余额；扩展不改变账户开关，也不会切换到按量端点。

详细信息：[兼容范围](COMPATIBILITY.md) · [卸载与升级](INSTALL.md) · [源码依据](RESEARCH.md) · [测试](TESTING.md)。旧架构保留在 `v0.2.0-preview` 标签；主分支无需旧服务端组件。
