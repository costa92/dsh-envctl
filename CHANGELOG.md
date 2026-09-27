# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。发布流程见 [docs/发布流程.md](docs/发布流程.md)。

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
