/**
 * Figma → knowledge-graph adapter (zero dependencies, pure Node ESM, Node 20+).
 *
 * `parseFileKey` validates a file key before it is ever used in a URL.
 * `fetchFigmaDocument` talks to the public Figma REST API.
 * `buildDesignGraph` turns a Figma file document into the same
 * project / nodes / edges / layers / tour shape that lib/graph.mjs produces for
 * source code, so the dashboard and query tools can consume either graph kind.
 *
 * The module deliberately has NO imports: `URL`, `Date` and `globalThis.fetch`
 * are Node globals, which keeps the bundle installable out-of-tree.
 *
 * Security notes:
 *  - File keys are whitelisted (letters/digits/`_`/`-`, length 10..128) so a
 *    caller cannot inject a path, query or fragment into the api.figma.com
 *    request (SSRF / path injection). Only http(s) URLs on figma.com are
 *    interpreted as URLs.
 *  - The personal access token is placed ONLY in the request header. It is
 *    never returned, logged, written into an exception message, or stored in
 *    the graph. Every exposed error string passes through a redactor first.
 */

const KEY_RE = /^[A-Za-z0-9_-]{10,128}$/;
const API_BASE = 'https://api.figma.com/v1/files/';
const FIGMA_HOSTS = new Set(['figma.com', 'www.figma.com']);
const URL_MARKERS = new Set(['file', 'design', 'proto']);

/** Graph construction limits (defense against hostile / runaway documents). */
const MAX_NODES = 5000;
const MAX_DEPTH = 12;

const NODE_PREFIX = {
  screen: 'screen',
  component: 'component',
  componentSet: 'componentSet',
  instance: 'instance',
};

/**
 * Extract and whitelist-validate a Figma file key.
 *
 * Accepts a bare key or a full Figma URL:
 *   https://www.figma.com/file/<key>/Title
 *   https://www.figma.com/design/<key>/Title?node-id=...#frag
 *   www.figma.com/file/<key>/Title            (scheme optional)
 *   <key>                                    (bare)
 *
 * @param {unknown} input
 * @returns {string} the whitelisted file key
 * @throws {Error} 'INVALID_FIGMA_KEY' for empty / malformed / non-figma input
 */
export function parseFileKey(input) {
  if (typeof input !== 'string') throw new Error('INVALID_FIGMA_KEY');
  const raw = input.trim();
  if (!raw) throw new Error('INVALID_FIGMA_KEY');

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
  const looksLikeHost = /^(?:www\.)?figma\.com\//i.test(raw);
  let candidate = raw;

  if (hasScheme || looksLikeHost) {
    // Only http(s) may be interpreted as a URL; reject every other scheme and
    // any host that is not exactly figma.com / www.figma.com (blocks userinfo
    // tricks such as https://www.figma.com@evil.example/...).
    if (hasScheme && !/^https?:\/\//i.test(raw)) throw new Error('INVALID_FIGMA_KEY');
    let url;
    try {
      url = new URL(hasScheme ? raw : `https://${raw}`);
    } catch {
      throw new Error('INVALID_FIGMA_KEY');
    }
    if (!FIGMA_HOSTS.has(url.hostname.toLowerCase())) throw new Error('INVALID_FIGMA_KEY');
    // query / fragment are already separated by the URL parser, so pathname
    // yields clean segments.
    const parts = url.pathname.split('/').filter(Boolean);
    const marker = parts.findIndex((p) => URL_MARKERS.has(p));
    if (marker < 0 || !parts[marker + 1]) throw new Error('INVALID_FIGMA_KEY');
    candidate = parts[marker + 1];
  }

  if (!KEY_RE.test(candidate)) throw new Error('INVALID_FIGMA_KEY');
  return candidate;
}

/**
 * Fetch a Figma file document.
 *
 * Never throws for the documented failure modes; always resolves to a tagged
 * result object. The token is only ever used as a request header value.
 *
 * @param {string} urlOrKey full Figma URL or bare file key
 * @param {{token?: string, fetchImpl?: Function, signal?: AbortSignal}} [options]
 * @returns {Promise<{ok:true, doc:object} | {ok:false, error:string, [k:string]:unknown}>}
 */
export async function fetchFigmaDocument(urlOrKey, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const rawToken = opts.token ?? process.env.FIGMA_TOKEN;
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!token) return { ok: false, error: 'FIGMA_TOKEN_MISSING' };

  // Redactor: strip the token from any text before it can escape in an error
  // message or return value. Split/join is literal (no regex) and truncation
  // bounds the payload.
  const redact = (value) => {
    let text = String(value ?? '');
    if (text.includes(token)) text = text.split(token).join('[redacted]');
    return text.slice(0, 500);
  };

  let key;
  try {
    key = parseFileKey(urlOrKey);
  } catch {
    return { ok: false, error: 'INVALID_FIGMA_KEY' };
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const endpoint = `${API_BASE}${encodeURIComponent(key)}?depth=6`;
  const init = {
    method: 'GET',
    headers: { 'X-Figma-Token': token, Accept: 'application/json' },
  };
  if (opts.signal) init.signal = opts.signal;

  try {
    const response = await fetchImpl(endpoint, init);
    const status = Number.isInteger(response?.status) ? response.status : 200;
    if (status < 200 || status >= 300) {
      let message = `Figma API returned HTTP ${status}`;
      try {
        const body = await response.text();
        if (body) message += `: ${redact(body).slice(0, 300)}`;
      } catch {
        /* response body unavailable; status text is enough */
      }
      return { ok: false, error: 'FIGMA_API_ERROR', status, message: redact(message) };
    }
    const doc = await response.json();
    return { ok: true, doc };
  } catch (error) {
    return {
      ok: false,
      error: 'FIGMA_NETWORK_ERROR',
      message: redact(error?.message ?? error ?? 'request failed'),
    };
  }
}

/**
 * Build a design knowledge graph from a Figma file document.
 *
 * Traverses doc.document.children (CANVAS = page) and their descendants,
 * creating page / screen / component / componentSet / instance / token nodes,
 * then links them with contains / instance_of / uses_token edges.
 *
 * @param {object} doc parsed Figma `/v1/files/:key` response
 * @param {string} fileKey file key (used as project.name fallback)
 * @returns {object} graph in the Understand Anything shape
 */
export function buildDesignGraph(doc, fileKey) {
  const source = doc && typeof doc === 'object' ? doc : {};
  const nodes = [];
  const edges = [];
  const seenEdges = new Set();
  const seenNodeIds = new Set();
  const instanceLinks = [];
  const tokenLinks = [];
  const pageRecords = [];
  let truncated = false;
  let skippedNodes = 0;
  let stop = false;

  const makeNode = (id, type, name, layer, figmaMeta, tags = []) => ({
    id,
    type,
    name: String(name ?? ''),
    filePath: null,
    summary: '',
    tags,
    complexity: 1,
    layer,
    figmaMeta,
  });

  const addNode = (node) => {
    if (stop || nodes.length >= MAX_NODES) {
      truncated = true;
      skippedNodes += 1;
      stop = true;
      return false;
    }
    nodes.push(node);
    return true;
  };

  const addEdge = (sourceId, targetId, type, weight = 1) => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const key = `${sourceId}|${targetId}|${type}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ source: sourceId, target: targetId, type, direction: 'out', weight });
  };

  /** Collect style ids referenced by a Figma node's `styles` field. */
  const styleRefs = (node) => {
    const out = [];
    const styles = node?.styles;
    if (!styles) return out;
    const push = (value) => {
      if (typeof value === 'string' && value) out.push(value);
      else if (value && typeof value === 'object') {
        const id = value.styleId ?? value.id ?? value.key;
        if (typeof id === 'string' && id) out.push(id);
      }
    };
    if (Array.isArray(styles)) for (const v of styles) push(v);
    else if (typeof styles === 'object') for (const v of Object.values(styles)) push(v);
    return out;
  };

  /** Resolve the component id(s) an INSTANCE points at. */
  const componentRefs = (node) => {
    const out = [];
    if (typeof node.componentId === 'string' && node.componentId) out.push(node.componentId);
    const mc = node.mainComponent;
    if (typeof mc === 'string' && mc) out.push(mc);
    else if (mc && typeof mc === 'object' && typeof mc.id === 'string' && mc.id) out.push(mc.id);
    return out;
  };

  /**
   * Walk one Figma node. Unlisted types (TEXT, GROUP, nested FRAME, ...) are
   * transparent: they are traversed but produce no graph node, so their
   * children attach to the nearest created ancestor via a `contains` edge.
   * `ownId` is the graph node id that owns any styles / instance links found.
   */
  const walk = (child, parentId, pageName, depth, pageRecord) => {
    if (stop) return;
    if (depth > MAX_DEPTH) {
      truncated = true;
      skippedNodes += 1;
      return;
    }
    if (!child || typeof child !== 'object') return;

    const figmaType = typeof child.type === 'string' ? child.type : '';
    const nodeId = child.id != null ? String(child.id) : '';
    let kind = null;
    if (figmaType === 'COMPONENT') kind = 'component';
    else if (figmaType === 'COMPONENT_SET') kind = 'componentSet';
    else if (figmaType === 'INSTANCE') kind = 'instance';
    else if ((figmaType === 'FRAME' || figmaType === 'SECTION') && depth === 1) kind = 'screen';

    let ownId = parentId;
    if (kind && nodeId) {
      const id = `${NODE_PREFIX[kind]}:${nodeId}`;
      if (!seenNodeIds.has(id)) {
        seenNodeIds.add(id);
        const node = makeNode(id, kind, child.name, pageName, { nodeId, pageName, figmaType });
        if (!addNode(node)) return;
        ownId = id;
        pageRecord.nodeIds.push(id);
        if (parentId) addEdge(parentId, id, 'contains');
      }
    }

    const styles = styleRefs(child);
    if (styles.length && ownId) tokenLinks.push({ sourceId: ownId, styleIds: styles });
    if (kind === 'instance' && ownId) {
      const cids = componentRefs(child);
      if (cids.length) instanceLinks.push({ sourceId: ownId, componentIds: cids });
    }

    const children = Array.isArray(child.children) ? child.children : [];
    for (const c of children) {
      if (stop) break;
      walk(c, ownId, pageName, depth + 1, pageRecord);
    }
  };

  // ---- Pages -------------------------------------------------------------
  const pages = Array.isArray(source.document?.children) ? source.document.children : [];
  for (const page of pages) {
    if (stop) break;
    if (!page || typeof page !== 'object') continue;
    const pageName = String(page.name ?? 'Page');
    const rawPageId = page.id != null ? String(page.id) : String(pageRecords.length);
    const pageNodeId = `page:${rawPageId}`;
    const pageRecord = { pageName, pageNodeId, nodeIds: [] };

    if (!seenNodeIds.has(pageNodeId)) {
      seenNodeIds.add(pageNodeId);
      const pageNode = makeNode(pageNodeId, 'page', pageName, pageName, {
        nodeId: rawPageId,
        pageName,
        figmaType: typeof page.type === 'string' ? page.type : 'CANVAS',
      });
      if (!addNode(pageNode)) break;
      pageRecord.nodeIds.push(pageNodeId);
    }

    const children = Array.isArray(page.children) ? page.children : [];
    for (const c of children) {
      if (stop) break;
      walk(c, pageNodeId, pageName, 1, pageRecord);
    }
    pageRecords.push(pageRecord);
  }

  // ---- Design tokens (global styles, not tied to a page) ------------------
  const styleEntries = [];
  const rawStyles = source.styles;
  if (rawStyles && typeof rawStyles === 'object') {
    if (Array.isArray(rawStyles)) {
      for (let i = 0; i < rawStyles.length; i++) {
        const s = rawStyles[i] && typeof rawStyles[i] === 'object' ? rawStyles[i] : {};
        styleEntries.push([String(s.id ?? s.key ?? i), s]);
      }
    } else {
      for (const [k, v] of Object.entries(rawStyles)) {
        styleEntries.push([k, v && typeof v === 'object' ? v : {}]);
      }
    }
  }
  for (const [styleId, style] of styleEntries) {
    if (stop) break;
    const id = `token:${styleId}`;
    if (seenNodeIds.has(id)) continue;
    seenNodeIds.add(id);
    const name = String(style.name ?? styleId);
    const styleType = String(style.styleType ?? '');
    const tags = [name, styleType].filter((t) => t.length > 0);
    const node = makeNode(id, 'token', name, 'Design Tokens', {
      nodeId: styleId,
      figmaType: styleType || 'STYLE',
    }, tags);
    if (!addNode(node)) break;
  }

  // ---- Resolve cross references (after every node exists) -----------------
  const allIds = new Set(nodes.map((n) => n.id));
  const componentIndex = new Map();
  for (const n of nodes) {
    if ((n.type === 'component' || n.type === 'componentSet') && n.figmaMeta?.nodeId) {
      componentIndex.set(n.figmaMeta.nodeId, n.id);
    }
  }
  for (const link of instanceLinks) {
    for (const cid of link.componentIds) {
      const target = componentIndex.get(cid);
      if (target && target !== link.sourceId) addEdge(link.sourceId, target, 'instance_of');
    }
  }
  for (const link of tokenLinks) {
    for (const sid of link.styleIds) {
      const target = `token:${sid}`;
      if (allIds.has(target) && target !== link.sourceId) addEdge(link.sourceId, target, 'uses_token');
    }
  }

  // Integrity: dedup (already enforced), no self-loops, both ends must exist.
  const validEdges = edges.filter(
    (e) => allIds.has(e.source) && allIds.has(e.target) && e.source !== e.target,
  );

  // ---- Stats / layers / tour / project ------------------------------------
  const countType = (t) => nodes.reduce((acc, n) => acc + (n.type === t ? 1 : 0), 0);
  const stats = {
    pages: countType('page'),
    screens: countType('screen'),
    components: countType('component'),
    componentSets: countType('componentSet'),
    instances: countType('instance'),
    tokens: countType('token'),
    edges: validEdges.length,
    truncated,
  };

  const layers = pageRecords.map((p) => ({
    id: p.pageNodeId,
    name: p.pageName,
    description: `Figma page: ${p.pageName}`,
    nodeIds: p.nodeIds.slice(),
  }));

  const tour = pageRecords.map((p, i) => ({
    order: i + 1,
    title: `Page ${i + 1}: ${p.pageName}`,
    description: `Explore the ${p.pageName} page: its screens, components, instances and tokens.`,
    nodeIds: p.nodeIds.slice(),
  }));

  const project = {
    name: String(source.name || fileKey || 'Figma design'),
    description: 'Figma design file',
    languages: ['figma'],
    frameworks: [],
    analyzedAt: new Date().toISOString(),
    gitCommitHash: '',
  };

  return {
    kind: 'design',
    figmaVersion: source.version ?? '',
    project,
    nodes,
    edges: validEdges,
    layers,
    tour,
    truncated,
    skippedNodes,
    meta: {
      generator: 'dsh-understand-anything',
      kind: 'design',
      stats,
    },
  };
}
