# Alpha 验证记录

日期：2026-10-28。版本：`0.1.0-alpha.1`。执行环境：macOS、Bun 1.4.0、OMP 18.13.1。本文记录实际已执行的检查，不表示通过正式发布门槛。

## 实际结果

| 命令或检查 | 结果 | 边界 |
| --- | --- | --- |
| `bun run check` | 严格 TypeScript 检查通过；156 pass、5 skip、0 fail，1286 个断言 | 默认测试不发送模型请求 |
| `RUN_REAL_OMP_TEST=1 bun test test/real-omp.test.ts test/real-conversation.test.ts` | 4 pass、0 fail，100 个断言 | 真实 OMP 二进制，固定无网络模拟 provider |
| `bun src/cli.ts --json doctor` | `ok: true` | 检查 OMP 18.13.1、RPC v2、原生工具为空与仅 3 个 host 文件工具；无模型 prompt |
| 实际 OMP 加载 `src/extension.ts` | `get_available_commands` 返回 `harness` | 验证插件加载和命令注册；未发送模型请求 |

默认跳过的 5 项中，4 项真实 OMP 集成测试已通过独立命令执行。剩余 1 项是父进程退出后对同进程组后代的信号清理：此前受管环境对部分后代信号操作返回 `EPERM`，本轮未重测，不能将该项标为通过。可在具备正确权限的部署环境中运行 `RUN_PROCESS_GROUP_TEST=1 bun test test/runner.test.ts`。

## 集成测试实际验证了什么

第一项通过真实 OMP agent loop、RPC 和 host tools，按需读取虚拟 skill、写入任务副本并等待 settled。它同时验证任务文本中的 `@file`、`^model` 不触发 OMP 的外部文件附加或模型切换。

第二项启动九个真实 OMP worker，跑完 baseline、INV/DOM 提议、两个 probe、compose、final、selector 和 reflection。验证各 solver 从原始快照开始，改进角色读取只读证据，选择 final 后经验入库，主项目保持原样，显式 apply 才应用产物且重复 apply 幂等。九个 worker 的归属记录均在确认清理后移除。

第三项验证默认自适应 product：先冻结标准与两条路线，再独立执行 baseline 和各路线，匿名审阅全部产物。性能标准保留 `unknown`，所选路线无需 refinement 时复用 review；验证没有多余 select 调用、没有无依据经验、显式且幂等的 apply，以及 worker 归属清理。

第四项验证对话入口：真实 OMP 收到普通用户输入后，固定 provider 调用 `harness_task start`，主 turn 结束后由完成通知唤起后续 turn，再调用 inspect。验证真实工具 schema、五参数 execute、会话用户来源、分支绑定、一次后台启动与一次结果续轮。该测试注入固定的进程内任务 runner；它不验证付费模型的自主路由质量，也没有实际点击交互 UI 的确认框。

另有 19 项自适应 controller 回归，覆盖代码和文稿任务、直接执行、三路线择优、从父候选文件及纯文本响应继续改进、改进版本不如原候选、全部候选违反要求、未知费用、中断恢复、取消及产物篡改。这些使用 fake runner 验证状态机，不代表真实模型能稳定提出优质路线。

对话层另有 10 项纯契约测试和 20 项扩展测试，覆盖真实用户来源、分支祖先绑定、重复交接、重启重连、完成通知防递归、空闲与消息队列检查、延迟 resume、UI 确认、预览指纹，以及等待过程中切换会话/分支或取消。controller 回归还验证：在 apply 最后一个异步步骤之后执行同步授权检查，拒绝已失效的会话或预览后再进入文件事务。

模拟 provider 的 token 与费用是固定测试数据，只用于验证计量接线。没有使用真实 API key、调用远端模型或产生可报告的真实推理费用。该结果不证明 HTTP 传输、服务商账单、模型质量或 Harness² 的性能收益。

## 重要回归契约

- INV/DOM 提议仅使用 baseline 证据，不能看到对方的候选轨迹。
- 已完成阶段恢复时不重放；失联请求保留预算，结构校验失败次数不会因恢复重置。
- review/select 派发后冻结候选集合；即使中断发生在 worker 完成与结构化结果持久化之间，也不会重跑失败分支而改变已有评审的对象。
- refinement 保留父产物及指纹，子产物仍相对原始快照计算 diff/apply；原候选始终可以胜过改进版本。
- 评估覆盖每个成功候选及每条冻结标准；已知违反硬性要求的候选不能被选中，格式回退仅记录未知判断。
- 对话工具只操作当前分支可见的已绑定任务；完成通知、合成消息与 agent 消息不作为新的用户授权。
- 完成通知在插件内等待主会话空闲，不进入忙碌时无法撤销的宿主 follow-up 队列；发送尝试会持久化，但 OMP 的无回执接口不能保证消息必达，inspect 保留可恢复入口。
- 对话 apply 不接受模型自报批准。它要求当前预览 token、真实 UI 确认和 controller 锁内的 digest 校验，并在实际同步写入前再次检查会话与取消状态。
- 无效或无法确认的 worker 归属阻止重复调度。
- 持久化文件使用严格 schema、CAS、锁和原子替换；损坏数据不静默回退。
- 已接纳轨迹和产物有指纹校验，选定后修改的候选不能被 apply。
- 工作区漂移、路径逃逸、符号链接、硬链接和保留证据目录写入均被拒绝。
- 多文件 apply 支持回滚和中断恢复；不承诺断电或整棵目录的原子性。
- Reflection 失败保留已采纳产物；无执行对照支持的经验不入库。

## 发布前尚需完成

1. 在明确支持的 direct API provider/model 上验证认证、HTTP、真实 usage、费用、超时和取消。
2. 在正常部署权限下验证进程组后代清理，并闭环 controller 被 `SIGKILL` 后的 worker 识别与安全回收。当前遇到存活或无法确认的旧 worker 会拒绝恢复。
3. 在联网环境完成标准 `bun install`、提交依赖锁文件并建立 CI。当前受限环境无法访问 npm registry；类型检查使用官方 Bun 声明与本机 TypeScript 5.9.3。临时依赖不会随源码包交付。
4. 在等预算任务集上比较受限 baseline、重复执行加选择、Harness² 及关闭经验的 Harness²；定义经验检查、禁用和淘汰流程。

首版不具备 shell、构建或测试执行能力，不能用这份插件开发测试报告替代用户任务自身的验证。完整发布标准见 [产品定义](product.md)。
