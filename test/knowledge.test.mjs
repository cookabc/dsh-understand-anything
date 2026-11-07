import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseKnowledgeBase, mergeKnowledgeAnalysis } from '../lib/knowledge.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'ua-kb-'));

async function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

/** A small Karpathy wiki with topics, aliases, sources and unresolved links. */
async function wiki() {
  const root = await tmp();
  await writeFiles(root, {
    'index.md': [
      '# My Wiki',
      '',
      'See [[Alpha]] and [[Missing Page]].',
      '',
      '## Concepts',
      '- [[Alpha]]',
      '- [[Beta]]',
      '',
      '## Sources',
      '- [[raw/paper.pdf]]',
      '',
    ].join('\n'),
    'Alpha.md': [
      '---',
      'title: Alpha Page',
      'tags: [core, intro]',
      'description: The alpha article.',
      '---',
      '# Alpha',
      '',
      'Links to [[Beta|the beta page]] and [[Ghost]].',
      '',
    ].join('\n'),
    'Beta.md': '# Beta\n\nBack to [[Alpha]].\n',
    'notes/Gamma.md': '# Gamma\n\nSee [[Beta]].\n',
    'raw/paper.pdf': 'rawbytes',
    'raw/README.md': '# Raw\n\n[[Alpha]] must not be parsed as an article.\n',
    'sources/data.json': '{"x":1}\n',
  });
  return root;
}

test('detects Karpathy wikis and rejects non-wikis', async () => {
  // Empty directory.
  {
    const root = await tmp();
    try {
      const r = await parseKnowledgeBase(root);
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'NOT_KARPATHY_WIKI');
      assert.equal(r.detail.indexFound, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  // No index.md at all.
  {
    const root = await tmp();
    try {
      await writeFiles(root, { 'A.md': '[[B]]', 'B.md': '[[A]]', 'C.md': '[[A]]' });
      const r = await parseKnowledgeBase(root);
      assert.equal(r.ok, false);
      assert.equal(r.detail.indexFound, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  // index.md present but fewer than two files contain wikilinks.
  {
    const root = await tmp();
    try {
      await writeFiles(root, { 'index.md': '# Index\n', 'A.md': '[[B]]', 'B.md': 'plain text' });
      const r = await parseKnowledgeBase(root);
      assert.equal(r.ok, false);
      assert.equal(r.detail.indexFound, true);
      assert.equal(r.detail.wikilinkFiles, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  // index.md matching is case-insensitive (INDEX.MD).
  {
    const root = await tmp();
    try {
      await writeFiles(root, { 'INDEX.MD': '# Index\n\n[[A]]\n', 'A.md': '[[B]]', 'B.md': '[[A]]' });
      const r = await parseKnowledgeBase(root);
      assert.equal(r.ok, true);
      assert.equal(r.graph.kind, 'knowledge');
      assert.ok(r.graph.nodes.some((n) => n.id === 'article:INDEX.MD'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('resolves wikilinks, cites sources, counts unresolved, no dangling edges', async () => {
  const root = await wiki();
  try {
    const r = await parseKnowledgeBase(root);
    assert.equal(r.ok, true);
    const { graph } = r;
    assert.equal(graph.meta.stats.wikilinks, 9);
    assert.equal(graph.meta.stats.unresolved, 2);

    assert.ok(graph.edges.some((e) => e.source === 'article:Alpha.md'
      && e.target === 'article:Beta.md' && e.type === 'related'));
    assert.ok(graph.edges.some((e) => e.source === 'article:index.md'
      && e.target === 'source:raw/paper.pdf' && e.type === 'cites'));
    // Unresolved links never become edges.
    assert.ok(!graph.edges.some((e) => e.target === 'ghost' || e.target === 'missingpage'));

    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const e of graph.edges) {
      assert.ok(ids.has(e.source), `edge source exists: ${e.source}`);
      assert.ok(ids.has(e.target), `edge target exists: ${e.target}`);
    }
    assert.equal(
      new Set(graph.edges.map((e) => `${e.source}|${e.target}|${e.type}`)).size,
      graph.edges.length,
      'edges are deduplicated',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('index.md headings become topics, categorized_under edges and an ordered tour', async () => {
  const root = await wiki();
  try {
    const { graph } = await parseKnowledgeBase(root);
    const topics = graph.nodes.filter((n) => n.type === 'topic');
    assert.deepEqual(topics.map((t) => t.name).sort(), ['Concepts', 'Sources']);
    assert.equal(graph.meta.stats.topics, 2);

    const concepts = topics.find((t) => t.name === 'Concepts');
    assert.ok(graph.edges.some((e) => e.source === 'article:Alpha.md'
      && e.target === concepts.id && e.type === 'categorized_under'));
    assert.ok(graph.edges.some((e) => e.source === 'article:Beta.md'
      && e.target === concepts.id && e.type === 'categorized_under'));

    assert.deepEqual(graph.tour.map((s) => s.title), ['Concepts', 'Sources']);
    assert.deepEqual(graph.tour.map((s) => s.order), [1, 2]);
    assert.ok(graph.tour.every((s) => Array.isArray(s.nodeIds) && s.nodeIds.length > 0));
    assert.ok(graph.tour[0].nodeIds.includes(concepts.id));
    assert.ok(graph.tour[0].nodeIds.includes('article:Alpha.md'));

    const layer = graph.layers.find((l) => l.name === 'Concepts');
    assert.ok(layer && layer.nodeIds.includes(concepts.id)
      && layer.nodeIds.includes('article:Alpha.md'));
    const covered = new Set(graph.layers.flatMap((l) => l.nodeIds));
    for (const n of graph.nodes) assert.ok(covered.has(n.id), `layer covers ${n.id}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('raw/ and sources/ files become source nodes; their content is never parsed', async () => {
  const root = await wiki();
  try {
    const { graph } = await parseKnowledgeBase(root);
    assert.equal(graph.meta.stats.sources, 3);
    const paper = graph.nodes.find((n) => n.id === 'source:raw/paper.pdf');
    assert.equal(paper.type, 'source');
    assert.equal(paper.layer, 'Source');
    assert.equal(paper.name, 'paper.pdf');
    assert.equal(typeof paper.size, 'number');
    assert.ok(paper.size > 0);
    // raw/README.md contains a wikilink, but sources are never read or linked.
    assert.ok(!graph.edges.some((e) => e.source === 'source:raw/README.md'));
    assert.ok(!graph.nodes.some((n) => n.id === 'article:raw/README.md'));

    const alpha = graph.nodes.find((n) => n.id === 'article:Alpha.md');
    assert.equal(alpha.frontmatter.title, 'Alpha Page');
    assert.equal(alpha.frontmatter.description, 'The alpha article.');
    assert.ok(alpha.frontmatter.tags.includes('core'));
    assert.ok(alpha.headings.includes('Alpha'));

    assert.equal(graph.project.languages[0], 'markdown');
    assert.deepEqual(graph.project.frameworks, []);
    assert.equal(graph.project.gitCommitHash, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('mergeKnowledgeAnalysis dedupes entities and drops dangling/self relations', async () => {
  const root = await wiki();
  try {
    const { graph } = await parseKnowledgeBase(root);
    const before = graph.nodes.length;
    const res = mergeKnowledgeAnalysis(graph, {
      entities: [
        { name: 'Alpha Page', summary: 'an entity', tags: ['x'], article: 'article:Alpha.md' },
        { name: 'alpha page', article: 'article:Alpha.md' },
        { name: 'Orphan' },
      ],
      claims: [
        { text: 'Alpha relates to Beta', article: 'article:Alpha.md', subject: 'Alpha', object: 'Beta' },
        { name: 'not a claim' },
      ],
      relations: [
        { source: 'entity:alpha-page', target: 'entity:orphan', type: 'relates', weight: 0.5 },
        { source: 'entity:alpha-page', target: 'entity:orphan', type: 'relates', weight: 0.5 },
        { source: 'entity:alpha-page', target: 'does:not:exist' },
        { source: 'entity:alpha-page', target: 'entity:alpha-page' },
        { source: 42, target: 'x' },
      ],
    });
    assert.equal(res.graph, graph, 'same graph object is returned');
    assert.equal(res.added.entities, 2);
    assert.equal(res.added.claims, 1);
    assert.equal(res.added.relations, 1);
    assert.equal(res.dropped, 4);

    assert.ok(graph.edges.some((e) => e.type === 'mentions'
      && e.source === 'article:Alpha.md' && e.target === 'entity:alpha-page'));
    assert.ok(graph.edges.some((e) => e.type === 'supports'
      && e.source === 'article:Alpha.md'));
    const claim = graph.nodes.find((n) => n.type === 'claim');
    assert.equal(claim.subject, 'Alpha');
    assert.equal(claim.object, 'Beta');
    assert.equal(graph.nodes.length, before + 3);

    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const e of graph.edges) {
      assert.ok(ids.has(e.source) && ids.has(e.target));
      assert.notEqual(e.source, e.target);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('graph shape, meta stats and edge integrity across repeated merges', async () => {
  const root = await wiki();
  try {
    const r = await parseKnowledgeBase(root);
    assert.equal(r.ok, true);
    const g = r.graph;
    assert.equal(g.meta.generator, 'dsh-understand-anything');
    assert.equal(g.meta.kind, 'knowledge');
    assert.equal(g.project.name, basename(root));
    assert.equal(typeof g.project.analyzedAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(g.project.analyzedAt)));

    for (const key of ['articles', 'sources', 'topics', 'wikilinks', 'unresolved', 'edges']) {
      assert.equal(typeof g.meta.stats[key], 'number', `stats.${key}`);
    }
    assert.equal(g.meta.stats.edges, g.edges.length);

    const first = mergeKnowledgeAnalysis(g, {
      entities: [{ name: 'E1' }],
      claims: [{ text: 'C1' }],
      relations: [{ source: 'entity:e1', target: 'article:Alpha.md' }],
    });
    assert.equal(first.graph, g);
    const second = mergeKnowledgeAnalysis(g, {
      entities: [{ name: 'E1' }],
      relations: [{ source: 'entity:e1', target: 'claim:1' }],
    });
    assert.equal(second.graph, g);
    assert.equal(second.added.entities, 0, 'entity deduped against existing node');
    assert.equal(second.added.relations, 1);

    const ids = new Set(g.nodes.map((n) => n.id));
    const keys = new Set();
    for (const e of g.edges) {
      assert.ok(ids.has(e.source) && ids.has(e.target));
      assert.notEqual(e.source, e.target);
      const k = `${e.source}|${e.target}|${e.type}`;
      assert.ok(!keys.has(k), 'no duplicate edge');
      keys.add(k);
    }
    assert.equal(g.meta.stats.edges, g.edges.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('oversize files and the file cap are skipped and counted', async () => {
  // Oversize .md article is skipped, never read.
  {
    const root = await tmp();
    try {
      const big = 'x'.repeat(600 * 1024);
      await writeFiles(root, {
        'index.md': '# Index\n\n## T\n\n- [[a]]\n- [[b]]\n',
        'a.md': '# A\n\n[[b]]\n',
        'b.md': '# B\n\n[[a]]\n',
        'Huge.md': `# Huge\n\n${big}\n[[a]]\n`,
      });
      const r = await parseKnowledgeBase(root);
      assert.equal(r.ok, true);
      assert.ok(!r.graph.nodes.some((n) => n.id === 'article:Huge.md'));
      assert.equal(r.graph.meta.skipped.oversize, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  // File cap: index.md plus two wikilink articles still collected, rest skipped.
  {
    const root = await tmp();
    try {
      const files = {
        'index.md': '# Index\n\n## T\n\n- [[a]]\n- [[b]]\n',
        'a.md': '# A\n\n[[b]]\n',
        'b.md': '# B\n\n[[a]]\n',
      };
      for (let i = 0; i < 8; i += 1) files[`raw/f${i}.bin`] = 'x';
      await writeFiles(root, files);
      const r = await parseKnowledgeBase(root, { maxFiles: 5 });
      assert.equal(r.ok, true);
      assert.ok(r.graph.meta.skipped.byCap > 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
