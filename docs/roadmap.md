# dshenv 后续规划与路线图

本路线图基于 `docs/superpowers/specs/2026-09-25-dsh-environment-manager-design.md` 设计。

---

## 阶段规划

### Phase 1: 只读原型（当前版本）
- [x] CLI 骨架与环境路径解析
- [x] 声明式清单 (`manifest.yaml`)、锁 (`lock.json`) 与状态格式及校验
- [x] 安全 DSH 运行时能力探测 (`doctor`)
- [x] 只读 Profile 盘点 (`inventory`)
- [x] 无损环境捕获 (`capture`)
- [x] 确定性变更比对与状态映射 (`plan`, `status`)

### Phase 2: 官方管理器适配与环境接管 (`apply` & `adopt`)
- [ ] 挂载 `@deepseek-ai/dsh-plugin-manager` 官方写适配器
- [ ] Live manager service 通讯与 Profile 独占文件写锁
- [ ] `apply` 状态机执行器：原子收敛期望态
- [ ] `adopt` 命令：对现有 Profile 插件显式声明接管所有权

### Phase 3: 受管 Git 与本地源码生命周期
- [ ] 受管 Git 插件自动化 clone / fetch / fast-forward 校验
- [ ] 脏工作树安全拒绝保护（防代码丢失）
- [ ] 本地源码构建审批与 digest 校验机制
- [ ] 离线 bundle/entry 协调适配器

### Phase 4: 事务日志、回滚与垃圾清理
- [ ] 操作级事务日志 (`$DSH_HOME/envctl/logs/`)
- [ ] `rollback` 命令：状态秒级回退与补偿机制
- [ ] 受管资源软删除与垃圾回收 (`trash/` & `gc`)
- [ ] 异常失败注入测试与自愈机制
