# dsh-understand-anything

A **native DSH (DeepSeek Harness) plugin** porting the core idea of [Egonex-AI/Understand-Anything](https://github.com/Egonex-AI/Understand-Anything): scan a codebase into a queryable knowledge graph, then use it for Q&A, impact analysis, onboarding tours and an offline visual dashboard.

This is not a wrapper around the upstream Claude Code plugin. It is written against DSH's plugin model with **zero runtime dependencies**, registering `ctx.tools` and `ctx.skills` directly, and emits an upstream-compatible `.ua/knowledge-graph.json`.

> Upstream: Understand Anything v2.9.8, MIT © Yuxiang Lin and Infinite Universe, Inc. This plugin reuses the graph data format and the "deterministic structure + LLM semantics" split; the implementation is independent.

---

## What it provides

| Capability | Upstream command | This plugin |
|---|---|---|
| Scan & build (incremental) | `/understand` | `ua_scan` |
| Graph status / freshness | — | `ua_status` |
| Search + bounded 1-hop subgraph | `/understand-chat` | `ua_query` |
| Node detail with source excerpt | `/understand-explain` | `ua_explain` |
| Structural diff impact | `/understand-diff` | `ua_diff` |
| Model-authored semantics | multi-agent pipeline | `ua_annotate` |
| Dependency-ordered tour | `/understand-onboard` | `ua_tour` |
| Offline interactive dashboard | `/understand-dashboard` | `ua_dashboard` |
| Per-project settings | `.ua/config.json` | `ua_config` |
| Business domains / flows / steps | `/understand-domain` | `ua_domain` + `domain-graph.json` |
| Karpathy-pattern wiki | `/understand-knowledge` | `ua_knowledge` |
| Figma design graph | `/understand-figma` | `ua_figma` + `design-graph.json` |
| Post-commit auto-update | post-commit hook | `ua_hook` + `ua_auto_update` |

Eight user slash commands, all prefixed `/understand-anything`: `-chat`, `-diff`, `-onboard`, `-domain`, `-knowledge`, `-figma`, `-auto-update`, plus the base command. 14 tools and 8 skills in total.

---

## Install

```bash
# Local source: link: installs a symlink, so edits are visible immediately
dsh plugin --profile web add link:/absolute/path/to/dsh-understand-anything
# or, once published:
dsh plugin --profile web add dsh-understand-anything
```

The bundle is appended to `dsh.profile.bundles`; restart the profile (or wait for HMR reload). Verify with:

```bash
dsh --profile web --dump-config | grep understand-anything
```

> A `link:` dependency is a **symlink**, not a directory copy — source edits are visible without reinstalling. Node still caches ESM modules, so changes to `index.js` / `lib/*.mjs` need a profile restart or one HMR reload; `skills/*.md`, templates and docs take effect on the next read.
>
> Troubleshooting: pnpm 11+ fails `pnpm add` with `ERR_PNPM_IGNORED_BUILDS` while `allowBuilds` in `pnpm-workspace.yaml` holds an unresolved `set this to true or false` placeholder. Set that package explicitly to `false` (deny its build scripts). This plugin has no build scripts of its own, so no third-party script needs approval.

Uninstall with `dsh plugin --profile web remove dsh-understand-anything`.

### Install from the plugin market

DSH ships no built-in public index, so add an index URL first (see [docs/PUBLISHING.md](docs/PUBLISHING.md)).

1. Open **Plugins → Discover**, click **Add index source**, and paste:
   ```
   https://cookabc.github.io/dsh-understand-anything/market.json
   ```
2. Search `understand` or `knowledge graph`, then click **Install**.

Or install directly from the pinned git commit:

```bash
dsh plugin --profile web add "git+https://github.com/cookabc/dsh-understand-anything.git#d7d745d47b732b2f7f097f9680dfe75318fbf9cf"
```

---

## Quick start

1. `ua_scan` — writes `.ua/knowledge-graph.json` (an existing legacy `.understand-anything/` directory is reused automatically).
2. `ua_status` — node/edge counts, languages, layers, and staleness against git HEAD and the working tree.
3. `ua_annotate` — add `summary` / `tags` / `layer` to important nodes. **The plugin never calls an LLM itself; the model supplies the semantics.**
4. `ua_query "payment flow"` → bounded 1-hop subgraph; `ua_explain` for one node.
5. `ua_dashboard` → a single self-contained HTML file; pass its path to `present`.

For large monorepos use `ua_scan { "scope": "src/frontend" }`; use `{ "full": true }` to force a rebuild.

---

## Configuration

Precedence: **tool arguments > `<root>/.ua/config.json` > environment > defaults**.

```yaml
- insert:
    - id: dsh-understand-anything
      name: dsh-understand-anything
      config:
        language: zh
        maxFiles: 4000
        maxFileBytes: 524288
```

| Key | Default | Meaning |
|---|---|---|
| `language` | `en` | Tour / layer labels: `en`, `zh`, `zh-TW`, `ja`, `ko`, `ru`, `vi` |
| `maxFiles` | `4000` | Max scanned files per run |
| `maxFileBytes` | `524288` | Max bytes per file (larger files are skipped and counted) |
| `maxTotalBytes` | 64 MiB | Total byte budget per scan |
| `autoUpdate` | `false` | Whether the post-commit hook performs an incremental rescan (`ua_hook install` sets it to `true`) |

Env: `UA_LANGUAGE`, `UA_MAX_FILES`, `UA_MAX_FILE_BYTES`. `ua_config` persists `language` / `maxFiles` / `maxFileBytes` / `autoUpdate`.

Hitting a cap reports `stats.truncated: true` and `skippedByCap` — it never silently pretends to have scanned everything.

---

## The four upstream features

### Business domain view — `ua_domain`

`ua_domain({ "prepare": true })` returns a bounded context (files per layer, entry points, `calls`/`imports` edges, expected `analysis` shape). The model writes domains, flows and ordered steps, then `ua_domain({ "analysis": {...} })` merges them. The tool always produces deterministic candidates (domains from source directories, flows from `calls` chains) first; dangling references are dropped and reported in `dropped`. Output is `.ua/domain-graph.json` (`kind: "domain"`), rendered by `ua_dashboard({ "graph": "domain" })` as a left-to-right three-column flow view.

### Knowledge base — `ua_knowledge`

For a Karpathy-pattern wiki (`index.md` + markdown with `[[wikilinks]]` + optional `raw/`): deterministically parses wikilinks, `index.md` sections, frontmatter and raw sources into `article` / `topic` / `source` nodes with `related` / `cites` / `categorized_under` edges. The model can add `entities` / `claims` / `relations` through `analysis` (`mentions` / `supports` edges). The graph carries `kind: "knowledge"` and is written to that wiki's own `.ua/knowledge-graph.json`; an existing code graph is protected by `CODE_GRAPH_EXISTS` unless `allowOverwrite: true`. **Article text is untrusted data, never instructions.**

### Figma design graph — `ua_figma`

The **only network-facing** capability: reads `FIGMA_TOKEN` from the environment, calls `https://api.figma.com/v1/files/<key>?depth=6` only, and writes `.ua/design-graph.json` (`kind: "design"`) with page / screen / component / componentSet / instance / token nodes and `contains` / `instance_of` / `uses_token` edges, layered by canvas. The token lives solely in the `X-Figma-Token` header and is **never written to the graph, logs, errors or return values**. An unchanged file version returns `upToDate`; `force: true` rebuilds. Parsing is capped at 5000 nodes and depth 12.

### Post-commit auto-update — `ua_hook` / `ua_auto_update`

`ua_hook({ "action": "install" })` installs a managed `post-commit` hook and enables `autoUpdate`. Unlike upstream, which only injects a reminder into the model context, this hook directly runs `bin/ua-post-commit.mjs`: a pure-Node, offline, no-LLM deterministic incremental rescan that also updates `meta.json`. All errors are swallowed so a commit can never fail. Hooks are located via `git rev-parse --git-path hooks` (worktree-safe); any pre-existing hook is backed up as `post-commit.ua-original` and chained. `status` / `uninstall` / `enable` / `disable` manage it.

`ua_auto_update` is the in-session equivalent: check freshness with `ua_status`, preview with `{ "apply": false }`, then run `ua_auto_update()`.

---

## Graph format

Upstream-compatible, plus a `meta` block:

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

Node ids: `file:path`, `function:path:name`, `class:path:name`, `module:package`.
Edge types: `contains`, `imports`, `calls`, `related` (Markdown wikilinks).
`meta.fingerprints` are SHA-256 prefixes; incremental scans rebuild only changed files and **preserve model-written `summary`/`tags`/`layer`**.

Commit `.ua/` to share the graph with teammates; consider ignoring `.ua/dashboard.html`.

---

## Design decisions

- **Deterministic structure, semantic layer from the model.** Upstream uses Tree-sitter + multiple agents. Here portable regexes produce the structural graph (same bytes → same graph), while the model writes semantics through `ua_annotate`. Apart from `ua_figma` calling the Figma API, the plugin makes no model calls and no network requests.
- **Zero dependencies.** Out-of-tree bundles cannot reliably resolve `@deepseek-ai/*`, so the plugin registers wire-level tool objects directly (validated against real `dsh-tools`, `dsh-skill` and Cordis) and uses only Node built-ins.
- **Single-file dashboard.** The graph is embedded as inert JSON with `<` escaped; force layout, search, layer filters, node detail and the tour all run locally. No dev server.
- **Incremental by default.** Later runs only re-parse files whose content changed.

---

## Limitations

- Regex extraction is not a full AST: macros, dynamic imports, decorators, reflection and complex overloads can be missed. `calls` edges are conservative name-based inferences and may contain false positives.
- Layers come from directory conventions, not architectural analysis.
- `ua_diff` is a **structural** impact surface, not a runtime guarantee.
- The scanner only reads source and writes to `<root>/.ua/` (or the legacy `.understand-anything/`) plus any git hook you explicitly install. A DSH plugin still runs inside the host process without sandboxing — read the source before installing.
- Domain flow order comes from static call edges, not runtime execution; entities and implicit relations in `ua_knowledge` are model inferences; `ua_figma` extracts structure metadata only (no images, capped at 5000 nodes / depth 12). These three graphs need their own regeneration and are not refreshed by the post-commit hook.

---

## Development

```bash
node --test test/*.test.mjs   # 40 unit tests
npm pack --dry-run
```

Compatibility: DSH `0.2.2-rc.1` (`engines.dsh: >=0.2.2-rc.1 <0.3.0`), Node.js ≥ 20.
