# 安装、更新、回滚、卸载

所有脚本复用同一个零依赖 Node 安装核心：macOS/Linux 用 `sh install.sh`，Windows 用 `install.ps1`，两者也可直接用 `node install/install.mjs`。需要 Node>=20 和已经存在的 SillyTavern。脚本不启动酒馆、不联网、不安装依赖、不处理真实 Key。

## 目标与确认

`--st-root` 明确指定酒馆根；未指定时仅从当前目录向上检查 `package.json.name=SillyTavern`、`server.js` 和 `public/scripts/extensions`。不会扫描磁盘其他位置。先执行 `--dry-run`：不创建锁、目录或备份、不改配置，只输出版本、绝对目标、配置是否会改、备份位置。

实际安装需交互输入显示的完整根路径，或显式 `--confirm-root <同一路径>`。默认不改配置。若服务器插件禁用，必须在审阅后加 `--enable-server-plugins` 或由管理员自行启用；只支持简单顶层布尔值，重复键、别名、复杂 YAML 明确报错，绝不重写整份配置。既有配置原字节备份为私有文件，其他设置和注释保留。

源文件必须匹配 `release-manifest.json` SHA256，且根 package/manifest/server 版本一致；可指定 `--expect-version 0.2.0`。清单能检测损坏或混版，**不是发布者签名**；仍应核对可信仓库、tag/commit。不要执行来源不明的安装脚本。

## 更新

- 脚本完整安装：在最初 clone 的仓库目录 `git pull --ff-only`，阅读变更，再 dry-run 和运行安装脚本。既有本插件文件移入带事务 ID 的备份，新版本先暂存并验证后替换。
- 酒馆 Git 扩展安装：由酒馆更新前端；进入该前端仓库运行脚本时必须带 `--backend-only`。更新后端后管理员自行重启。
- 不识别为本插件的同名目录、Git 管理的前端目录、源/目标重叠、路径中符号链接/Windows junction 均拒绝，避免覆盖别的项目。
- 自定义酒馆 dataRoot 不影响后台安装；完整脚本把前端放共享 third-party 目录。如果只要某个用户前端，用酒馆扩展安装器，再运行 backend-only。

## 失败与回滚

每次变更记录 `.opencode-go-bridge-installer/transactions/<ID>/transaction.json`。原文件在相邻 `backup/`，记录采用同目录临时文件原子替换；写配置前备份，写插件前将旧目录原子移动到备份。捕获到的写入失败自动回滚。

```sh
node install/install.mjs --st-root "/path/to/SillyTavern" --rollback <打印的事务ID> --dry-run
node install/install.mjs --st-root "/path/to/SillyTavern" --rollback <打印的事务ID>
```

如命令运行于酒馆自己的前端 Git 目录，加 `--backend-only`，保持该目录不受脚本管理。回滚按事务记录恢复它实际涉及的组件；不因为其他标志额外处理组件。

硬中断后，新的安装会检测 preparing/pending/rollback_failed 状态并停止，要求先处理该事务。只有当前文件与安装时记录相符时才恢复；若此后有人编辑插件或配置，拒绝覆盖，管理员需检查备份并人工合并。极早中断产生无可读 journal 的暂存目录时，给出明确人工检查指引，不盲删目录或猜测恢复。

安装锁位于 `.opencode-go-bridge-installer/lock`。若异常退出留下锁，先确认没有安装进程在运行，再由管理员检查并移除遗留锁。脚本不自动杀进程、解除权限或删除未知锁。备份不自动清理；确认不再需要恢复后管理员可自行归档。

## 卸载

先在扩展面板断开并恢复原连接。完整脚本安装可执行：

```sh
node install/install.mjs --st-root "/path/to/SillyTavern" --uninstall --dry-run
node install/install.mjs --st-root "/path/to/SillyTavern" --uninstall
```

卸载只移走识别为本插件的目录并留可回滚备份。`enableServerPlugins` 是所有后端插件共用设置，卸载不擅自关闭；管理员核对其他插件后再决定。若前端是酒馆 Git 安装，先用 `--uninstall --backend-only` 删除后端，再用酒馆扩展管理器卸载前端，最后管理员自行重启。

## 平台边界

| 平台 | 脚本路径 | 限制 |
|---|---|---|
| macOS/Linux | sh wrapper 或 Node | 本地合成夹具已验证，不是用户现有酒馆实装 |
| Windows | PowerShell wrapper 或 Node | 不改执行策略；CI结果见TESTING.md/Actions |
| Docker | 在已有 Node 的容器中运行 Node核心，或对明确挂载目录操作 | 不替用户修改容器、挂载、属主或权限；管理员自己重启 |
| 托管平台 | 需要服务端插件安装权限 | 仅前端权限无法完成；无独立sidecar发行版 |
| 自定义配置路径 | 当前安装器仅根目录 config.yaml | 可由管理员手动部署，脚本不会猜测或覆盖其他配置 |

不降低 CSRF/身份校验。HTTP远程、代理TLS识别等错误需要平台管理员处理，本脚本不会改网络安全设置。预览版、Go用途与Extra usage边界见README。
