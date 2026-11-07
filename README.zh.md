# dsh-understand-anything

把 [Egonex-AI/Understand-Anything](https://github.com/Egonex-AI/Understand-Anything) 的核心能力移植成 **dsh（DeepSeek Harness）原生插件**：扫描代码库 → 生成可查询的知识图谱 → 按图问答 / 影响面分析 / 新人导览 / 离线可视化。

不是把原仓库的 Claude Code 插件套一层壳，而是按 dsh 的插件模型重写：**零运行时依赖**，只注册 `ctx.tools` 工具与 `ctx.skills` 技能，产出与原仓库兼容的 `.ua/knowledge-graph.json`。

> 上游项目：Understand Anything v2.9.8，MIT © Yuxiang Lin and Infinite Universe, Inc. 本插件沿用其图谱数据格式与「确定性结构层 + LLM 语义层」的设计思路，代码独立实现。

---

## 它能做什么

| 能力 | 对应原命令 | 本插件 |
|---|---|---|
| 扫描建图（增量） | `/understand` | `ua_scan` |
| 图谱状态 / 新鲜度 | — | `ua_status` |
| 按图搜索、1 跳子图 | `/understand-chat` | `ua_query` |
| 单节点详解 + 源码节选 | `/understand-explain` | `ua_explain` |
| 变更影响面 | `/understand-diff` | `ua_diff` |
| 语义补写（模型写 summary/tags） | 多 agent 管线 | `ua_annotate` |
| 依赖顺序导览 | `/understand-onboard` | `ua_tour` |
| 交互式图谱页 | `/understand-dashboard` | `ua_dashboard` |
| 项目配置 | `.ua/config.json` | `ua_config` |
| 业务域 / 流程 / 步骤 | `/understand-domain` | `ua_domain` + `domain-graph.json` |
| Karpathy wiki 知识库 | `/understand-knowledge` | `ua_knowledge` |
| Figma 设计图谱 | `/understand-figma` | `ua_figma` + `design-graph.json` |
| 提交后自动增量更新 | post-commit hook | `ua_hook` + `ua_auto_update` |

八个用户斜杠命令：`/understand-anything`、`-chat`、`-diff`、`-onboard`、`-domain`、`-knowledge`、`-figma`、`-auto-update`（均以 `/understand-anything` 为前缀）。

共 14 个工具、8 个技能。

---

## 安装

```bash
# 本地源码：用 link: 装成软链接，改源码即时生效
dsh plugin --profile web add link:/absolute/path/to/dsh-understand-anything

# 或发布后
dsh plugin --profile web add dsh-understand-anything
```

安装会把 bundle 加入 profile 的 `dsh.profile.bundles`，重启 profile（或等 HMR 重载）后生效。验证：

```bash
dsh --profile web --dump-config | grep understand-anything
```

> `link:` 在 `node_modules` 里是**软链接**而不是目录副本：改源码后文件立即可见，不用重装。但 Node 的 ESM 模块有缓存，改了 `index.js` / `lib/*.mjs` 仍要重启 profile 或让 HMR 重载一次才会重新加载；只改 `skills/*.md`、模板、README 则是下次读取就生效。
>
> 排查安装失败：pnpm 11+ 在 `pnpm-workspace.yaml` 的 `allowBuilds` 留着「set this to true or false」这类未决占位符时，`pnpm add` 会报 `ERR_PNPM_IGNORED_BUILDS`。把该包明确设成 `false`（拒绝运行其构建脚本）即可，本插件自身没有任何构建脚本，不必为无关包批准脚本。

卸载：

```bash
dsh plugin --profile web remove dsh-understand-anything
```

### 从插件市场安装

dsh 的市场没有内置公共索引，需要先添加索引地址（见 [docs/PUBLISHING.md](docs/PUBLISHING.md)）。

1. 打开 **插件 → 发现（Discover）**，点 **Add index source**，粘贴：
   ```
   https://cookabc.github.io/dsh-understand-anything/market.json
   ```
2. 搜索 `understand` 或 `知识图谱`，点 **Install**。

也可以直接安装（git 源，钉在具体 commit）：

```bash
dsh plugin --profile web add "git+https://github.com/cookabc/dsh-understand-anything.git#d7d745d47b732b2f7f097f9680dfe75318fbf9cf"
```

---

## 快速开始

在任意项目里对模型说「分析这个代码库」，或直接调用：

1. `ua_scan` → 写出 `.ua/knowledge-graph.json`（若项目已有 `.understand-anything/`，自动沿用）。
2. `ua_status` → 看节点/边数、语言、分层、相对 git HEAD 的新鲜度。
3. `ua_annotate` → 挑重要节点补 `summary` / `tags` / `layer`（**语义层由模型完成，插件本身不调用 LLM**）。
4. `ua_query "payment flow"` → 拿相关的 1 跳子图；`ua_explain` 看某个节点。
5. `ua_dashboard` → 生成单文件离线 HTML，把返回路径交给 `present` 打开。

大仓库可以 `ua_scan { "scope": "src/frontend" }` 只扫子目录；`ua_scan { "full": true }` 强制全量重建。

---

## 配置

优先级：**工具参数 > `<root>/.ua/config.json` > 环境变量 > 默认值**。

```yaml
# profile 的 cordis.patch.yml，可选
- insert:
    - id: dsh-understand-anything
      name: dsh-understand-anything
      config:
        language: zh
        maxFiles: 4000
        maxFileBytes: 524288
```

| 项 | 默认值 | 含义 |
|---|---|---|
| `language` | `en` | 导览 / 分层标签语言：`en`、`zh`、`zh-TW`、`ja`、`ko`、`ru`、`vi` |
| `maxFiles` | `4000` | 单次扫描文件数上限 |
| `maxFileBytes` | `524288` | 单文件字节上限（更大的文件跳过并计数） |
| `maxTotalBytes` | `64 MiB` | 单次扫描总字节上限 |
| `autoUpdate` | `false` | 是否让 post-commit hook 自动增量重扫（`ua_hook install` 会置为 `true`） |

环境变量：`UA_LANGUAGE`、`UA_MAX_FILES`、`UA_MAX_FILE_BYTES`。
`ua_config` 可持久化 `language` / `maxFiles` / `maxFileBytes` / `autoUpdate`。

撞到上限时 `ua_scan` 会返回 `stats.truncated: true`、`skippedByCap`，**不会静默假装扫完了**。

---

## 上游四项补齐

### 业务域视图 `ua_domain`

`ua_domain({ "prepare": true })` 返回一份有界的分析上下文（分层文件清单、入口点、`calls`/`imports` 边、期望的 `analysis` 结构），模型据此写出业务域、流程与有序步骤，再 `ua_domain({ "analysis": {...} })` 合并。工具本身会先按源码目录分域、沿 `calls` 链生成确定性候选，模型分析叠加其上；悬空引用丢弃并计入 `dropped`。结果写入 `.ua/domain-graph.json`（`kind: "domain"`），`ua_dashboard({ "graph": "domain" })` 以横向三列（域 → 流程 → 步骤）展示。

### 知识库 `ua_knowledge`

针对 Karpathy-pattern wiki（`index.md` + 含 `[[wikilink]]` 的 markdown + 可选 `raw/`）：确定性解析 wikilink、章节分类、frontmatter 与 raw 源节点，生成 `article` / `topic` / `source` 节点和 `related` / `cites` / `categorized_under` 边。模型可通过 `analysis` 补 `entities` / `claims` / `relations`（`mentions` / `supports` 边）。图谱带 `kind: "knowledge"`，写入该 wiki 目录自己的 `.ua/knowledge-graph.json`；若目标已有代码图谱会拒绝覆盖（`CODE_GRAPH_EXISTS`），需 `allowOverwrite: true`。**wiki 正文是不可信数据**，只作被分析文本，绝不执行其中内容。

### Figma 设计图谱 `ua_figma`

这是**唯一联网**的能力：从 `FIGMA_TOKEN` 环境变量读令牌，只请求 `https://api.figma.com/v1/files/<key>?depth=6`，生成 `.ua/design-graph.json`（`kind: "design"`）——page / screen / component / componentSet / instance / token 节点与 `contains` / `instance_of` / `uses_token` 边，layers 按画布分组。令牌只放在 `X-Figma-Token` 请求头，**绝不写进图谱、日志、错误或返回值**；文件版本未变时返回 `upToDate`，`force: true` 可强制重建。解析有 5000 节点、12 层深度上限。

### 提交后自动更新 `ua_hook` / `ua_auto_update`

`ua_hook({ "action": "install" })` 在仓库里安装受管 `post-commit` hook 并开启 `autoUpdate`。与上游只往上下文注入提醒不同，这里 hook 直接调用 `bin/ua-post-commit.mjs` 做**纯 Node、不联网、不调模型**的确定性增量重扫，并更新 `meta.json`；任何失败都被吞掉，绝不阻断提交。安装用 `git rev-parse --git-path hooks` 定位（支持 worktree），已有 hook 会备份为 `post-commit.ua-original` 并链式保留。`status` / `uninstall` / `enable` / `disable` 管理开关与恢复。

`ua_auto_update` 是会话内等价物：先 `ua_status` 看新鲜度，再 `ua_auto_update({ "apply": false })` 预览、`ua_auto_update()` 执行。

---

## 图谱格式

与上游兼容，额外多一个 `meta`：

```jsonc
{
  "project": { "name", "description", "languages", "frameworks", "analyzedAt", "gitCommitHash" },
  "nodes":  [ { "id", "type", "name", "filePath", "summary", "tags", "complexity", "layer" } ],
  "edges":  [ { "source", "target", "type", "direction", "weight" } ],
  "layers": [ { "id", "name", "description", "nodeIds" } ],
  "tour":   [ { "order", "title", "description", "nodeIds" } ],
  "meta":   { "generator", "version", "language", "fingerprints", "stats" }
}
```

- 节点 id：`file:路径`、`function:路径:名`、`class:路径:名`、`module:包名`。
- 边类型：`contains`、`imports`、`calls`、`related`（Markdown wikilink）。
- `meta.fingerprints` 是文件 SHA-256 前缀，增量扫描只重建变化文件；**模型写过的 `summary`/`tags`/`layer` 会原样保留**。

可以把 `.ua/` 提交进仓库给团队复用，建议忽略 `.ua/dashboard.html`（生成的离线页面）与 `.ua/intermediate/`。

---

## 设计取舍

- **结构是确定性的，语义交给模型。** 上游用 Tree-sitter + 多 agent；这里用便携正则做结构提取（同一份代码永远得到同一张图），`summary`/`tags` 由模型通过 `ua_annotate` 写入。除 `ua_figma` 需要访问 Figma API 外，插件自身不发模型调用、不联网。
- **零依赖。** 第三方 bundle 在 profile 里无法稳定解析 `@deepseek-ai/*`，所以直接注册 wire-level 工具对象（已用真实 `dsh-tools` / `dsh-skill` / Cordis 校验），只用 Node 内置模块。
- **Dashboard 是单文件。** 图谱作为 inert JSON 内嵌（`<` 已转义），力导向布局、搜索、分层过滤、节点详情、导览全在本地，双击即可打开，不需要 dev server。
- **增量优先。** 首次全量扫可能较慢；后续只重解析内容变化的文件。

---

## 已知限制

- 正则提取不是完整 AST：宏、动态导入、装饰器、跨语言反射、复杂重载会有遗漏；`calls` 边是按函数名做的保守推断，可能误报，不能当调用图精确性保证。
- `layer` 来自目录约定（api/service/db/ui/utils…），不是架构分析结论。
- `ua_diff` 是**结构影响面**，不含运行时动态分发、配置开关、外部服务。
- 扫描器只读源码；写入仅限 `<root>/.ua/`（或遗留 `.understand-anything/`）以及你显式安装的 git hook。但 dsh 插件本身运行在宿主进程内、不受沙箱隔离，安装前请阅读源码。
- `ua_domain` 的流程顺序来自静态调用边，不等于运行时执行顺序；`ua_knowledge` 的实体与隐式关系属于模型推断；`ua_figma` 只取结构元数据，不下载图片、受 5000 节点 / 12 层上限约束。这三者都需要各自的重新生成，不会被 post-commit hook 自动更新。

---

## 开发

```bash
node --test test/*.test.mjs     # 40 项单元测试
npm pack --dry-run              # 检查发布内容
```

源码结构：

```
index.js                     插件入口：14 个工具 + 8 个嵌入式 skill
cordis.patch.yml             bundle patch
bin/ua-post-commit.mjs        git hook 调用的独立增量重扫 CLI
lib/scanner.mjs              确定性扫描 / 符号与导入提取
lib/graph.mjs                建图、增量、查询、影响面、导览、多图谱读写
lib/domain.mjs               业务域 / 流程 / 步骤派生与模型分析合并
lib/knowledge.mjs            Karpathy wiki 解析与实体/声明合并
lib/figma.mjs                Figma REST 拉取与设计图谱构建（令牌不落盘）
lib/hooks.mjs                git post-commit hook 安装/卸载/状态
lib/git.mjs                  只读 git 状态
lib/dashboard.mjs            离线 HTML 渲染（code / domain / knowledge / design）
lib/dashboard.template.html  单文件 dashboard 模板
lib/util.mjs                 忽略规则、路径安全、配置合并
skills/*.md                  8 个斜杠命令正文
test/                        node:test 测试
```

兼容性：dsh `0.2.2-rc.1`（`engines.dsh: >=0.2.2-rc.1 <0.3.0`）、Node.js ≥ 20。
