# 测试状态 · 0.2.0 Preview

本地验证：Node 22.23.1，零依赖安装、零真实Key/推理调用。未启动或安装到任何既有酒馆。

- **89/89 portable tests 通过**：`node scripts/test.mjs`。其中21项是安装器合成夹具，其余68项是协议、身份、路由与面板mock。
- **6/6 LittleWhiteBox 3.1.9 真实 Host Client 源模块 + mock 上游通过**：三个协议各自流式和非流式工具输出；不代表运行LWB UI。第三方源码不随仓库分发。
- GitHub Actions 在 Ubuntu、macOS、Windows × Node20/22 运行portable测试和构建：[本仓库 Actions](https://github.com/luoyuewuyi/sillytavern-opencode-go-bridge/actions)。以具体commit的绿色结果为准。

| 范围 | 已验证内容 |
|---|---|
| 安装 | dry-run零写入、准确路径确认、显式启用配置、版本/哈希拒绝、白名单复制、保留其他插件和配置 |
| 恢复 | 升级备份、手动回滚、四个写入阶段注入故障自动回滚、暂存失败、卸载回滚、后续用户编辑保护、遗留锁、缺失journal安全提示 |
| 路径 | 符号链接/junction拒绝、transactions目录和记录文件的符号链接、源目标重叠、空格/Unicode目标、平台启动脚本参数透传 |
| 协议 | 三协议流/非流、工具调用及结果往返、图片结构、签名/密文保留、默认/手选思考、未知字段保真拒绝 |
| SSE | 单字节UTF8分片、CRLF、多行data、工具空参数、脱敏错误、EOF/socket读取失败、缺失终结、最终结果与增量一致性 |
| 会话 | 固定Go域、禁止重定向、自己UA、会话随机ID、用户/token隔离、CSRF/Origin/TLS、TTL/限额/取消/超时/并发清理 |
| 前端 | 实际index.js + 最小DOM contract double：填Key→配置→原生请求→公开API→断开恢复→dispose；失败恢复、互斥及pending注册清理 |

独立代码复核发现过事务目录符号链接越界和journal截断写入问题；均已修复为严格路径检查及随机临时文件原子替换，相关回归通过。复核不等于生产安全认证。

**tested/mock**：合成请求和临时夹具。**source-inspected**：ST1.18.0中间件顺序和客户端调用路径只读核实。**live-unverified**：真实Go订阅推理、各模型工具/图片能力、完整ST服务/浏览器、多用户登录、所有代理容器配置与第三方扩展组合。不能把mock/CI等同这些真实环境验证。

```sh
node scripts/test.mjs
# 可选，只读现有LWB源码，不指定凭据或用户数据目录：
LWB_REFERENCE_ROOT=/path/to/LittleWhiteBox node --test tests/local-reference.mjs
node scripts/prepare-release.mjs
node scripts/build.mjs
```

没有LWB_REFERENCE_ROOT时，该单独测试的6项会skipped，不能算通过。安装器测试在仓库父目录的 `.go-bridge-installer-fixtures/` 创建临时合成目录，测试后删除各夹具；不自动发现或操作实际酒馆。
