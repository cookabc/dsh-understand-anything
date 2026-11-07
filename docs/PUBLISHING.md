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

然后把这个 `market.json` 放到任何 **HTTPS 静态地址**（GitHub Pages / 对象存储 / 自建站都行），得到形如：

```
https://your-domain.example/dsh-understand-anything/market.json
```

要求：URL 必须是 `http:`/`https:`，不能带账号密码、不能带 fragment；JSON 里 `icon` 用相对路径会按索引 URL 解析。

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
