# 发布到插件市场 / Publishing

dsh 的插件市场**没有内置的公共索引**：`pluginMarket.indexes` 默认 `[]`，用户在「发现 / Discover」里手动添加索引 URL 之后，市场才有内容。

所以要被搜到、被安装，需要两步：**先发布包**，**再把包写进一个用户可添加的索引文档**。

---

## 第一步：发布包

```bash
cd dsh-understand-anything
node --test test/*.test.mjs        # 40 项，先跑绿
npm_config_cache=/tmp/npm-cache npm pack --dry-run   # 确认清单
npm publish --access public        # 需要 npm 登录 + 已启用 2FA
```

发布前确认 `package.json` 这几项（当前已就绪）：

| 字段 | 值 | 为什么 |
|---|---|---|
| `name` | `dsh-understand-anything` | 发布时核实过 registry 未被占用 |
| `engines.dsh` | `>=0.2.2-rc.1 <0.3.0` | 市场与 `install_bundle` 用它判断兼容性 |
| `dsh.bundle.patch` | `./cordis.patch.yml` | 没有它包就不是 bundle，市场会标成 `not-a-bundle` |
| `files` | 含 `index.js`/`lib`/`bin`/`skills`/`scripts/market-index.mjs` | 缺文件会导致装完加载失败 |

> `repository` 字段现在指向上游 Egonex-AI/Understand-Anything。如果你要发布成自己的包，**改成你的仓库地址**，否则市场详情页会链到别人的项目上。

---

## 第二步：生成并托管索引

```bash
# npm 来源（推荐，发布后用）
node scripts/market-index.mjs --out market.json

# 指定 registry 或内网镜像
node scripts/market-index.mjs --registry https://registry.npmjs.org --out market.json

# Git 来源（不发布 npm，直接指向某个 commit）
node scripts/market-index.mjs --git https://github.com/you/dsh-understand-anything \
  --commit <40位小写sha> --out market.json
```

脚本会用 **dsh 自己的校验器**（`@deepseek-ai/dsh-plugin-market-index`）验证输出，通过时会打印安装目标，例如：

```
[market-index] valid; install target: dsh-understand-anything@0.1.0
```

然后把这个 `market.json` 放到任何 **HTTPS 静态地址**（GitHub Pages / 对象存储 / 自建站都行）。

要求：URL 必须是 `http:`/`https:`，不能带账号密码、不能带 fragment；JSON 里 `icon` 用相对路径会按索引 URL 解析。

> **优先用 GitHub Pages，不要用 `raw.githubusercontent.com`。** raw 是带边缘缓存的，推送后相当长时间仍返回旧内容，实测同一台机器上 Pages 已更新、raw 还停在旧 commit。启用方式：`gh api -X POST repos/<owner>/<repo>/pages -f "source[branch]=main" -f "source[path]=/"`。

---

## 第三步：用户在 dsh 里添加并使用

**图形界面**：设置 → 插件 → 发现（Discover）→ 添加索引，粘贴上面的 URL，然后在里面搜索 `understand anything`，点安装。

**或者在对话里让 agent 调 `plugin_manager`：**

```
plugin_manager({ action: "install_bundle", target: "dsh-understand-anything@0.1.0" })
```

**或者命令行：**

```bash
dsh plugin --profile web add dsh-understand-anything@0.1.0
```

---

## 索引格式要点（format 1）

被市场搜索命中的字段：`name`、`author`、`metadata.keywords`，以及所有语言的 `title` / `description` / 分类与标签标题。
中文查询会被切成字符二元组，所以 `知识图谱`、`代码分析` 这类无空格中文也能命中。

要点：

- `versions` 按 SemVer 降序，`publishTimestamp` 是 **Unix 秒**（脚本会自动从 `npm view … time` 读取，也可 `--timestamp` 指定）。
- `metadata.category` / `labels` 里用到的 id，必须在 `metadata.categories` / `labels` 里声明，否则匹配不到任何插件。
- `versions[].engines.dsh` 要与包自身 `engines.dsh` 一致，否则用户装上会在启动检查失败。

---

## 想进入「官方」推荐位？

官方预置清单由 `@deepseek-ai/dsh-official-bundles` 随 dsh 版本发布，属于上游维护范围，第三方无法通过发布 npm 自动进入。第三方分发的正规路径就是上面的「自建索引 → 用户添加」。

---

## 本仓库的现成配置

已完成的状态（可直接用）：

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/cookabc/dsh-understand-anything （public，`main`） |
| 索引地址 | `https://cookabc.github.io/dsh-understand-anything/market.json` |
| 当前索引版本 | `0.1.0`，钉在 commit `d7d745d` |
| 安装 spec | `git+https://github.com/cookabc/dsh-understand-anything.git#d7d745d47b732b2f7f097f9680dfe75318fbf9cf` |

### 发新版时更新索引

```bash
cd dsh-understand-anything
# 1) 改 package.json 的 version，提交并推送
git add -A && git commit -m "release: 0.2.0" && git push

# 2) 用新 commit 重新生成索引（索引会钉住这个 commit）
COMMIT=$(git rev-parse HEAD)
node scripts/market-index.mjs \
  --git https://github.com/cookabc/dsh-understand-anything \
  --commit "$COMMIT" --timestamp "$(git log -1 --format=%ct)" --out market.json

# 3) 提交索引并推送
git add market.json && git commit -m "chore: repin market index to ${COMMIT:0:7}" && git push
```

索引钉住 commit 是有意的：用户装到的是一棵不可变源码树，不会因为上游改动而悄悄变样。

### 市场里搜索什么

`understand`、`anything`、`knowledge graph`、`knowledge-graph`、`code-analysis`、`代码分析`、`知识图谱` 都能命中。

---

## 官方（DeepSeek）怎么规定「开发」和「上架」

来源：`deepseek-ai/deepseek-harness` 仓库
`docs/user/guide/plugin-market.md`、`docs/user/develop/basic/**`、`docs/cookbook/adding-a-tool.md`。

### 开发：官方契约

一个插件就是一个导出 `apply` 的模块：

```js
export const name = 'my-plugin'
export function apply(ctx) {
  ctx.tools.register(defineTool({ name, description, parameters, output, execute }))
}
```

要能分发，必须打成 **bundle**：

| 文件 | 作用 |
|---|---|
| `package.json` 的 `dsh.bundle.patch` | 声明它是 bundle，指向补丁层 |
| `cordis.patch.yml` | 补丁层，`name` 用**包名**引用自己（不是绝对路径） |
| 入口模块 | patch 行 `name` 解析到的那个模块 |

调试期用绝对路径的 `cordis.yml` + `dsh --profile … --patch`，发布期换成 `cordis.patch.yml` + 包名——这是官方教程里明确区分的一点。

### 上架：官方没有「提交到官方商店」这回事

官方原文只给了**两条可发现性约定**，没有审核入口、也没有集中商店：

1. **给公开仓库打 `dsh-plugin` GitHub topic。**
   官方把它称为「可发现性约定」；`awesome-deepseek-harness` 这类列表按该 topic 索引仓库。
2. **自己发布一个 format 1 的插件索引 `index.json`**，放在任意静态主机（官方点名 GitLab Pages / GitHub Pages / 对象存储），用户在其 DSH 的「发现 → 添加索引源」里填这个 URL。

官方 bundles（`@deepseek-ai/dsh-official-bundles`）随 dsh 版本发布，由上游维护，**第三方无法通过发 npm 自动进入**。

### 索引的官方硬性要求

- UTF-8 JSON，默认 ≤ 128 MiB，**HTTP 2xx 且不允许重定向**
- `format: 1`；`title` 必填且 `LocalizedText` 对象必须含 `en`
- `versions[].publishTimestamp` 是 **Unix 秒**
- `source` 二选一：`{"type":"npm","registry"?:url}` 或 `{"type":"git","url":https,"commit":40hex,"path"?:"dir"}`
- `engines.dsh` 应与包自身一致；没有时 DSH 改看 `@deepseek-ai/dsh*` peer 依赖
- `metadata.categories/labels`、`icon`、`author` 等均为可选

> 官方还带一个 **reference generator**（源码仓库 `apps/plugin-market-generator`，**未随 npm 包发布**）：
> `pnpm --filter @deepseek-ai/dsh-plugin-market-generator start --input plugins.txt --output site/index.json --title "Team plugins"`
> 它从 npm 或 git 仓库自动抓元数据。本仓库用 `scripts/market-index.mjs` 自己做同样的事，好处是不需要 dsh 源码 checkout，且用官方校验器校验。

### 社区渠道（非官方，但事实上的分发入口）

| 渠道 | 做法 |
|---|---|
| `awesome-dsh-plugin` | 向仓库提 PR 新增 `data/plugins/<owner>__<repo>.yml`；合并后 dsh-market 自动拉取 |
| `dsh-open-market`（dshopen.org） | 提交到其索引（1000+ 插件）；要求公开源码、npm 可装、有许可证 |
| `awesome-deepseek-harness` | 索引打了 `dsh-plugin` topic 的公开仓库 |

这两个社区渠道都偏向「npm 可安装」，走 git 源的插件不一定被接受。

### 本仓库对照官方要求

| 官方要求 | 状态 |
|---|---|
| 导出 `apply` 的插件 | ✅ |
| `dsh.bundle.patch` + `cordis.patch.yml`（包名引用） | ✅ |
| 公开仓库 | ✅ |
| `dsh-plugin` GitHub topic | ✅ 已打（另有 `knowledge-graph`、`deepseek-harness`） |
| 自建 format 1 索引，HTTPS 静态托管、无重定向 | ✅ GitHub Pages，官方校验器通过 |
| `engines.dsh` 一致 | ✅ `>=0.2.2-rc.1 <0.3.0` |
| 进社区 awesome 列表 | ⬜ 需要按各自规则提 PR |
| 发布到 npm | ⬜ 当前选 git 源，未发（社区渠道多要求 npm） |
