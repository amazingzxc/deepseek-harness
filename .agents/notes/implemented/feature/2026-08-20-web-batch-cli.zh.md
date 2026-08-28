# Agent Note: 通过 Web Session 实现 Web 批处理 CLI

Status: implemented

[English](2026-08-20-web-batch-cli.md) | 中文

## 问题

自动化需要并发运行相互独立的任务，同时保留 Web 产品中可见的 Session、权限提示、问题、持久化与恢复。一次性 headless 入口无法提供浏览器交互，而第二套 Agent loop 或批处理专用 RPC 会复制 Web Host 已经拥有的 authority。

批处理进程可能在发送 create 或 prompt 请求后、收到响应前失败。恢复过程不能创建第二个 Session 或重复提交任务 prompt，第二个 runner 也不能并发推进同一持久批次。

## 决策

`@deepseek-ai/dsh` 包通过[唯一应用启动器](../architecture/2026-08-22-single-dsh-application-launcher.zh.md)提供 `dsh web-batch`。这个惰性加载的子命令是已运行 `dsh web` Host 的应用层 Typert Remote 客户端，并遵循现有的 [Gateway 方法协议](../architecture/2026-08-02-typert-remote-method-calls.zh.md)与[远程事件传递](../architecture/2026-08-10-remote-event-delivery.zh.md)。它不挂载插件、不启动 Host、不修改 Agent Loop、不增加 Web Remote 方法，也不复用[直接 headless 入口](../architecture/2026-08-09-headless-direct-core-entry-point.zh.md)。

严格 JSONL manifest 中的每项任务都有独立的规范绝对 cwd，并获得一个全新且预分配的 Session ID。runner 会在访问网络前持久化该 identity，调用幂等 `session.create`，对账 `session.history` 与实时 queue，并且只在两者都不含任务 prompt 时提交该 prompt。第一条普通 prompt 拥有一个 root turn；后续普通人工 prompt 会被视为本地所有权冲突，但不会修改 Session。

批次状态保存在 `$DSH_HOME/web-batches/<batch-id>` 下的私有 SQLite 数据库中。其 application ID 与单调 schema version 会拒绝不兼容文件。持久 runner 锁阻止并发执行；显式 `--take-over` 会将被遗弃的所有者保留为审计历史。

Node carrier 会用 `dsh web` 打印的完整认证 URL 换取绑定 authority 的浏览器 Session cookie。一元 Remote 调用使用 HTTP，Session 与转发事件流使用 Gateway Remote mux。两组流以同一代连接重连；每一代都会在任务继续推进前重复创建 Session 并对账 history。

问题与审批仍由浏览器负责。requested frame 将任务转为 `waiting-human`，resolved frame 将其恢复为 `running`，非终态任务继续占用其并发 slot。runner 永远不会发送交互响应。完成的 turn 成功，用户 abort 取消，其他所有终态原因失败；所属 turn 中最后一条非空 assistant 消息成为任务文本。

stdout 是只在 SQLite 提交后发送的带版本 NDJSON 协议。SIGINT 与 SIGTERM 会让本地事件流和调度器完全停稳、释放 runner 锁，并保持 Web Session 运行，以供后续 `resume`。

## 考虑过的替代方案

**为 headless runner 增加批处理与交互支持。** 不采用，因为 headless 有意不挂载 Host、HTTP server、Gateway 或浏览器。加入这些职责会抹去直接核心入口的区别，并创建另一套 Web 组合。

**增加批处理 RPC 方法与 Host 侧批次持久化。** 不采用，因为现有 Session API 与事件流已经提供创建、prompt 持久性、交互观察与恢复。批次调度是调用方拥有的自动化状态，不属于 Session log 或模型可见请求。

**由 CLI 自动回答问题或审批。** 不采用，因为策略与人工意图属于现有 Web 交互 UI。无人值守的回答会绕过产品的权限与问题所有权。

**等待人工时释放并发 slot。** 不采用，因为并发限制约束的是实时任务所有权，而不是 CPU 使用量。启动另一项任务会超过操作者对可能需要监督的 Session 数量所设上限。

## 后果

操作者获得了可恢复的并行自动化，每项任务仍是普通且可检查的 Web Session，并且不存在新的模型可见输入或 session event。恢复依赖公开 Remote 行为与持久 Session history，而不是第二套执行引擎。

Web Host 必须已经可访问，调用方必须提供相互隔离的工作目录。待处理交互需要实时浏览器，`waiting-human` 可以无限期占满所有 slot，Host 重启会依照现有 Session 恢复方式终止未完成 turn，而不会重建表单。批次数据库在首次发布前有意不作兼容承诺。

## 验证

聚焦测试固定了严格 argv 与 manifest 校验、SQLite identity 与权限、runner 锁与接管、prompt/create 响应丢失、并发、交互重放、重连、冲突处理、信号和 plain-Node 构建输出。一项无密钥真实 Web 组合测试会启动构建后的批处理可执行文件、在 Chromium 中打开其 Session、通过随附页面回答重放问题，并将归一化 version 0 NDJSON 与检入的 expected 文件比较。一项密钥门控的 smoke 会启动构建后的 `dsh web`，并通过真实 DeepSeek provider 完成一项批处理任务。
