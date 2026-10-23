# 验证记录

0.3.0 为透明补头预览版，所有凭据和消息均为合成 fixture。没有真实 Go Key 推理，没有启动/安装/写入用户酒馆，没有安装依赖。

## 本地验证

- **32/32** 便携自动化测试：真实 index.js 安装即生效且无 DOM/网络/设置写入；精确 Go URL；非 Go 同一调用参数对象原样传递；原生认证头保留；YAML 合并契约；状态/聊天会话；多聊天/多标签隔离；Request 与 URL、替换正文、AbortSignal；原 Response/SSE 字节与错误原样返回；禁用恢复。
- **ST 1.18.0：7/7**；**ST 1.14.0：7/7**。从源文件提取实际路由函数、实际 mergeObjectWithYaml，注入 mock fetch、fake secret 和辅助依赖。不启动服务器。验证真正发出的 UA/session/原生认证和 URL。使用现有 YAML 软件模块额外验证真实 YAML 解析。
- **LittleWhiteBox 3.1.9：2/2**。加载实际 Host OpenAI 客户端模块，在 mock fetch 上验证流/非流透传；这证明不干扰，不代表该 OpenAI 分支支持补头。
- 独立审查发现的四处问题均已修复并回归：异步正文读取取消、切聊天竞态、混合大小写 session 顺序、已消费 Request 的替换正文。

总计 **48 次测试通过**（32 + 7 + 7 + 2；两版本的公共测试有重复覆盖）。普通测试命令：

```sh
node scripts/test.mjs
node scripts/build.mjs
```

只读源码参照测试使用环境变量 `ST_REFERENCE_ROOT` 指向官方源码目录，运行 `node --test tests/native-reference.mjs`。可选 `ST_YAML_MODULE` 指向已有 YAML 模块；没有提供时使用 JSON 解析 mock，跳过真实 YAML 专项。`LWB_REFERENCE_ROOT` 指向合法取得的 LWB 源码，运行 `node --test tests/local-reference.mjs`。不从这些目录读取配置或用户数据。

CI：Node 20/22 × Ubuntu/macOS/Windows 运行便携测试和打包；另对官方 ST 1.14.0 / 1.18.0 稀疏源码检出执行 JSON 输入的原生路由测试（每版本 6 项通过，真实 YAML 专项跳过）。无 npm install。

## 仍未实测

完整浏览器中的真实酒馆 UI、真实 Go 订阅/认证/计费/模型推理、容器或托管平台部署，以及全部第三方扩展。源代码与 mock 验证不能替代上述 live 验证。原生代理中间件/CSRF/重定向继续由宿主管理，本扩展没有新增服务端接口。
