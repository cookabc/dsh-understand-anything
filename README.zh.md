# Understand Anything for DSH

用本地代码图谱理解项目、定位源码、评估变更影响。核心流程是 **扫描 → 解释 → 变更影响分析**。默认功能不联网、不调用模型、不执行项目代码。

## 开始使用

1. `ua_scan { "root": "/path/to/project" }`：生成 `.ua/knowledge-graph.json`。
2. `ua_query { "root": "/path/to/project", "query": "authentication" }`：检索相关文件和符号。
3. `ua_explain { "root": "/path/to/project", "nodeId": "function:src/auth.js:authenticate" }`：查看定义位置、附近源码与关系证据。
4. `ua_diff { "root": "/path/to/project" }`：区分已观测依赖与可能的调用者。可用 `base` 指定 Git 对比基准。
5. `ua_dashboard`：生成离线页面，通过源码索引、搜索和行号定位节点；按需显示推断调用关系。

已有 `.understand-anything/` 目录时会沿用。DSH 的工作目录可能是 profile 目录，建议显式传入项目 `root`。

## 如何理解结果

| 字段 | 含义 |
|---|---|
| `certainty: "observed"` | 扫描到了声明、导入或链接文本。导入证据还会说明目标的解析方式，不代表运行时一定经过这条关系。 |
| `certainty: "inferred"` | 调用形状的文本匹配到另一文件中的唯一同名函数。没有验证绑定、别名或动态派发；同名目标不唯一时跳过。 |
| `annotation` | 模型填写的摘要、标签或分层，独立于提取的结构保存。 |
| `annotation.stale: true` | 源码在注释写入后发生变化；保留文字，等待复核。 |
| `source.stale: true` | 解释工具读取的当前源码与图谱快照不同，关系可能过期。 |

符号的 `line`、`column` 从 1 开始。`ua_explain` 返回 `source.citation`、节选起止行号，节选围绕定义位置展开，上限为 60 行、6,000 字符。源码变化后会尝试重新定位声明，并报告定位是否得到验证。

非相对路径的导入也可能解析为内部文件：扫描根目录存在 `tsconfig.json` 时，会按其 `baseUrl` + `paths` 别名（如 `@/*`、`~/`、monorepo 包名映射）解析，别名导入成为内部依赖边而非外部模块。容忍 JSONC 注释与尾逗号；文件缺失或无法解析时，这些导入照旧按外部模块处理。

变更分析的 `upstream` 沿已观测关系追踪，`inferredUpstream` 单独列出可能受影响的节点；`via` 给出追踪路径。`unmappedFiles` 提醒哪些变更文件尚未入图，`truncated` 提醒结果受限。无效 Git 基准或不可用的 Git 工作区会报错。

## 增量更新与保护

- 每次读取纳入扫描的源码并计算哈希；未变化文件复用符号、导入和调用候选的解析结果。图谱不缓存源码全文。
- 源码改变后，摘要、标签和自定义分层会保留并标记待复核。切换扫描范围、暂时删除符号后，也会保留注释存档以供恢复。
- `scope: "src/frontend"` 限定范围，后续扫描和自动更新沿用该范围。传 `scope: ""` 回到整个项目。
- `full: true` 清除结构缓存和注释；未显式指定 scope 时扫描整个项目。
- 已有图谱时，扫描触及上限或遇到不可读文件会返回 `INCOMPLETE_SCAN` 并保留原图谱。首次扫描可保存明确标记为不完整的结果。取消扫描不会覆盖图谱。
- `ua_status` 对比源码内容和扫描快照，在非 Git 项目中也能识别过期。已经扫描过的未提交改动不会反复被误报为新变化。
- 同一插件进程内，写入工具按项目串行执行；文件通过独立临时文件替换。不同宿主进程应避免同时写同一份图谱。

## 默认工具

| 工具 | 用途 |
|---|---|
| `ua_scan` | 建图或刷新 |
| `ua_status` | 扫描范围、注释状态和源码新鲜度 |
| `ua_query` | 有上限的关键词检索 |
| `ua_explain` | 定义行号、源码节选与关系证据 |
| `ua_diff` | 已观测依赖和推断调用的变更影响 |
| `ua_annotate` | 写入或复核摘要、标签与分层，每次最多 100 个节点 |
| `ua_tour` | 按依赖组织阅读顺序 |
| `ua_dashboard` | 离线源码索引和图谱 |
| `ua_config` | 读写项目配置 |
| `ua_auto_update` | 刷新过期图谱并保留扫描范围 |
| `ua_hook` | 显式安装、查看、停用或移除 post-commit hook |

默认注册 11 个工具、5 个技能。安装 Git hook 时会保留并串联原有 hook；刷新错误不会阻止提交。代码扫描和自动更新不会覆盖知识库图谱。

## 配置

优先级：工具参数 > 项目配置 > 环境变量 > profile 默认配置 > 内置默认值。

| 参数 | 默认值 | 上限 |
|---|---:|---:|
| `maxFiles` | 4,000 | 50,000 |
| `maxFileBytes` | 512 KiB | 16 MiB |
| `maxTotalBytes` | 64 MiB | 512 MiB |
| `language` | `en` | 支持 en、zh、zh-TW、ja、ko、ru、vi 的导览和分层标签 |
| `autoUpdate` | `false` | 安装 hook 后启用 |

通过 `ua_config` 保存。环境变量支持 `UA_LANGUAGE`、`UA_MAX_FILES`、`UA_MAX_FILE_BYTES`。超大文件、不可读路径和扫描上限都会出现在结果中。scope 不允许通过符号链接跳出项目。

## 实验能力

业务域、知识库和 Figma 能力保留，默认不注册。需要使用时，在插件现有配置行中设置以下配置块（片段）：

```yaml
config:
  experimental: true
```

启用后增加 `ua_domain`、`ua_knowledge`、`ua_figma` 及对应 3 个技能。只有 Figma 会发起网络请求，其凭据来自环境变量 `FIGMA_TOKEN`。实验图谱不会随代码 hook 自动更新。页面默认展示代码图谱；查看其他图谱需显式传入 `graph: "domain"`、`"design"` 或 `"auto"`。

## 本地安装与验证

```sh
dsh plugin --profile web add link:<本机仓库路径>
npm test
npm pack --dry-run --ignore-scripts
```

发布方式见 [发布说明](docs/PUBLISHING.md)。

零运行时依赖。要求 Node.js ≥ 20，DSH `>=0.2.2-rc.1 <0.3.0`。

## 已知限制

扫描器使用词法与正则提取，不是 AST 或类型检查器。虽然会屏蔽注释、字符串和 JavaScript 正则字面量，复杂语法、模板插值、宏、重导出、相对路径与 `tsconfig.json` `paths` 别名之外的模块解析规则和动态派发仍可能遗漏。多行 Rust `use a::{ ... };` 树会按叶子路径逐条展开，覆盖嵌套花括号、`self`、取 `as` 之前真实路径的别名，以及保留为 `a::*` 的通配符；`pub use` 重导出行仍不会匹配。行号指向声明位置，不表示完整函数范围。推断关系和模型注释应作为审阅线索。

任意层级的以下目录都不参与扫描：`.git`、`node_modules`、`vendor`、`dist`、`build`、`out`、`coverage`、`.next`、`.nuxt`、`.svelte-kit`、`.cache`、`.parcel-cache`、`.turbo`、`target`、`bin`、`obj`、`__pycache__`、`.venv`、`venv`、`.mypy_cache`、`.pytest_cache`、`.idea`、`.vscode`、`.dsh`、`.ua`、`Pods`、`DerivedData`、`.gradle`、`tmp`、`temp`、`logs`，以及其他所有隐藏目录；锁文件、压缩/打包产物与二进制文件同样跳过。这是既定排除规则：若你的源码恰好位于其中，用 `scope` 指定子树。

页面是有上限的离线快照，最多展示 1,200 个节点、4,000 条边；不提供实时编辑，源码节选由工具按需读取。插件在 DSH 宿主进程内运行，没有安全沙箱；路径检查不能防御其他恶意进程并发修改文件系统。
