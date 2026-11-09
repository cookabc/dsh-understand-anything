---
name: understand-anything
description: 分析当前项目，生成可交互的代码知识图谱（.ua/knowledge-graph.json），并按需补充语义说明。当用户想理解新代码库、梳理架构、开始接手项目时使用。
whenToUse: 用户说「分析这个代码库 / 帮我理解项目 / 画一下架构 / 刚接手这个项目」时。
---

# /understand-anything

把当前工作目录的代码库变成一张可查询的知识图谱。结构层由确定性扫描器生成，语义层由你（模型）补全。

## 工作流

1. **先建图**：调用 `ua_scan`（可传 `root` 指定项目根目录）。它扫描源文件、提取函数/类/导入，写出 `.ua/knowledge-graph.json`。若项目里已有 `.understand-anything/`，会自动沿用该目录。
   - 默认增量：只有内容变化的文件会重新解析，已写过的 summary/tags 会保留。
   - 强制全量重建并清除注释：传 `full: true`，不要把它当作日常刷新。
   - 中文输出：传 `language: "zh"`（也可用 `ua_config` 持久化）。
2. **看统计**：`ua_status` 给出节点/边数、语言、分层与新鲜度。若扫描不完整，先查看预算和不可读路径。已有图谱的受限刷新会返回 `INCOMPLETE_SCAN` 并保留旧数据。可扩大预算，或明确选择子目录；切换范围会保留注释存档。
3. **补语义（可选但推荐）**：图谱里结构节点的 `summary` 初始为空。挑最重要的 10–30 个节点，调用 `ua_annotate` 写 `summary`（一句话说明这个文件的职责）、`tags`、必要时 `layer`。**只写你从源码里真的读到的内容，不要编造。**
4. **导览**：`ua_tour` 返回按依赖顺序排列的阅读步骤，可直接整理成新人上手指南。
5. **可视化**：`ua_dashboard` 生成单文件离线 HTML 图谱页，把返回的路径用 `present` 交给用户。

## 图谱结构

- `project`：名称、语言、框架、分析时间、git commit。
- `nodes[]`：`id`（`file:路径` / `function:路径:名` / `class:路径:名` / `module:包名`）、`type`、`name`、`filePath`、`summary`、`tags`、`complexity`、`layer`。
- `edges[]`：`source` / `target` / `type`（`contains`、`imports`、`calls`、`related`）/ `direction` / `weight`。
- `layers[]`：按目录约定推断的架构分层，`nodeIds[]`。
- `tour[]`：依赖顺序的阅读步骤。
- `meta.fingerprints`：增量扫描用的文件哈希。`annotation.stale` 表示源码变动后的注释需要复核。

## 边界

- 扫描器用正则做确定性提取，不是完整的 AST 解析器；复杂的宏、动态导入、跨语言反射会有遗漏，这是已知限制，不要声称覆盖率 100%。
- 只读源码，只写 `<root>/.ua/`（或遗留的 `.understand-anything/`）。不会改源码、不联网、不执行被分析的代码。
- 图谱是结构事实 + 你补的语义；回答用户问题时区分「图上写明的」和「你推断的」。
