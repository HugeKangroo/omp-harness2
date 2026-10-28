# omp-harness2

面向 Oh My Pi 的本地任务插件：提交一次自然语言任务，系统判断直接完成还是探索不同方案，依据预先确定的标准审阅实际产物，交付可查看、可应用的结果。适用于仓库内的代码修改、文稿、方案和其他文本文件任务。

**状态：`0.1.0-alpha.1`，产品基础实现，尚未达到面向日常使用的发布门槛。** 当前支持固定、受限的 OMP 文件编辑 profile；它不等于用户完整的原生 OMP 配置。没有声称复现论文的性能增益。

## 快速开始

要求：macOS/Linux、Bun ≥ 1.4.0、Git、支持 RPC v2 的 OMP。当前实机兼容性检查使用 OMP **18.13.1**。任务目录必须是 Git 仓库顶层。

```sh
bun install
bun run check
bun src/cli.ts doctor
```

在需要处理的项目目录，显式加载本地扩展（将路径替换为实际安装位置）：

```sh
omp -e /absolute/path/to/omp-harness2/src/extension.ts
```

插件通过 `package.json` 的 `omp.extensions` 声明入口。当前包标为 `private`，没有发布 npm 包，也不会自动修改全局 OMP 配置。

Worker 只接收显式 API key 环境变量，例如 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`；也支持 `HARNESS2_API_KEY`。不复制 OMP 登录数据库，不继承 OAuth/订阅登录。不同 improver/executor provider 应分别设置其 API key，而不要使用一个通用 key。

```text
/harness run 为这个项目写一份简洁的入门说明 --model openai/gpt-4.1 --budget 5
/harness status
/harness show <run-id>
/harness diff <run-id>
/harness apply <run-id>
```

用户只需描述任务，不必先选择算法、角色或路线。新建 product 任务默认使用 `auto`：先明确要求和评估标准，再判断是否值得比较多个方案。

`run` 默认使用当前 OMP 模型；该模型必须属于受支持的 direct API provider。CLI 需要明确指定 `--model provider/model`。模型别名、模糊匹配和自动 fallback 被禁用。

其他操作：

```text
/harness list
/harness cancel <run-id>
/harness resume <run-id>
/harness doctor
```

CLI 提供同样的命令，例如：

```sh
bun /absolute/path/to/omp-harness2/src/cli.ts --workspace /path/to/repo run \
  --model openai/gpt-4.1 --budget 5 --mode product -- 修复解析器对空输入的处理
```

`--workspace`、`--store-root` 和 `--json` 放在子命令之前。任务中包含字面 `--flags` 时，用 `--` 分隔。命令解析不会执行 shell 展开。

## 当前行为

- **按任务选择流程**：`auto` 先记录决策理由与结构化标准。明确、简单的任务走直接完成；有实质性方案差异的任务才进入探索。
- **直接完成**：auto 判断后执行 baseline → select，生成一个产物并按冻结标准审阅。显式 `--strategy direct` 使用本地生成的任务约束标准，跳过付费 planner 调用。
- **探索不同方案**：plan → baseline 与 2–3 个有名称的路线 → review。没有完善需求时直接采用这次审阅的选择；需要完善时才执行一次 refine 并重新 select，最后 reflect。路线记录做法、假设与取舍，不要求合并成一个方案。
- **基于实际产物改进**：如审阅建议继续完善，从所选候选的真实文件创建独立副本，并传入它的完整回答，最多继续一次。保留原候选与改进后的版本，最终仍可选择原结果。
- **明确评估边界**：匿名审阅所有可采纳候选，对每项标准记录 `met`、`not_met` 或 `unknown` 及证据。`status` / `show` 展示路线、选择理由、评估方式与局限；模型判断和 fallback 都明确标注。
- **隔离与可恢复**：初始候选从同一 Git dirty/untracked 快照开始；各阶段持久化配置、轨迹、费用预留与产物指纹。恢复复用已经完成的阶段，未知费用保留完整阶段预算。
- **受控文件工具**：所有角色都只使用 host-owned 文件工具；审阅、规划和反思角色只读。solver 可写入私有副本。
- **明确应用**：完成后先看 diff，再显式 apply。应用时校验源工作区及产物指纹；同一工作区的应用与恢复互斥，重复 apply 幂等。
- **经验有范围**：探索流程可以保留带有证据、适用条件和局限的改进经验；没有可靠条目则不入库。反思失败不会丢弃已采纳产物。

默认总预算为 **5 USD、30 分钟**，单阶段上限 10 分钟。总墙钟 deadline 从创建 run 时开始，暂停期间也计时；resume 不延长 deadline。参数：`--budget`、`--max-minutes`、`--stage-minutes`、`--improver-model`、`--domain`。

`--strategy` 是可选覆盖项，普通使用不需要填写：

| 模式与策略 | 行为 |
| --- | --- |
| `product` + `auto`（默认） | 根据任务选择直接完成或多路线探索 |
| `product` + `direct` | 跳过付费 planner，冻结任务约束标准后直接完成并审阅 |
| `product` + `explore` | 明确要求比较 2–3 条不同路线，可继续完善一次 |
| `product` + `legacy` | 保留原有 INV/DOM → Probe → Compose 流程，匿名比较 baseline/final |
| `research` | 使用 `legacy`，采用 sole composed final；拒绝其他显式 strategy |

没有保存 `strategy` 的旧记录按 `legacy` 恢复，不会在中途换成新流程。`legacy` 中无效的选择响应保留 baseline；composed 执行失败仍会使 run 失败。`research` 与新的 product 探索流程应分开报告；它们都不是论文完整复现或性能增益声明。

所有策略都需要显式 apply。当前评估是基于文件与执行记录的模型审阅；没有运行任务测试、用户研究、外部事实核查或性能实验，因此不能把评价描述成实测结果。

## 边界与已知限制

1. **首版不运行 shell、测试命令、网络工具、MCP 或子代理。** Worker 可读取、列出和写入 UTF-8 文件，不能声称已执行测试。大型仓库的搜索、文件删除、构建测试与执行型插件需要后续能力后端。
2. 文件工具是应用层权限边界，不是内核沙箱。私有工作区防止候选间污染，但不能防御同一用户下的恶意本地进程竞争修改目录。
3. OMP 自动读取 home `.env` 时无法保证隔离，因此存在该文件会阻止 worker 启动。不会读取其内容，也不会自动删除它。
4. 费用来自 OMP 的已知模型价格和 usage。已经发出的请求可能超过预算；未知费用保守预留，无法承诺服务商账单硬上限。零价格或缺失价格的模型被拒绝。
5. 文件/目录命名规则排除凭证与自动配置。它不是源代码中所有秘密的内容扫描器；应仅用于允许发送给所选模型的项目。
6. 快照排除 `.git`、`.omp`、`AGENTS.md` 等环境指令、依赖目录与敏感文件。被排除的路径记录在快照中；不会自动继承个人 OMP skills 或上下文。
7. apply 使用逐文件原子替换、备份和 journal，可恢复进程中断；不承诺整棵文件树或断电级原子性。文件与目录类型互换暂时拒绝。
8. 经验只是一次执行对照支持的假设；结构校验不能证明因果正确性或自动识别所有任务专属内容。尚无经验晋升、淘汰和跨项目共享流程。
9. 正常取消/超时清理进程组，并保存 worker 归属记录。恢复时若旧进程组仍存活、权限不足或归属记录无效，会拒绝启动重复 worker。controller 遭 `SIGKILL` 后的自动孤儿回收仍是发布前检查项；费用预留和 worker deadline 不等同于完整回收。

## 开发与验证

```sh
bun run typecheck
bun test
bun src/cli.ts --json doctor
```

默认测试不调用真实模型。测试验证自适应直接/探索流程、冻结标准、匿名审阅、一次延续、旧记录兼容，以及预算、取消、恢复、RPC、文件权限和 apply 保护。具体通过数和未验证层级见验证报告。

真实 OMP 的额外集成检查需要本地已安装的兼容版本：`RUN_REAL_OMP_TEST=1 bun test test/real-omp.test.ts`。它使用固定、无网络的模拟 provider，覆盖实际 agent loop 与完整九阶段流程；成功不代表真实模型质量或远端 HTTP 传输已验证。实际验证记录见 [验证报告](docs/validation.md)。

依赖安装需要访问 npm registry。本次开发环境通过官方 Bun 声明和本机 TypeScript 完成类型检查；尚未生成可发布的依赖锁文件。发行前应在联网 CI 完成正常安装、锁文件和依赖审查。

## 代码导航

| 文件 | 职责 |
| --- | --- |
| `src/extension.ts`、`src/cli.ts` | OMP 交互与后台控制进程 |
| `src/controller.ts` | 持久化阶段调度、预算与采纳 |
| `src/runner.ts`、`src/host-tools.ts` | OMP RPC、工具边界和进程生命周期 |
| `src/workspace.ts` | 输入快照、差异、应用与恢复 |
| `src/store.ts` | 原子记录、CAS、锁、经验库 |
| `src/surface.ts`、`src/prompts.ts` | 可编辑面和改进阶段协议 |

下一阶段的产品目标、验收门槛及边界见 [产品定义](docs/product.md) 与 [架构设计](docs/architecture.md)。

方法参考：[Harness² 论文](https://arxiv.org/abs/2610.14224)、[Google Research 实现](https://github.com/google-research/harness2/tree/1cfe254e8d25b15f37048c3730134686abe60335)。本项目是独立实现，非 Google 或 OMP 官方产品。
