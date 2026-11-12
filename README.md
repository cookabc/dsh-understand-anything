# Understand Anything for DSH

Understand a codebase, find the source behind an answer, and inspect the structural impact of a change. The core workflow is **scan → explain → assess changes**. It runs locally, does not execute project code, and makes no model calls.

## Start here

1. `ua_scan { "root": "/path/to/project" }` builds `.ua/knowledge-graph.json`.
2. `ua_query { "root": "/path/to/project", "query": "authentication" }` finds relevant files and symbols.
3. `ua_explain { "root": "/path/to/project", "nodeId": "function:src/auth.js:authenticate" }` returns the source location, an excerpt around the definition, relationships and their evidence.
4. `ua_diff { "root": "/path/to/project" }` separates observed dependencies from possible callers. Use `base` to choose a Git commit or ref.
5. `ua_dashboard` generates an offline HTML page with a searchable source index, definition locations, layer filters and an optional inferred-call overlay.

An existing `.understand-anything/` directory is reused automatically. Explicitly pass `root` when the DSH host's working directory is not the project.

## What the graph knows

| Result | Meaning |
|---|---|
| `certainty: "observed"` | A lexical declaration, import or link was found in the scanned source. Import evidence also states how the target was resolved. This is not proof of runtime execution. |
| `certainty: "inferred"` | A call-shaped token matches a unique function name in another file. Binding, aliasing and dynamic dispatch are not verified. Ambiguous names are skipped. |
| `annotation` | A model-authored summary, tags or layer. These are preserved separately from extracted structure. |
| `annotation.stale: true` | The source changed after the annotation was written. The text is retained for review. |
| `source.stale: true` | The file read by `ua_explain` differs from the scanned file. Returned relationships may be outdated. |

Symbols carry one-based `line` and `column`. `ua_explain` returns `source.citation`, `startLine` and `endLine`; excerpts are capped at 60 lines / 6,000 characters and centered around the definition. If the source changed, the tool tries to relocate the declaration and reports whether the anchor was verified.

Non-relative imports can still resolve to internal files: when `tsconfig.json` sits at the scan root, its `baseUrl` + `paths` aliases (such as `@/*`, `~/` or monorepo package-name mappings) are applied, so aliased imports become internal edges instead of external modules. JSONC comments and trailing commas are tolerated; a missing or unparsable tsconfig leaves those imports external.

`ua_diff.upstream` follows observed relationships. `inferredUpstream` contains additional possible dependents, with `via` evidence paths. `unmappedFiles` identifies changed files absent from the graph. `truncated` means the returned impact is bounded. Invalid explicit Git refs and unavailable Git worktrees return errors instead of a misleading empty impact.

## Reliable incremental scans

- Every included source file is hashed. Unchanged files reuse cached symbols, imports and call candidates; source text itself is not cached in the graph.
- Summaries, tags and custom layers survive source edits. An annotation archive also preserves them across scope changes or temporary removal of a symbol. Changed-source annotations are marked for review.
- `scope: "src/frontend"` narrows a scan. Later scans and automatic updates keep that scope. Pass `scope: ""` to return to the whole project.
- `full: true` clears cached structure and annotations; without an explicit scope it scans the whole project.
- A capped or unreadable refresh preserves the previous graph and returns `INCOMPLETE_SCAN`. A first scan may save a partial graph, clearly marked in its statistics and dashboard. Cancelled scans do not replace the graph.
- `ua_status` compares current source bytes with the scan, including in non-Git projects. A dirty working tree that was already scanned is not falsely reported as new drift.
- Writes use unique temporary files. Mutating tools serialize per project within one plugin process. Independent host processes should not write the same graph simultaneously.

## Core tools

| Tool | Purpose |
|---|---|
| `ua_scan` | Build or refresh a graph |
| `ua_status` | Coverage, annotations and source freshness |
| `ua_query` | Bounded keyword search over nodes and annotations |
| `ua_explain` | Definition location, source excerpt and relationship evidence |
| `ua_diff` | Observed and inferred change impact |
| `ua_annotate` | Add or review summaries, tags and layers; up to 100 nodes per call |
| `ua_tour` | Dependency-oriented reading order |
| `ua_dashboard` | Offline source index and graph |
| `ua_config` | Read or save project settings |
| `ua_auto_update` | Refresh stale source structure, preserving scope |
| `ua_hook` | Install, inspect, disable or remove the opt-in post-commit hook |

The default catalog contains 11 tools and 5 skills. Git hook installation is explicit, preserves an existing hook, and enables deterministic updates without calling an LLM. Hook failures do not reject commits. Neither code scans nor automatic updates overwrite a knowledge-base graph.

## Configuration

Precedence: tool arguments > project configuration > environment > profile defaults > built-in defaults.

| Setting | Default | Limit |
|---|---:|---:|
| `maxFiles` | 4,000 | 50,000 |
| `maxFileBytes` | 512 KiB | 16 MiB |
| `maxTotalBytes` | 64 MiB | 512 MiB |
| `language` | `en` | Tour/layer labels: en, zh, zh-TW, ja, ko, ru, vi |
| `autoUpdate` | `false` | Enabled by hook installation |

Store settings with `ua_config`. Environment fallbacks: `UA_LANGUAGE`, `UA_MAX_FILES`, `UA_MAX_FILE_BYTES`. Individual oversized files, unreadable paths and scan caps are reported. Scope paths cannot resolve outside the project through symlinks.

## Experimental capabilities

Business domains, knowledge-base parsing and Figma extraction remain available but are **off by default**. Enable them only when needed in the existing plugin row's configuration (fragment below):

```yaml
config:
  experimental: true
```

This adds `ua_domain`, `ua_knowledge`, `ua_figma` and their three skills. Figma is the only network capability; it reads `FIGMA_TOKEN` from the environment. Experimental graphs are not refreshed by the code post-commit hook. The dashboard defaults to the code graph; pass `graph: "domain"`, `"design"` or `"auto"` explicitly to render other artifacts.

## Local installation and checks

```sh
dsh plugin --profile web add link:<本机仓库路径>
npm test
npm pack --dry-run --ignore-scripts
```

See [publishing instructions](docs/PUBLISHING.md) for release management.

Zero runtime dependencies. Node.js ≥ 20, DSH `>=0.2.2-rc.1 <0.3.0`.

## Limits

This is lexical extraction, not an AST/type checker. Comments, strings and JavaScript regex literals are masked, but complex syntax, template interpolation, macros, re-exports, module resolution beyond relative paths and `tsconfig.json` `paths` aliases, and dynamic dispatch may be missed. Multi-line Rust `use a::{ ... };` trees record only the root path (such as `a::`), not the items inside the braces. Source positions identify declarations; they do not describe full function ranges. Treat inferred call edges and model annotations as review aids.

Directories named `.git`, `node_modules`, `vendor`, `dist`, `build`, `out`, `coverage`, `.next`, `.nuxt`, `.svelte-kit`, `.cache`, `.parcel-cache`, `.turbo`, `target`, `bin`, `obj`, `__pycache__`, `.venv`, `venv`, `.mypy_cache`, `.pytest_cache`, `.idea`, `.vscode`, `.dsh`, `.ua`, `Pods`, `DerivedData`, `.gradle`, `tmp`, `temp`, and `logs` are skipped at any depth, as are all other hidden directories, lockfiles, minified/bundled assets and binary files. These paths are excluded by design; use `scope` to point at a subtree if your first-party code lives in one of them.

The dashboard is a bounded offline snapshot (up to 1,200 nodes / 4,000 edges), not a live editor. Source excerpts are read only when requested by a tool. The plugin runs inside the DSH process, without a security sandbox; project path checks do not protect against a hostile process racing filesystem changes.
