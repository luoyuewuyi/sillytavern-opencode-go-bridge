# 开发接口

没有新增 HTTP 接口、后台服务或全局 Key API。扩展安装时调用 `enable()`，原生禁用/删除钩子调用 `disable()`。

运行模块 `routing.mjs` 导出 `installGoHeaders({scope, origin, conversationId, parseYaml, isEnabled, sessions})`，返回 `dispose()`。它包装该 scope 的 fetch，仅修改匹配请求的 `custom_include_headers`。默认 scope 为当前页面。

`createSessionIds()` 生成每页、每聊天的随机 ID；调用方只提供本地聊天标识，正文和名称不作为请求头发出。`addGoHeaders()` 使用宿主 YAML 解析器，不读取密钥 API。非客户端头保持原生语义。

其他扩展要获得自动补头，应使用当前页面的 fetch、酒馆原生 Custom source、官方 Go Chat Base URL 和原生认证机制。独立 OpenAI reverse_proxy 调用会原样通过；它不会因添加 Custom 字段而获得服务端 UA。不要把保留错误码或响应内容的原生行为误认为协议转换。
