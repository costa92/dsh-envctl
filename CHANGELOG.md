# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。发布流程见 [docs/发布流程.md](docs/发布流程.md)。

## 0.2.0 - 2026-09-28

### 修复

- 快照先写入临时目录，完整后再改名发布；复制中途失败不再留下不完整的快照，避免 `rollback` 选中它并删除现有的 lock/state 文件。
- 快照记录当时不存在的 overlay；`sync` 在写入新 overlay 后、更新 `remote.json` 前被中断时，`rollback` 会删除这些新文件。rollback 前的备份会同时保存这些文件，它们若已成为本地文件，可以再次 rollback 找回。
- `source clone --profile` 在拿到环境锁之后才判断哪些目录归自己；两个 clone 并发时，失败的一方不再删掉整个 `sources/` 目录。命令失败时只删除自己的 checkout，父目录只在为空时删除。
- `source clone --profile` 先解析 `lock.json` 再写清单；lock 损坏时清单保持不变。
- `adopt` 在写 `state.json` 失败时把已写的清单和 lock 恢复原样。
- 回滚 `cordis.patch.yml` 所用的原内容在写入时的同一次 profile 锁内读取；dshenv 等锁期间 DSH 做的修改不再被回滚覆盖。
- `cordis.patch.yml` 为非空 flow 数组（如 `[{id: x}]`）时，先改写成块式序列再追加受管块，不再生成非法 YAML；`~`、`null` 等空文档按空数组处理；被旧版本写坏的文件（flow 数组后接受管块）会被 `plan` 发现并规划一次 configure，`apply` 时修复，保留所有受管块；写入结果不是单个顶层数组时拒绝写入。
- `apply` 新安装的插件会记录所有权，之后从清单删除该插件时会被卸载，不再变成未受管。
- 更新一个保持禁用的插件时，更新后会再次禁用（DSH `plugin add` 会选中 bundle）。
- 本地来源路径改变时规划 update，即使新旧路径内容 digest 相同。
- 缺少校验证据时不再报告已收敛：已装 Git 规格未指向 commit（如 `#main`）、npm 包没有版本号时按锁定版本重装；已安装的本地来源无法读取时列为 unverified：`status` 显示 degraded，`plan` 单独列出，但不阻止其他操作。
- `apply` 调用的 DSH `plugin add` / `plugin remove` 10 分钟超时，超时后终止 DSH 及其启动的 pnpm 等整棵进程树并回滚，不再无限期占用环境锁。
- 不支持硬链接的文件系统上，只创建（create-only）写入改用排他复制，不会覆盖并发创建的文件；复制中途失败时删除写了一半的目标文件。
- 在 Windows 上按 `;` 切分 PATH 并按 PATHEXT 查找 `dsh.cmd` 等命令。

### 变更

- 清单中 npm 来源的 `registry` 字段不再被接受：`apply` 从未使用它，声明私有 registry 实际会从默认 registry 安装同名包。
- `lock.json` 中的 git `commit` 必须是 7-64 位十六进制 commit id（支持 SHA-256 仓库）；分支名、tag 会被拒绝。

## 0.1.3 - 2026-09-28

### 变更

- GitHub 仓库改名为 [`costa92/dshenv`](https://github.com/costa92/dshenv)，与 npm 包名一致；npm 包的 `repository` 与 `homepage` 指向新地址。旧地址 `costa92/dsh-envctl` 由 GitHub 自动跳转。

## 0.1.2 - 2026-09-28

### 修复

- 以 `git+` 地址安装 Git 来源：`file://` 与自建服务器的 `https://` 地址此前会被 pnpm 当作本地目录或压缩包而安装失败。
- DSH 插件命令失败时显示 DSH 自己的 `dsh:` 诊断行（如版本不兼容的原因与放行命令），不再只有退出码；pnpm 原始输出不显示。
- `adopt` 替换清单中已有的插件时保留已声明的 `patches`，不再静默丢失配置。
- `status <插件>` 可以按别名过滤，与其他插件命令一致。
- `source pull --ref <分支名>` 快进到上游分支；此前会快进到本地分支自身，报告成功但没有更新。只有与上游分支完全同名时才改用上游，`HEAD`、`HEAD~1` 等修订仍按当前检出解析。

## 0.1.1 - 2026-09-28

### 变更

- 发布到 npm registry，包名 `@costa92/dshenv`（无作用域的 `dshenv` 被 npm 以与 dotenv、osenv 过于相似为由拒绝）：`npm install -g @costa92/dshenv`。命令名仍为 `dshenv`。
- 从 Git 地址用 pnpm 安装时，放行参数改为 `--allow-build=@costa92/dshenv`；卸载改为 `pnpm remove --global @costa92/dshenv`。
- Release 工作流把同一份 `.tgz` 发布到 npm（带 provenance）并附在 GitHub Release 上。

## 0.1.0 - 2026-09-27

首个公开版本。支持的 DSH 版本族：`0.1.7`（含预发布版）。

### 新增

- 环境探测与盘点：`doctor` 报告 DSH 版本与能力矩阵；`capture` 把现有 Profile 盘点为候选清单，`adopt` 建立所有权。
- 声明式管理：`manifest.yaml` + `lock.json`，`plan` / `status` 计算漂移；npm 只接受精确版本，Git 来源锁定 commit，本地来源记录 digest。
- `apply`：通过 DSH CLI 执行 install / update / remove，通过 Profile bundles 执行 enable / disable，通过 `cordis.patch.yml` 受管块执行 configure；带环境锁、快照、操作日志与失败回滚，并按 DSH 热加载状态报告哪些改动需要重启。
- 便捷命令：`install`、`update --to`、`enable`、`disable`、`remove`、`list`、`config get|set|validate`、`source status|clone|pull`、`restarted`、`rollback`、`gc`、`purge`。
- Base + Overlay 清单合并与本机 overlay 选择。
- 团队共享基线：`remote add|show|remove` 订阅 Git 配置仓库，`sync` 预览并接受固定 commit 的更新。
- `runtime`：连接运行中的 `dsh web`，核对清单插件是否已加载，并说明卡在 pending 的插件。
- `new`：从模板生成 skill / agent / tool / mcp 组件包。
- `--json` 结构化输出，错误同样以 JSON 写入 stderr。
- 示例：GitHub Actions 漂移检查、容器镜像；`make smoke-dsh` 验证新 DSH 版本。
