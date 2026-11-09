/**
 * Parse a Karpathy-style LLM wiki into a knowledge graph.
 *
 * Wiki content is UNTRUSTED DATA. Files are read as UTF-8 text and parsed only
 * with regular expressions; nothing is evaluated, imported or executed, and no
 * text is treated as an instruction. Files under raw/ and sources/ are never
 * opened at all -- only stat()ed for their size.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

const GENERATOR = 'dsh-understand-anything';
const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const SOURCE_DIRS = new Set(['raw', 'sources']);
const SKIP_DIRS = new Set(['node_modules', '.ua', '.understand-anything']);
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const TOPIC_HEADING_RE = /^(#{2,3})\s+(.+?)\s*#*\s*$/;
const FM_LINE_RE = /^\s*([A-Za-z_][\w.-]*)\s*:\s*(.*?)\s*$/;

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** Fold a link/path for case-insensitive basename matching. */
function fold(s) {
  return String(s).toLowerCase().replace(/\.md$/i, '').replace(/[\s_-]+/g, '');
}

function stripExt(s) {
  return String(s).replace(/\.[^./\\]+$/, '');
}

function baseName(s) {
  return String(s).split(/[\\/]/).pop() || String(s);
}

function slug(s) {
  const out = String(s).toLowerCase().trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || 'item';
}

function unquote(s) {
  const v = String(s).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/** Extract [[target]] / [[target|alias]] links without evaluating the text. */
function extractLinks(text) {
  const re = /\[\[([^\[\]\n]+)\]\]/g;
  const links = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    const pipe = raw.indexOf('|');
    const target = (pipe >= 0 ? raw.slice(0, pipe) : raw).trim();
    if (target) links.push({ raw, target });
  }
  return links;
}

function extractHeadings(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = HEADING_RE.exec(line);
    if (m) out.push(m[2].trim());
  }
  return out;
}

/** Simple `key: value` YAML frontmatter (no YAML parser, no evaluation). */
function parseFrontmatter(text) {
  const fm = {};
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') return fm;
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end < 0) return fm;
  const block = lines.slice(1, end);
  for (let i = 0; i < block.length; i += 1) {
    const m = FM_LINE_RE.exec(block[i]);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'tags') {
      if (val) {
        fm.tags = val.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean);
      } else {
        const tags = [];
        for (let j = i + 1; j < block.length; j += 1) {
          const lm = /^\s*-\s+(.*?)\s*$/.exec(block[j]);
          if (!lm) break;
          tags.push(unquote(lm[1]));
          i = j;
        }
        fm.tags = tags.filter(Boolean);
      }
    } else if (key === 'title' || key === 'description') {
      fm[key] = unquote(val);
    }
  }
  return fm;
}

/** Recursively collect candidate files, ignoring build/hidden directories. */
async function collectFiles(root, maxFiles) {
  const found = [];
  let skippedByCap = 0;

  async function rec(dir, relDir, inSource) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) continue;
        await rec(abs, rel, inSource || SOURCE_DIRS.has(ent.name.toLowerCase()));
        continue;
      }
      if (!ent.isFile()) continue;
      const isSource = inSource;
      if (!isSource && !ent.name.toLowerCase().endsWith('.md')) continue;
      if (found.length >= maxFiles) { skippedByCap += 1; continue; }
      let st;
      try { st = await stat(abs); } catch { continue; }
      found.push({ rel, abs, size: st.size, isSource });
    }
  }

  await rec(root, '', false);
  return { found, skippedByCap };
}

export async function parseKnowledgeBase(wikiDir, options = {}) {
  const root = String(wikiDir ?? '');
  const opts = isObject(options) ? options : {};
  const maxFiles = positiveInt(opts.maxFiles, DEFAULT_MAX_FILES);
  const maxFileBytes = positiveInt(opts.maxFileBytes, DEFAULT_MAX_FILE_BYTES);

  const { found, skippedByCap } = await collectFiles(root, maxFiles);

  // Articles are read (bounded); sources are never opened.
  const articles = [];
  const sources = [];
  let skippedOversize = 0;
  let skippedUnreadable = 0;
  for (const f of found) {
    if (f.isSource) {
      sources.push({ rel: f.rel, size: f.size });
      continue;
    }
    if (f.size > maxFileBytes) { skippedOversize += 1; continue; }
    let text;
    try { text = await readFile(f.abs, 'utf8'); }
    catch { skippedUnreadable += 1; continue; }
    articles.push({ rel: f.rel, text });
  }

  // Gate: an index.md (case-insensitive) plus >= 2 .md files with wikilinks.
  const isIndex = (a) => baseName(a.rel).toLowerCase() === 'index.md';
  const indexEntry = articles.find((a) => isIndex(a) && !a.rel.includes('/'))
    ?? articles.find(isIndex);
  let wikilinkFiles = 0;
  for (const a of articles) {
    if (extractLinks(a.text).length > 0) wikilinkFiles += 1;
  }
  if (!indexEntry || wikilinkFiles < 2) {
    return {
      ok: false,
      reason: 'NOT_KARPATHY_WIKI',
      detail: {
        indexFound: Boolean(indexEntry),
        mdFiles: articles.length,
        wikilinkFiles,
        requiredWikilinkFiles: 2,
      },
    };
  }

  // Nodes: one per article, one per source.
  const nodes = [];
  const articleLinks = new Map();
  for (const a of articles) {
    const links = extractLinks(a.text);
    const fm = parseFrontmatter(a.text);
    const name = baseName(stripExt(a.rel));
    const node = {
      id: `article:${a.rel}`,
      type: 'article',
      name,
      filePath: a.rel,
      summary: '',
      tags: Array.isArray(fm.tags) ? fm.tags : [],
      complexity: 1,
      layer: 'Article',
      // Extracted metadata stays inert data; it is never executed.
      frontmatter: fm,
      title: fm.title ?? name,
      headings: extractHeadings(a.text),
      wikilinks: links.map((l) => l.target),
    };
    nodes.push(node);
    articleLinks.set(node.id, links);
  }
  for (const s of sources) {
    nodes.push({
      id: `source:${s.rel}`,
      type: 'source',
      name: baseName(s.rel),
      filePath: s.rel,
      summary: '',
      tags: [],
      complexity: 1,
      layer: 'Source',
      size: s.size,
    });
  }

  // Lookup maps: folded basename and folded full path.
  const register = (map, key, id) => { if (key && !map.has(key)) map.set(key, id); };
  const articleIndex = new Map();
  const sourceIndex = new Map();
  for (const n of nodes) {
    if (n.type === 'article') {
      register(articleIndex, fold(baseName(n.filePath)), n.id);
      register(articleIndex, fold(n.filePath), n.id);
    } else if (n.type === 'source') {
      register(sourceIndex, fold(n.filePath), n.id);
      register(sourceIndex, fold(baseName(n.filePath)), n.id);
      register(sourceIndex, fold(stripExt(n.filePath)), n.id);
      register(sourceIndex, fold(baseName(stripExt(n.filePath))), n.id);
    }
  }
  const lookup = (map, target) => {
    const variants = [
      fold(target),
      fold(baseName(target)),
      fold(stripExt(target)),
      fold(baseName(stripExt(target))),
    ];
    for (const v of variants) {
      if (map.has(v)) return map.get(v);
    }
    return null;
  };

  // index.md headings become topics; links beneath them are categorized.
  const sections = [];
  const usedSlugs = new Map();
  const topicIds = new Set();
  let current = null;
  for (const line of indexEntry.text.split(/\r?\n/)) {
    const hm = TOPIC_HEADING_RE.exec(line);
    if (hm) {
      const title = hm[2].trim();
      let sl = slug(title);
      const seen = usedSlugs.get(sl) ?? 0;
      usedSlugs.set(sl, seen + 1);
      if (seen > 0) sl = `${sl}-${seen + 1}`;
      let id = `topic:${sl}`;
      let k = 2;
      while (topicIds.has(id)) { id = `topic:${sl}-${k}`; k += 1; }
      topicIds.add(id);
      nodes.push({ id, type: 'topic', name: title, summary: '', tags: [], complexity: 1, layer: 'Topic' });
      current = { topicId: id, title, slug: sl, articleIds: [] };
      sections.push(current);
    }
    if (!current) continue;
    for (const link of extractLinks(line)) {
      const aid = lookup(articleIndex, link.target);
      if (aid) current.articleIds.push(aid);
    }
  }
  for (const section of sections) section.articleIds = [...new Set(section.articleIds)];

  // Edges are added only after every node exists, then deduplicated.
  const ids = new Set(nodes.map((n) => n.id));
  const seenEdges = new Set();
  const edges = [];
  const addEdge = (source, target, type, weight = 1) => {
    if (!source || !target || source === target) return false;
    if (!ids.has(source) || !ids.has(target)) return false;
    const key = `${source}|${target}|${type}`;
    if (seenEdges.has(key)) return false;
    seenEdges.add(key);
    edges.push({ source, target, type, direction: 'out', weight, certainty: 'observed' });
    return true;
  };

  let wikilinkCount = 0;
  let unresolved = 0;
  for (const [articleId, links] of articleLinks) {
    for (const link of links) {
      wikilinkCount += 1;
      let hit = false;
      const aid = lookup(articleIndex, link.target);
      if (aid) {
        hit = true;
        if (aid !== articleId) addEdge(articleId, aid, 'related');
      }
      const sid = lookup(sourceIndex, link.target);
      if (sid) {
        hit = true;
        addEdge(articleId, sid, 'cites');
      }
      if (!hit) unresolved += 1;
    }
  }
  for (const section of sections) {
    for (const aid of section.articleIds) addEdge(aid, section.topicId, 'categorized_under');
  }

  // Layers grouped by topic, with fallback layers for uncategorized nodes.
  const covered = new Set();
  const layers = [];
  for (const section of sections) {
    const nodeIds = [section.topicId, ...section.articleIds];
    layers.push({ id: `topic-${section.slug}`, name: section.title, description: '', nodeIds });
    for (const id of nodeIds) covered.add(id);
  }
  const rest = new Map();
  for (const n of nodes) {
    if (covered.has(n.id)) continue;
    const key = n.layer || 'Other';
    if (!rest.has(key)) rest.set(key, []);
    rest.get(key).push(n.id);
  }
  for (const [key, nodeIds] of rest) {
    layers.push({ id: key.toLowerCase(), name: key, description: '', nodeIds });
  }

  // Tour follows index.md section order.
  let tour = sections.map((s, i) => ({
    order: i + 1,
    title: s.title,
    description: '',
    nodeIds: [s.topicId, ...s.articleIds],
  }));
  if (tour.length === 0) {
    tour = [{
      order: 1, title: 'Overview', description: '',
      nodeIds: nodes.filter((n) => n.type === 'article').map((n) => n.id),
    }];
  }

  const finalIds = new Set(nodes.map((n) => n.id));
  const finalEdges = edges.filter((e) => finalIds.has(e.source) && finalIds.has(e.target));

  const graph = {
    kind: 'knowledge',
    project: {
      name: basename(root) || 'wiki',
      description: '',
      languages: ['markdown'],
      frameworks: [],
      analyzedAt: new Date().toISOString(),
      gitCommitHash: null,
    },
    nodes,
    edges: finalEdges,
    layers,
    tour,
    meta: {
      generator: GENERATOR,
      kind: 'knowledge',
      stats: {
        articles: articles.length,
        sources: sources.length,
        topics: sections.length,
        wikilinks: wikilinkCount,
        unresolved,
        edges: finalEdges.length,
      },
      skipped: { oversize: skippedOversize, byCap: skippedByCap, unreadable: skippedUnreadable },
    },
  };
  return { ok: true, graph };
}

function validEntity(item) {
  if (!isObject(item)) return false;
  if (typeof item.name !== 'string' || !item.name.trim()) return false;
  if (item.summary !== undefined && typeof item.summary !== 'string') return false;
  if (item.tags !== undefined && !Array.isArray(item.tags)) return false;
  if (item.article !== undefined && typeof item.article !== 'string') return false;
  return true;
}

function validClaim(item) {
  if (!isObject(item)) return false;
  if (typeof item.text !== 'string' || !item.text.trim()) return false;
  if (item.article !== undefined && typeof item.article !== 'string') return false;
  if (item.subject !== undefined && typeof item.subject !== 'string') return false;
  if (item.object !== undefined && typeof item.object !== 'string') return false;
  return true;
}

function validRelation(item) {
  if (!isObject(item)) return false;
  if (typeof item.source !== 'string' || !item.source) return false;
  if (typeof item.target !== 'string' || !item.target) return false;
  if (item.type !== undefined && typeof item.type !== 'string') return false;
  if (item.weight !== undefined && (typeof item.weight !== 'number' || !Number.isFinite(item.weight))) return false;
  return true;
}

function nextClaimIndex(ids) {
  let max = 0;
  for (const id of ids) {
    const m = /^claim:(\d+)$/.exec(String(id));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** Merge model-authored entities/claims/relations into an existing graph. */
export function mergeKnowledgeAnalysis(graph, analysis) {
  const added = { entities: 0, claims: 0, relations: 0 };
  let dropped = 0;
  if (!graph || typeof graph !== 'object') return { graph, added, dropped };
  if (!Array.isArray(graph.nodes)) graph.nodes = [];
  if (!Array.isArray(graph.edges)) graph.edges = [];

  const ids = new Set(graph.nodes.filter((n) => n && typeof n.id === 'string').map((n) => n.id));
  const seen = new Set(graph.edges.filter(isObject)
    .map((e) => `${e.source}|${e.target}|${e.type}`));
  const addEdge = (source, target, type, weight = 1) => {
    if (source === target || !ids.has(source) || !ids.has(target)) return false;
    const key = `${source}|${target}|${type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    // Model-authored merges are marked 'model' — never confusable with the
    // lexical observations (wikilinks, index categories) above.
    graph.edges.push({ source, target, type, direction: 'out', weight, certainty: 'model', origin: 'analysis' });
    return true;
  };
  const uniqueId = (base) => {
    let id = base;
    let i = 2;
    while (ids.has(id)) { id = `${base}-${i}`; i += 1; }
    ids.add(id);
    return id;
  };

  const a = isObject(analysis) ? analysis : {};
  const entities = Array.isArray(a.entities) ? a.entities : [];
  const claims = Array.isArray(a.claims) ? a.claims : [];
  const relations = Array.isArray(a.relations) ? a.relations : [];

  // Entity nodes, deduplicated by case-insensitive name.
  const entityByName = new Map();
  for (const n of graph.nodes) {
    if (n && n.type === 'entity' && typeof n.name === 'string') {
      entityByName.set(n.name.trim().toLowerCase(), n.id);
    }
  }
  for (const item of entities) {
    if (!validEntity(item)) { dropped += 1; continue; }
    const key = item.name.trim().toLowerCase();
    let eid = entityByName.get(key);
    if (!eid) {
      eid = uniqueId(`entity:${slug(item.name)}`);
      graph.nodes.push({
        id: eid,
        type: 'entity',
        name: item.name.trim(),
        filePath: '',
        summary: typeof item.summary === 'string' ? item.summary : '',
        tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
        complexity: 1,
        layer: 'Entity',
        origin: 'analysis',
      });
      entityByName.set(key, eid);
      added.entities += 1;
    }
    if (item.article && ids.has(item.article)) addEdge(item.article, eid, 'mentions');
  }

  // Claim nodes.
  let claimNo = nextClaimIndex(ids);
  for (const item of claims) {
    if (!validClaim(item)) { dropped += 1; continue; }
    const text = item.text.trim();
    const id = uniqueId(`claim:${claimNo}`);
    claimNo += 1;
    const node = {
      id, type: 'claim', name: text.slice(0, 120), filePath: '',
      summary: text.slice(0, 2000), tags: [], complexity: 1, layer: 'Claim',
      origin: 'analysis',
    };
    if (typeof item.subject === 'string') node.subject = item.subject;
    if (typeof item.object === 'string') node.object = item.object;
    graph.nodes.push(node);
    added.claims += 1;
    if (item.article && ids.has(item.article)) addEdge(item.article, id, 'supports');
  }

  // Relations: endpoints must already exist (new entities included).
  for (const item of relations) {
    if (!validRelation(item)) { dropped += 1; continue; }
    if (!ids.has(item.source) || !ids.has(item.target) || item.source === item.target) {
      dropped += 1;
      continue;
    }
    const type = item.type && item.type.trim() ? item.type.trim() : 'related';
    const weight = typeof item.weight === 'number' ? item.weight : 1;
    if (addEdge(item.source, item.target, type, weight)) added.relations += 1;
  }

  if (graph.meta && isObject(graph.meta.stats)) graph.meta.stats.edges = graph.edges.length;
  return { graph, added, dropped };
}
