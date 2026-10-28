# omp-harness2

面向 Oh My Pi 的 Harness² 插件：在同一代码快照上执行基线、通用候选、领域候选和合成候选，依据真实执行记录选择产物，并保存有证据支持的改进经验。

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
/harness run 修复解析器对空输入的处理 --model openai/gpt-4.1 --budget 5
/harness status
/harness show <run-id>
/harness diff <run-id>
/harness apply <run-id>
```

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

- **完整 k=1 流程**：baseline → INV/DOM 提议 → 两个 probe → Compose → final → product 选择 → Reflection。
- **独立起点**：四个 solver 从同一 Git dirty/untracked 文件快照开始；各自使用新 OMP 进程。
- **独立提议**：INV 与 DOM 只能看到 baseline 证据和相同的历史经验快照。
- **受控工具**：关闭 OMP 原生工具和自动发现，只通过 host-owned 文件工具访问任务副本；editor/selector/reflector 只读。
- **声明式 harness**：prompt append、tool guidance 和只读、按需加载的 skills；不执行生成的脚本或 TS extension。
- **可恢复记录**：持久化阶段、配置、事件、费用预留、候选和选定产物指纹。恢复跳过已完成阶段；未知费用保留完整阶段预算。
- **明确应用**：结果完成后先查看 diff，再显式 apply。应用时重新校验源工作区和产物指纹，拒绝覆盖漂移；重复 apply 幂等。
- **经验库**：每个项目按 domain/model 分区，引用 baseline 与候选执行证据；无可用经验则不入库。反思失败不会丢弃已经采纳的产物。

默认总预算为 **5 USD、30 分钟**，单阶段上限 10 分钟。总墙钟 deadline 从创建 run 时开始，暂停期间也计时；过期任务不能通过 resume 延长。参数：`--budget`、`--max-minutes`、`--stage-minutes`、`--improver-model`、`--domain`。

| 模式 | k=1 采纳规则 |
| --- | --- |
| `product`（默认） | 匿名比较 baseline/final，允许选择 baseline；无效选择响应保留 baseline |
| `research` | 跳过 selector，采用 sole composed final，对齐所研究参考实现的该项行为 |

两种模式都要求显式 apply。`research` 不是论文完整复现声明：模型、执行器、提示词和可编辑组件均存在差异。

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

默认测试不调用真实模型。测试覆盖完整 controller 流程、PPC 证据隔离、预算、重试/恢复、RPC 协议、host 文件权限、存储锁、工作区漂移、产物篡改、apply 回滚和幂等。

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
