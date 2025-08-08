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
  graphEdges: document.getElementById('graph-edges'),
  graphNodes: document.getElementById('graph-nodes'),
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
}

async function doPlan() {
  if (!(await ensureWorkspaceSelected())) return;
  await withLogs(() => window.api.plan(state.cwd));
}

async function doApply() {
  if (!(await ensureWorkspaceSelected())) return;
  await withLogs(() => window.api.apply(state.cwd));
  await refreshResources();
}

async function doRefresh() {
  if (!(await ensureWorkspaceSelected())) return;
  await withLogs(() => window.api.refresh(state.cwd));
  await refreshResources();
}

async function doDestroy() {
  if (!(await ensureWorkspaceSelected())) return;
  const ok = confirm('Are you sure you want to destroy all managed infrastructure?');
  if (!ok) return;
  await withLogs(() => window.api.destroy(state.cwd));
  await refreshResources();
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
    renderGraph();
  }
}

async function buildGraph() {
  // Use terraform show -json to infer dependencies where possible
  const sj = await window.api.showJson(state.cwd);
  const json = sj.json || null;
  const resources = new Set(state.resources);
  const nodes = Array.from(resources).map((addr) => ({ id: addr, label: addr }));
  const edges = [];

  // Try to walk planned_values/values to find depends_on
  try {
    const root = json && (json.values || (json.planned_values && json.planned_values.root_module));
    const collect = (module) => {
      if (!module) return;
      const resArr = (module.resources || []).concat(module.child_modules?.flatMap((m) => m.resources || []) || []);
      for (const r of resArr) {
        const addr = r.address || (r.type && r.name ? `${r.type}.${r.name}` : null);
        if (!addr) continue;
        const deps = r.depends_on || [];
        for (const d of deps) {
          if (resources.has(addr) && resources.has(d)) edges.push({ from: d, to: addr });
        }
      }
      (module.child_modules || []).forEach(collect);
    };
    // new show -json structure
    if (json && json.values && json.values.root_module) collect(json.values.root_module);
    // planned_values structure
    if (json && json.planned_values && json.planned_values.root_module) collect(json.planned_values.root_module);
  } catch (_) {
    // fallback no edges
  }

  state.graph = { nodes, edges };
  layoutGraph();
}

function layoutGraph() {
  // Simple layered layout by type grouping; edges generally go type clusters
  const groups = new Map();
  for (const n of state.graph.nodes) {
    const type = n.id.split('.')[0];
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(n);
  }
  const types = Array.from(groups.keys());
  const width = ui.graphArea.clientWidth || 1000;
  const height = ui.graphArea.clientHeight || 600;
  const colWidth = Math.max(220, Math.floor(width / Math.max(1, types.length)));
  let x = 20;
  state.graphPositions.clear();
  for (const t of types) {
    const list = groups.get(t);
    const rowHeight = 44;
    let y = 20;
    for (const n of list) {
      state.graphPositions.set(n.id, { x, y });
      y += rowHeight;
      if (y > height - 60) y = 20; // wrap if too tall
    }
    x += colWidth;
  }
}

function renderGraph() {
  // Nodes
  ui.graphNodes.innerHTML = '';
  for (const n of state.graph.nodes) {
    const pos = state.graphPositions.get(n.id) || { x: 20, y: 20 };
    const el = document.createElement('div');
    el.className = 'graph-node';
    const [type, ...rest] = n.id.split('.');
    el.innerHTML = `<span class="type">${type}</span><span>${rest.join('.')}</span>`;
    el.style.left = pos.x + 'px';
    el.style.top = pos.y + 'px';
    el.dataset.address = n.id;
    el.addEventListener('click', () => {
      document.querySelectorAll('.graph-node').forEach((e) => e.classList.remove('selected'));
      el.classList.add('selected');
      state.selectedAddress = n.id;
      loadResourceDetails(n.id);
    });
    // Right-click context menu
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, n.id);
    });
    // Basic drag
    enableDrag(el, n.id);
    ui.graphNodes.appendChild(el);
  }
  renderEdges();
}

function renderEdges() {
  const width = ui.graphArea.clientWidth || 1000;
  const height = ui.graphArea.clientHeight || 600;
  ui.graphEdges.setAttribute('viewBox', `0 0 ${width} ${height}`);
  ui.graphEdges.innerHTML = '';
  for (const e of state.graph.edges) {
    const a = state.graphPositions.get(e.from);
    const b = state.graphPositions.get(e.to);
    if (!a || !b) continue;
    const ax = a.x + 120; // right side of node
    const ay = a.y + 14;
    const bx = b.x; // left side of node
    const by = b.y + 14;
    const mx = (ax + bx) / 2;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${ax} ${ay} C ${mx} ${ay}, ${mx} ${by}, ${bx} ${by}`);
    path.setAttribute('stroke', '#2f6feb');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('fill', 'none');
    ui.graphEdges.appendChild(path);
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



