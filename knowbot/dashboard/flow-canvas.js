// Bots & buckets canvas — ReactFlow from pinned esm.sh ES modules (no build step, no JSX).
// Only this canvas is React; the panel around it and the rest of the dashboard stay vanilla DOM.
// Text from the server reaches the DOM only as React children (escaped), never as HTML.

const URLS = {
  react: 'https://esm.sh/react@18.3.1',
  client: 'https://esm.sh/react-dom@18.3.1/client?deps=react@18.3.1', // same react-dom build that @xyflow/react imports
  flow: 'https://esm.sh/@xyflow/react@12.3.6?deps=react@18.3.1,react-dom@18.3.1',
};
export const FLOW_CSS = 'https://cdn.jsdelivr.net/npm/@xyflow/react@12.3.6/dist/style.css';
const POS_KEY = 'knowbot-flow-positions';
const COL_X = { bucket: 0, bot: 480 };
const ROW_H = { bucket: 140, bot: 140 };

function readPositions() { try { return JSON.parse(localStorage.getItem(POS_KEY) || '{}') || {}; } catch { return {}; } }
function writePositions(nodes) {
  try { const o = readPositions(); for (const n of nodes) o[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) }; localStorage.setItem(POS_KEY, JSON.stringify(o)); }
  catch { /* storage blocked: layout lasts this page view */ }
}
export const nodeId = (kind, id) => `${kind}:${id}`;

/**
 * Mount the canvas into el. render(props) re-renders with:
 * { buckets, bots, counts: Map, editable, colorMode, active: 'bucket:x'|'bot:y'|null, version,
 *   onSelect(kind|null, id), onLink(botId, bucketId), onToggle(botId, bucketId), onUnlink(botId, bucketId) }
 */
export async function createCanvas(el) {
  const [R, RD, XY] = await Promise.all([import(URLS.react), import(URLS.client), import(URLS.flow)]);
  const React = R.default || R;
  const { createElement: e, useState, useEffect, useCallback, useRef, memo, Fragment } = React;
  const { ReactFlow, Background, Controls, Handle, Position, BaseEdge, EdgeLabelRenderer, getBezierPath, applyNodeChanges, applyEdgeChanges } = XY;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  function filesLabel(d) {
    if (d.item.builtin) return 'synced corpus';
    const c = d.count;
    if (!c) return d.canCount ? 'files …' : 'files —';
    if (c.failed) return `${plural(c.n, 'file')} · ${c.failed} failed`;
    if (c.processing) return `${plural(c.n, 'file')} · ${c.processing} processing`;
    return c.n ? `${plural(c.n, 'file')} · ready` : 'empty';
  }
  // Node icons: a folder of documents for a bucket, a bot head with a speech tail for a bot.
  const svg = (...kids) => e('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' }, ...kids);
  const BucketIcon = () => e('span', { className: 'fnode-icon fnode-icon-bucket' }, svg(
    e('path', { d: 'M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z' }),
    e('path', { d: 'M8 12h8M8 15.5h5' })));
  const BotIcon = () => e('span', { className: 'fnode-icon fnode-icon-bot' }, svg(
    e('path', { d: 'M12 3.5v3' }), e('circle', { cx: 12, cy: 2.8, r: 0.9, fill: 'currentColor', stroke: 'none' }),
    e('path', { d: 'M7 6.5h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-6l-3.5 2.5v-2.5H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z' }),
    e('circle', { cx: 9.3, cy: 12, r: 1.1, fill: 'currentColor', stroke: 'none' }), e('circle', { cx: 14.7, cy: 12, r: 1.1, fill: 'currentColor', stroke: 'none' }),
    e('path', { d: 'M1.8 11v3M22.2 11v3' })));
  const BucketNode = memo(({ data: d }) => e('div', { className: `fnode fnode-bucket${d.active ? ' is-active' : ''}${d.count && d.count.failed ? ' has-failed' : ''}` },
    e(BucketIcon), e('div', { className: 'fnode-body' },
    e('div', { className: 'fnode-kicker' }, e('span', null, 'bucket'), d.item.builtin ? e('span', { className: 'flag flag-inst' }, 'built-in') : null,
      e('span', { className: 'fnode-out', title: 'Bots this bucket feeds' }, `→ ${plural(d.out, 'bot')}`)),
    e('div', { className: 'fnode-name' }, d.item.name),
    e('div', { className: 'fnode-folder' }, d.item.folder),
    e('div', { className: 'fnode-meta' }, filesLabel(d))),
    e(Handle, { type: 'source', position: Position.Right, isConnectable: d.editable, className: 'fhandle', title: d.editable ? 'Drag to a bot to link' : undefined })));
  const BotNode = memo(({ data: d }) => e('div', { className: `fnode fnode-bot${d.active ? ' is-active' : ''}${d.enabled ? '' : ' is-empty'}` },
    e(Handle, { type: 'target', position: Position.Left, isConnectable: d.editable, className: 'fhandle' }),
    e(BotIcon), e('div', { className: 'fnode-body' },
    e('div', { className: 'fnode-kicker' }, e('span', null, 'bot'), d.item.builtin ? e('span', { className: 'flag flag-inst' }, 'built-in') : null),
    e('div', { className: 'fnode-name' }, d.item.name),
    e('div', { className: 'fnode-folder' }, d.item.id, d.item.modelLabel ? e('div', { className: 'fnode-model' }, d.item.modelLabel) : null),
    e('div', { className: `fnode-meta${d.enabled ? '' : ' warn'}` }, d.enabled ? `${plural(d.enabled, 'bucket')} on${d.linked > d.enabled ? ` · ${d.linked - d.enabled} off` : ''}` : d.linked ? 'all buckets off — answers nothing' : 'no buckets — answers nothing'))));

  function LinkEdge(p) {
    const [path, lx, ly] = getBezierPath(p);
    const d = p.data;
    return e(Fragment, null,
      e(BaseEdge, { id: p.id, path, className: `fedge ${d.enabled ? 'on' : 'off'}${p.selected ? ' sel' : ''}`, interactionWidth: 24 }),
      d.enabled ? e('path', { d: path, className: 'fedge-flow', fill: 'none' }) : null,
      e(EdgeLabelRenderer, null, e('div', {
        className: `fedge-label nodrag nopan${d.enabled ? ' on' : ' off'}`,
        style: { transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` },
      },
        e('button', {
          type: 'button', className: 'fedge-toggle', disabled: !d.editable, 'aria-pressed': String(d.enabled),
          'aria-label': `${d.bucketName} → ${d.botName}: ${d.enabled ? 'on' : 'off'}.${d.editable ? ' Activate to turn ' + (d.enabled ? 'off' : 'on') : ''}`,
          title: d.editable ? `Turn ${d.enabled ? 'off' : 'on'}: ${d.botName} ${d.enabled ? 'stops' : 'starts'} citing ${d.bucketName}` : `${d.enabled ? 'On' : 'Off'} (read-only)`,
          onClick: (ev) => { ev.stopPropagation(); d.onToggle(); },
        }, e('span', { className: 'fedge-dot', 'aria-hidden': 'true' }), d.enabled ? 'on' : 'off'),
        d.editable ? e('button', { type: 'button', className: 'fedge-x', 'aria-label': `Unlink ${d.bucketName} from ${d.botName}`, title: 'Unlink', onClick: (ev) => { ev.stopPropagation(); d.onUnlink(); } }, '×') : null)));
  }
  const nodeTypes = { bucket: BucketNode, bot: BotNode };
  const edgeTypes = { link: LinkEdge };

  function buildNodes(p, prev) {
    const saved = readPositions();
    const old = new Map(prev.map((n) => [n.id, n]));
    const out = [];
    const outCount = new Map();
    for (const b of p.bots) for (const l of b.buckets) outCount.set(l.id, (outCount.get(l.id) || 0) + 1);
    const place = (kind, i, id) => (old.get(id) || {}).position || saved[id] || { x: COL_X[kind], y: i * ROW_H[kind] };
    p.buckets.forEach((b, i) => {
      const id = nodeId('bucket', b.id);
      out.push({ id, type: 'bucket', position: place('bucket', i, id), selected: !!(old.get(id) || {}).selected, deletable: false,
        ariaLabel: `Bucket ${b.name}, folder ${b.folder}`,
        data: { kind: 'bucket', item: b, count: p.counts.get(b.id), canCount: p.canCount, out: outCount.get(b.id) || 0, editable: p.editable, active: p.active === id } });
    });
    p.bots.forEach((b, i) => {
      const id = nodeId('bot', b.id);
      out.push({ id, type: 'bot', position: place('bot', i, id), selected: !!(old.get(id) || {}).selected, deletable: false,
        ariaLabel: `Bot ${b.name}`,
        data: { kind: 'bot', item: b, linked: b.buckets.length, enabled: b.buckets.filter((l) => l.enabled).length, editable: p.editable, active: p.active === id } });
    });
    return out;
  }
  function buildEdges(p, prev, ref) {
    const sel = new Set(prev.filter((x) => x.selected).map((x) => x.id));
    const names = new Map(p.buckets.map((b) => [b.id, b.name]));
    const out = [];
    for (const bot of p.bots) for (const l of bot.buckets) {
      if (!names.has(l.id)) continue;
      const id = `${l.id}->${bot.id}`;
      out.push({ id, type: 'link', source: nodeId('bucket', l.id), target: nodeId('bot', bot.id), selected: sel.has(id), deletable: p.editable,
        ariaLabel: `${names.get(l.id)} feeds ${bot.name}, ${l.enabled ? 'on' : 'off'}`,
        data: { enabled: l.enabled, editable: p.editable, bucketName: names.get(l.id), botName: bot.name,
          onToggle: () => ref.current.onToggle(bot.id, l.id), onUnlink: () => ref.current.onUnlink(bot.id, l.id) } });
    }
    return out;
  }
  const parse = (nid) => { const i = nid.indexOf(':'); return [nid.slice(0, i), nid.slice(i + 1)]; };

  function App(p) {
    const ref = useRef(p); ref.current = p;
    const inst = useRef(null);
    const [nodes, setNodes] = useState(() => buildNodes(p, []));
    const [edges, setEdges] = useState(() => buildEdges(p, [], ref));
    const nCount = p.buckets.length + p.bots.length;
    const lastN = useRef(nCount);
    useEffect(() => { setNodes((prev) => buildNodes(p, prev)); setEdges((prev) => buildEdges(p, prev, ref)); }, [p.version, p.editable, p.active]);
    useEffect(() => {
      if (nCount > lastN.current && inst.current) setTimeout(() => inst.current.fitView({ padding: 0.2, duration: 300, maxZoom: 1 }), 60);
      lastN.current = nCount;
    }, [nCount]);
    const onNodesChange = useCallback((ch) => setNodes((ns) => applyNodeChanges(ch.filter((c) => c.type !== 'remove'), ns)), []);
    // Removals go through the server (onEdgesDelete); the edge disappears when the graph comes back.
    const onEdgesChange = useCallback((ch) => setEdges((es) => applyEdgeChanges(ch.filter((c) => c.type !== 'remove'), es)), []);
    const linked = (bucket, bot) => ref.current.bots.some((b) => b.id === bot && b.buckets.some((l) => l.id === bucket));
    const ends = (c) => {
      let [sk, s] = parse(c.source || ''), [tk, t] = parse(c.target || '');
      if (sk === 'bot' && tk === 'bucket') [sk, s, tk, t] = [tk, t, sk, s];
      return sk === 'bucket' && tk === 'bot' ? [s, t] : null;
    };
    const isValidConnection = useCallback((c) => { const x = ends(c); return !!x && !linked(x[0], x[1]); }, []);
    const onConnect = useCallback((c) => { const x = ends(c); if (x && !linked(x[0], x[1])) ref.current.onLink(x[1], x[0]); }, []);
    const onEdgesDelete = useCallback((es) => { for (const ed of es) { const [bucket, bot] = ed.id.split('->'); ref.current.onUnlink(bot, bucket); } }, []);
    const onNodeClick = useCallback((ev, n) => ref.current.onSelect(n.data.kind, n.data.item.id), []);
    const onNodeDragStop = useCallback((ev, n, all) => writePositions(all && all.length ? all : [n]), []);
    // Enter on a focused node opens its details (ReactFlow nodes take focus with Tab).
    const onKeyDown = (ev) => {
      if (ev.key !== 'Enter') return;
      const n = ev.target.closest && ev.target.closest('.react-flow__node');
      if (n && n.dataset.id) { const [k, id] = parse(n.dataset.id); ref.current.onSelect(k, id); }
    };
    return e('div', { className: 'flow-rf', onKeyDown },
      e(ReactFlow, {
        nodes, edges, nodeTypes, edgeTypes, onNodesChange, onEdgesChange, onConnect, isValidConnection, onEdgesDelete, onNodeClick, onNodeDragStop,
        onPaneClick: () => ref.current.onSelect(null), onInit: (i) => { inst.current = i; },
        colorMode: p.colorMode, fitView: true, fitViewOptions: { padding: 0.2, maxZoom: 1 }, minZoom: 0.2, maxZoom: 2,
        nodesConnectable: p.editable, edgesFocusable: true, elementsSelectable: true, deleteKeyCode: p.editable ? ['Delete', 'Backspace'] : null,
        connectionRadius: 36, proOptions: { hideAttribution: false }, defaultEdgeOptions: { type: 'link' },
      },
        e(Background, { gap: 22, size: 1.2 }),
        e(Controls, { showInteractive: false, position: 'bottom-left' })));
  }

  const root = RD.createRoot(el);
  return { render: (props) => root.render(e(App, props)), unmount: () => root.unmount() };
}
