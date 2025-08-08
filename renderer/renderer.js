const ui = {
  btnOpenWorkspace: document.getElementById('btn-open-workspace'),
  workspacePath: document.getElementById('workspace-path'),
  btnInit: document.getElementById('btn-init'),
  btnPlan: document.getElementById('btn-plan'),
  btnRefresh: document.getElementById('btn-refresh'),
  btnApply: document.getElementById('btn-apply'),
  btnDestroy: document.getElementById('btn-destroy'),
  resourcesList: document.getElementById('resources-list'),
  resourceDetails: document.getElementById('resource-details'),
  logsPre: document.getElementById('logs-pre'),
  // Tabs & Graph
  tabInspect: document.getElementById('tab-inspect'),
  tabGraph: document.getElementById('tab-graph'),
  graphPanel: document.getElementById('graph-panel'),
  graphArea: document.getElementById('graph-area'),
  // Cytoscape graph container is #cy
  contextMenu: document.getElementById('context-menu'),
  // Refactor
  mvSrc: document.getElementById('mv-src'),
  mvDst: document.getElementById('mv-dst'),
  btnStateMv: document.getElementById('btn-state-mv'),
  rmAddr: document.getElementById('rm-addr'),
  btnStateRm: document.getElementById('btn-state-rm'),
  // Import
  importAddr: document.getElementById('import-addr'),
  importId: document.getElementById('import-id'),
  btnImport: document.getElementById('btn-import'),
};

let state = {
  cwd: '',
  resources: [],
  selectedAddress: '',
  graph: { nodes: [], edges: [] },
  graphPositions: new Map(), // address -> {x,y}
};

let cy = null;
let cyEventsBound = false;

// -------- Helpers for graph addressing --------
function baseAddress(address) {
  if (!address) return '';
  return String(address).replace(/\[[^\]]+\]/g, '');
}

function normalizeRefToAddress(ref) {
  if (!ref) return null;
  const s = String(ref);
  // Capture optional module chain followed by type.name[optional index]
  const m = s.match(/((?:module\.[^.]+\.)*[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+(?:\[[^\]]+\])?)(?:\.|$)/);
  return m ? m[1] : null;
}

function isGraphActive() {
  return !ui.graphPanel.classList.contains('hidden');
}

function getModulePrefixFromAddress(address) {
  // Extract leading module chain: module.foo.module.bar
  const parts = String(address).split('.');
  const prefix = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === 'module' && i + 1 < parts.length) {
      prefix.push(parts[i], parts[i + 1]);
      i += 1;
    } else {
      break;
    }
  }
  return prefix.join('.'); // '' when root
}

function makeScopedVarId(varRef, modulePrefix) {
  // varRef like 'var.name' → returns 'var.name' for root or 'module.<path>.var.name' for scoped
  const m = String(varRef).match(/^var\.(.+)$/);
  if (!m) return null;
  const name = m[1];
  return modulePrefix ? `${modulePrefix}.var.${name}` : `var.${name}`;
}

function setWorkspace(cwd) {
  state.cwd = cwd || '';
  ui.workspacePath.textContent = cwd || 'No workspace selected';
}

async function ensureWorkspaceSelected() {
  if (state.cwd) return true;
  await pickWorkspace();
  return Boolean(state.cwd);
}

async function pickWorkspace() {
  const path = await window.api.selectWorkspace();
  if (path) {
    await window.api.setWorkspace(path);
    setWorkspace(path);
    await refreshResources();
  }
}

function appendLog({ stream, message }) {
  const prefix = stream === 'stderr' ? '[err] ' : '';
  ui.logsPre.textContent += prefix + message;
  ui.logsPre.scrollTop = ui.logsPre.scrollHeight;
}

function clearLogs() {
  ui.logsPre.textContent = '';
}

async function withLogs(task) {
  clearLogs();
  const unsubscribe = window.api.onLog(appendLog);
  try {
    const result = await task();
    if (result && typeof result.code !== 'undefined') {
      ui.logsPre.textContent += `\n[exit code ${result.code}]\n`;
    }
    return result;
  } finally {
    if (typeof unsubscribe === 'function') unsubscribe();
  }
}

function renderResources() {
  ui.resourcesList.innerHTML = '';
  state.resources.forEach((addr) => {
    const li = document.createElement('li');
    li.dataset.address = addr;
    const [type, ...rest] = addr.split('.');
    const name = rest.join('.');
    li.innerHTML = `<span class="resource-type">${type}</span><span class="resource-name">${name}</span>`;
    li.addEventListener('click', async () => {
      document.querySelectorAll('.resources-list li').forEach((el) => el.classList.remove('active'));
      li.classList.add('active');
      state.selectedAddress = addr;
      await loadResourceDetails(addr);
    });
    ui.resourcesList.appendChild(li);
  });
}

async function refreshResources() {
  if (!state.cwd) return;
  const res = await window.api.stateList(state.cwd);
  state.resources = res.resources || [];
  renderResources();
  await buildGraph();
  if (isGraphActive()) {
    renderGraph();
  }
}

async function loadResourceDetails(address) {
  if (!state.cwd) return;
  ui.resourceDetails.textContent = 'Loading...';
  const detail = await window.api.stateShow(state.cwd, address);
  const text = detail.stdout || detail.stderr || '';
  ui.resourceDetails.textContent = text.trim() || '(no details)';
}

async function doInit() {
  if (!(await ensureWorkspaceSelected())) return;
  await withLogs(() => window.api.init(state.cwd));
  await refreshResources();
  if (isGraphActive()) renderGraph();
}

async function doPlan() {
  if (!(await ensureWorkspaceSelected())) return;
  await withLogs(() => window.api.plan(state.cwd));
  // Rebuild from plan-json to immediately reflect planned graph
  await buildGraph();
  if (isGraphActive()) renderGraph();
}

async function doApply() {
  if (!(await ensureWorkspaceSelected())) return;
  await withLogs(() => window.api.apply(state.cwd));
  await refreshResources();
  if (isGraphActive()) renderGraph();
}

async function doRefresh() {
  if (!(await ensureWorkspaceSelected())) return;
  await withLogs(() => window.api.refresh(state.cwd));
  await refreshResources();
  if (isGraphActive()) renderGraph();
}

async function doDestroy() {
  if (!(await ensureWorkspaceSelected())) return;
  const ok = confirm('Are you sure you want to destroy all managed infrastructure?');
  if (!ok) return;
  await withLogs(() => window.api.destroy(state.cwd));
  await refreshResources();
  if (isGraphActive()) renderGraph();
}

async function doStateMove() {
  if (!(await ensureWorkspaceSelected())) return;
  const src = ui.mvSrc.value.trim();
  const dst = ui.mvDst.value.trim();
  if (!src || !dst) return alert('Provide both source and destination addresses');
  await withLogs(() => window.api.stateMove(state.cwd, src, dst));
  await refreshResources();
  if (state.selectedAddress === src) {
    state.selectedAddress = dst;
    await loadResourceDetails(dst);
  }
}

async function doStateRemove() {
  if (!(await ensureWorkspaceSelected())) return;
  const addr = ui.rmAddr.value.trim();
  if (!addr) return alert('Provide an address to remove');
  const ok = confirm(`Remove ${addr} from state? This does not destroy remote resources.`);
  if (!ok) return;
  await withLogs(() => window.api.stateRemove(state.cwd, addr));
  await refreshResources();
  if (state.selectedAddress === addr) {
    state.selectedAddress = '';
    ui.resourceDetails.textContent = 'Select a resource to view details';
  }
}

async function doImport() {
  if (!(await ensureWorkspaceSelected())) return;
  const addr = ui.importAddr.value.trim();
  const id = ui.importId.value.trim();
  if (!addr || !id) return alert('Provide both address and ID');
  await withLogs(() => window.api.importResource(state.cwd, addr, id));
  await refreshResources();
}

// ---------------- Graph ----------------
function activateTab(which) {
  if (which === 'inspect') {
    ui.tabInspect.classList.add('active');
    ui.tabGraph.classList.remove('active');
    document.querySelector('.split').style.display = '';
    ui.graphPanel.classList.add('hidden');
  } else {
    ui.tabGraph.classList.add('active');
    ui.tabInspect.classList.remove('active');
    document.querySelector('.split').style.display = 'none';
    ui.graphPanel.classList.remove('hidden');
    // Always rebuild when opening the Graph tab to reflect latest plan/state
    buildGraph().then(renderGraph);
  }
}

async function buildGraph() {
  // Use terraform show -json and plan -json to build a combined graph
  const [sj, pj, pg] = await Promise.all([
    window.api.showJson(state.cwd),
    window.api.planJson(state.cwd),
    window.api.planGraphDot(state.cwd),
  ]);
  const showJson = sj.json || null;
  const planJson = pj.json || null;
  const planDot = (pg && (pg.dot || pg.stdout)) || '';

  // Track using base addresses to align instances from plan and state
  const existing = new Set(state.resources.map(baseAddress));
  const plannedCreates = new Set();
  if (planJson && Array.isArray(planJson.resource_changes)) {
    for (const rc of planJson.resource_changes) {
      const actions = (rc.change && rc.change.actions) || [];
      if (actions.includes('create')) {
        if (rc.address) plannedCreates.add(baseAddress(rc.address));
        else if (rc.type && rc.name) plannedCreates.add(baseAddress(`${rc.type}.${rc.name}`));
      }
    }
  }

  // Build nodes: union of existing and planned creates
  const nodeIds = new Set([...existing, ...plannedCreates]);
  const nodeMap = new Map(Array.from(nodeIds).map((addr) => [addr, { id: addr, type: 'resource', planned: plannedCreates.has(addr) && !existing.has(addr), inputs: new Set() }]));
  const ensureNodeLocal = (addr) => {
    const key = baseAddress(addr);
    let n = nodeMap.get(key);
    if (!n) {
      n = { id: key, type: 'resource', planned: plannedCreates.has(key) && !existing.has(key), inputs: new Set() };
      nodeMap.set(key, n);
    }
    return n;
  };
  const nodes = Array.from(nodeMap.values());
  // If something was planned but now exists, it should not be marked planned (e.g., after apply)
  for (const n of nodes) {
    if (existing.has(n.id)) n.planned = false;
  }
  const edges = [];

  // Try to walk planned_values/values to find depends_on and expressions with references
  try {
    const collect = (module) => {
      if (!module) return;
      const resArr = (module.resources || []).concat(module.child_modules?.flatMap((m) => m.resources || []) || []);
      for (const r of resArr) {
        const addr = r.address || (r.type && r.name ? `${r.type}.${r.name}` : null);
        if (!addr) continue;
        const deps = new Set((r.depends_on || []).map((d) => baseAddress(normalizeRefToAddress(d) || d)));
        // Look into expressions for explicit references (plan JSON provides this)
        const expressions = r.expressions || {};
        for (const key of Object.keys(expressions)) {
          const expr = expressions[key];
          const refs = (expr.references || []).filter(Boolean);
          refs.forEach((ref) => {
            const a = normalizeRefToAddress(ref);
            if (a) deps.add(baseAddress(a));
          });
        }
        for (const d of deps) edges.push({ from: baseAddress(d), to: baseAddress(addr) });

        // Capture IO (inputs/outputs names) for this resource
        const node = ensureNodeLocal(baseAddress(addr));
        // Inputs: keys used in expressions
        for (const key of Object.keys(expressions)) node.inputs.add(key);
        // Outputs: properties available in an instance (schema unavailable, best-effort from current state attributes)
        if (r.values && typeof r.values === 'object') {
          Object.keys(r.values).forEach((k) => node.outputs.add(k));
        }
      }
      (module.child_modules || []).forEach(collect);
    };
    // Edges from current state
    if (showJson && showJson.values && showJson.values.root_module) collect(showJson.values.root_module);
    // Edges from planned state
    if (planJson && planJson.planned_values && planJson.planned_values.root_module) collect(planJson.planned_values.root_module);
  } catch (_) {
    // fallback no edges
  }

  // Also walk configuration tree to gather inputs and module/variable scoping
  try {
    const cfgRoot = planJson && planJson.configuration && planJson.configuration.root_module;
    const collectCfg = (module, moduleAddrPrefix) => {
      if (!module) return;
      const resources = module.resources || [];
      for (const r of resources) {
        const addr = baseAddress((moduleAddrPrefix ? moduleAddrPrefix + '.' : '') + `${r.type}.${r.name}`);
        ensureNodeLocal(addr);
        // Ensure module node exists (containment is visual via parent, no edge needed)
        if (moduleAddrPrefix) {
          if (!nodeMap.has(moduleAddrPrefix)) nodeMap.set(moduleAddrPrefix, { id: moduleAddrPrefix, type: 'module', planned: false, inputs: new Set() });
        }
        const expressions = r.expressions || {};
        for (const key of Object.keys(expressions)) {
          // record only variable/module inputs in use
          const refs = (expressions[key].references || []).filter(Boolean);
          refs.forEach((ref) => {
            const a = normalizeRefToAddress(ref);
            if (!a) return;
            if (a.startsWith('var.')) {
              const scopedVar = makeScopedVarId(a, moduleAddrPrefix);
              edges.push({ from: scopedVar, to: addr });
            } else if (a.startsWith('module.')) {
              const modRef = a.split('.', 2).slice(0, 2).join('.');
              edges.push({ from: modRef, to: addr });
            }
          });
        }
      }
      const calls = module.module_calls || {};
      for (const name of Object.keys(calls)) {
        const call = calls[name];
        if (call && call.module) {
          const nextPrefix = (moduleAddrPrefix ? moduleAddrPrefix + '.' : '') + `module.${name}`;
          // create/mark module node
          if (!nodeMap.has(nextPrefix)) nodeMap.set(nextPrefix, { id: nextPrefix, type: 'module', planned: false, inputs: new Set() });
          // parent module contains child module
          if (moduleAddrPrefix) edges.push({ from: moduleAddrPrefix, to: nextPrefix });
          // Module inputs: connect refs to module-scoped variable nodes (module.<name>.var.<input>)
          const modInputs = call.expressions || {};
          for (const inputName of Object.keys(modInputs)) {
            const moduleVarId = `${nextPrefix}.var.${inputName}`;
            if (!nodeMap.has(moduleVarId)) nodeMap.set(moduleVarId, { id: moduleVarId, type: 'variable', planned: false, inputs: new Set() });
            const refs = (modInputs[inputName].references || []).filter(Boolean);
            refs.forEach((ref) => {
              const a = normalizeRefToAddress(ref);
              if (!a) return;
              if (a.startsWith('var.')) {
                const scopedVar = makeScopedVarId(a, moduleAddrPrefix);
                edges.push({ from: scopedVar, to: moduleVarId });
              } else if (a.startsWith('module.')) {
                const modRef = a.split('.', 2).slice(0, 2).join('.');
                edges.push({ from: modRef, to: moduleVarId });
              } else {
                // Resource or data reference feeding this module input
                edges.push({ from: baseAddress(a), to: moduleVarId });
              }
            });
          }
          collectCfg(call.module, nextPrefix);
        }
      }
    };
    if (cfgRoot) collectCfg(cfgRoot, '');
  } catch (_) {}

  // Also parse edges from terraform graph -plan DOT output as a fallback
  try {
    const dotEdges = parseDotEdges(planDot, nodeIds);
    for (const de of dotEdges) edges.push({ from: baseAddress(de.from), to: baseAddress(de.to) });
  } catch (_) {}

  // Ensure we have nodes for all module/variable endpoints referenced by edges (including module.<path>.var.<name>)
  for (const { from, to } of edges) {
    if (from.startsWith('module.') && !nodeMap.has(from.split('.', 2).slice(0, 2).join('.'))) {
      nodeMap.set(from.split('.', 2).slice(0, 2).join('.'), { id: from.split('.', 2).slice(0, 2).join('.'), type: 'module', planned: false, inputs: new Set() });
    }
    if (to.startsWith('module.') && !nodeMap.has(to.split('.', 2).slice(0, 2).join('.'))) {
      nodeMap.set(to.split('.', 2).slice(0, 2).join('.'), { id: to.split('.', 2).slice(0, 2).join('.'), type: 'module', planned: false, inputs: new Set() });
    }
    if ((from.startsWith('var.') || from.includes('.var.')) && !nodeMap.has(from)) {
      nodeMap.set(from, { id: from, type: 'variable', planned: false, inputs: new Set() });
    }
  }

  // Filter edges to only those whose endpoints exist in nodeMap; de-duplicate
  const filteredEdges = [];
  const seen = new Set();
  for (const e of edges) {
    const validFrom = nodeMap.has(e.from) || nodeMap.has(e.from.split('.', 2).slice(0, 2).join('.'));
    const validTo = nodeMap.has(e.to) || nodeMap.has(e.to.split('.', 2).slice(0, 2).join('.'));
    if (!validFrom || !validTo) continue;
    const key = `${e.from}->${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    filteredEdges.push(e);
  }
  // Node list is whatever is in nodeMap now
  const finalNodes = Array.from(nodeMap.values());
  state.graph = { nodes: finalNodes, edges: filteredEdges };
  if (isGraphActive()) renderGraph();
}

function ensureNode(addr) {
  const key = baseAddress(addr);
  if (!key) return { id: addr, inputs: new Set(), outputs: new Set() };
  let node = null;
  for (const n of state.graph.nodes) {
    if (n.id === key) { node = n; break; }
  }
  if (!node) {
    node = { id: key, planned: false, inputs: new Set(), outputs: new Set() };
    state.graph.nodes.push(node);
  }
  return node;
}

function parseDotEdges(dot, nodeIds) {
  if (!dot) return [];
  const out = [];
  const lines = dot.split(/\r?\n/);
  const edgeRe = /"([^"]+)"\s*->\s*"([^"]+)"/;
  const addrRe = /([a-zA-Z0-9_]+\.[a-zA-Z0-9_]+(?:\[[^\]]+\])?)/g;
  for (const line of lines) {
    const m = line.match(edgeRe);
    if (!m) continue;
    const left = m[1];
    const right = m[2];
    const leftMatches = Array.from(left.matchAll(addrRe)).map((x) => baseAddress(x[1]));
    const rightMatches = Array.from(right.matchAll(addrRe)).map((x) => baseAddress(x[1]));
    const from = leftMatches.length ? leftMatches[leftMatches.length - 1] : null;
    const to = rightMatches.length ? rightMatches[rightMatches.length - 1] : null;
    if (from && to && from !== to && (nodeIds.has(from) || nodeIds.has(to))) {
      out.push({ from, to });
    }
  }
  return out;
}

function renderGraph() {
  const container = document.getElementById('cy');
  if (!cy) {
    cy = cytoscape({
      container,
      style: [
        { selector: 'node', style: { 'background-color': '#1b2534', 'label': 'data(label)', 'font-size': 10, 'text-wrap': 'wrap', 'text-max-width': 200, 'color': '#e5e7eb', 'border-width': 1, 'border-color': '#2a3a53', 'shape': 'round-rectangle' } },
        { selector: 'node[type = "module"]', style: { 'background-color': '#29251f', 'border-color': '#4b3d27', 'label': 'data(label)', 'text-valign': 'top', 'text-halign': 'center' } },
        { selector: 'node[type = "variable"]', style: { 'background-color': '#1f2a2e', 'border-color': '#27444b' } },
        { selector: 'node[planned = "true"]', style: { 'background-color': '#23202a', 'border-color': '#5b3a76' } },
        { selector: 'edge', style: { 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'line-color': '#2f6feb', 'target-arrow-color': '#2f6feb', 'width': 1.5 } }
      ]
    });
  }

  const elements = [];
  const parentSet = new Set();
  for (const n of state.graph.nodes) {
    const ele = { data: { id: n.id, label: n.id, type: n.type || 'resource', planned: String(Boolean(n.planned)) } };
    if (n.type !== 'module') {
      const parent = getModulePrefixFromAddress(n.id);
      if (parent) {
        ele.data.parent = parent;
        parentSet.add(parent);
      }
    }
    elements.push(ele);
  }
  // Ensure module parents exist
  parentSet.forEach((p) => elements.push({ data: { id: p, label: p, type: 'module', planned: 'false' } }));
  for (const e of state.graph.edges) {
    elements.push({ data: { id: `${e.from}->${e.to}`, source: e.from, target: e.to } });
  }
  cy.elements().remove();
  cy.add(elements);
  applyBestLayout();

  if (!cyEventsBound) {
    cy.on('tap', 'node', (evt) => {
      const id = evt.target.id();
      state.selectedAddress = id;
      loadResourceDetails(id);
    });
    cy.on('cxttap', 'node', (evt) => {
      const { renderedPosition } = evt.target;
      const pos = renderedPosition ? renderedPosition() : evt.position;
      const rect = cy.container().getBoundingClientRect();
      showContextMenu(rect.left + pos.x, rect.top + pos.y, evt.target.id());
    });
    cyEventsBound = true;
  }
}

function applyBestLayout() {
  if (!cy) return;
  const hasElk = !!(cy.layout && cytoscape && cytoscape.extensions && cytoscape.extensions('layout', 'elk'));
  if (hasElk) {
    cy.layout({
      name: 'elk',
      elk: {
        algorithm: 'layered',
        edgeRouting: 'ORTHOGONAL',
        layeringStrategy: 'NETWORK_SIMPLEX',
        'elk.direction': 'DOWN',
        'spacing.nodeNode': 50,
        'spacing.edgeNode': 30,
        'spacing.edgeEdge': 20,
      },
      fit: true,
      padding: 40,
      animate: false,
    }).run();
  } else {
    cy.layout({ name: 'breadthfirst', directed: true, spacingFactor: 1.3, padding: 40, animate: false }).run();
  }
  // If too many nodes share identical positions, run a second pass with cose to spread
  if (isOverlapping()) {
    cy.layout({
      name: 'cose',
      fit: true,
      padding: 40,
      animate: false,
      nodeOverlap: 10,
      nodeRepulsion: 8000,
      idealEdgeLength: 120,
      gravity: 0.8,
      numIter: 700,
    }).run();
  }
}

function isOverlapping() {
  const positions = new Map();
  const nodes = cy.nodes();
  if (nodes.length <= 2) return false;
  nodes.forEach((n) => {
    const p = n.position();
    const key = `${Math.round(p.x / 10)}:${Math.round(p.y / 10)}`; // bucketed positions
    positions.set(key, (positions.get(key) || 0) + 1);
  });
  let maxBucket = 0;
  positions.forEach((count) => { if (count > maxBucket) maxBucket = count; });
  // If any bucket contains more than 20% of nodes, treat as overlapping
  return maxBucket / nodes.length > 0.2;
}

function collapseExpandModules(collapse) {
  if (!cy || !cy.expandCollapse) return;
  const api = cy.expandCollapse('get') || cy.expandCollapse({ layoutBy: { name: 'cose', animate: false } });
  if (collapse) {
    cy.nodes('[type = "module"]').forEach((n) => api.collapse(n));
  } else {
    cy.nodes('[type = "module"]').forEach((n) => api.expand(n));
  }
}

function enableDrag(el, address) {
  let dragging = false; let startX = 0; let startY = 0; let orig = { x: 0, y: 0 };
  el.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return; // only left
    dragging = true;
    startX = ev.clientX; startY = ev.clientY;
    const p = state.graphPositions.get(address) || { x: 0, y: 0 };
    orig = { ...p };
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (ev) => {
    if (!dragging) return;
    const dx = ev.clientX - startX; const dy = ev.clientY - startY;
    const np = { x: orig.x + dx, y: orig.y + dy };
    state.graphPositions.set(address, np);
    el.style.left = np.x + 'px';
    el.style.top = np.y + 'px';
    renderEdges(); // update edges while dragging
  });
  window.addEventListener('mouseup', () => { dragging = false; document.body.style.userSelect = ''; renderEdges(); });
}

function showContextMenu(x, y, address) {
  ui.contextMenu.style.left = x + 'px';
  ui.contextMenu.style.top = y + 'px';
  ui.contextMenu.classList.remove('hidden');
  ui.contextMenu.dataset.address = address;
}

function hideContextMenu() {
  ui.contextMenu.classList.add('hidden');
  ui.contextMenu.dataset.address = '';
}

function wireContextMenu() {
  window.addEventListener('click', hideContextMenu);
  window.addEventListener('contextmenu', (e) => {
    // If not on a node, hide
    if (!(e.target.closest && e.target.closest('.graph-node'))) hideContextMenu();
  });
  ui.contextMenu.addEventListener('click', async (e) => {
    const item = e.target.closest('.menu-item');
    if (!item) return;
    const action = item.dataset.action;
    const address = ui.contextMenu.dataset.address;
    hideContextMenu();
    if (!address) return;
    if (action === 'rename') {
      const dest = prompt('New address for state mv:', address);
      if (!dest || dest === address) return;
      await withLogs(() => window.api.stateMove(state.cwd, address, dest));
      await refreshResources();
    } else if (action === 'remove') {
      const ok = confirm(`Remove ${address} from state?`);
      if (!ok) return;
      await withLogs(() => window.api.stateRemove(state.cwd, address));
      await refreshResources();
    }
  });
}

function wireEvents() {
  ui.btnOpenWorkspace.addEventListener('click', pickWorkspace);
  ui.btnInit.addEventListener('click', doInit);
  ui.btnPlan.addEventListener('click', doPlan);
  ui.btnApply.addEventListener('click', doApply);
  ui.btnRefresh.addEventListener('click', doRefresh);
  ui.btnDestroy.addEventListener('click', doDestroy);
  ui.btnStateMv.addEventListener('click', doStateMove);
  ui.btnStateRm.addEventListener('click', doStateRemove);
  ui.btnImport.addEventListener('click', doImport);
  ui.tabInspect.addEventListener('click', () => activateTab('inspect'));
  ui.tabGraph.addEventListener('click', () => activateTab('graph'));
  wireContextMenu();
}

async function boot() {
  wireEvents();
  const saved = await window.api.getWorkspace();
  if (saved) {
    setWorkspace(saved);
    await refreshResources();
  }
}

boot();



