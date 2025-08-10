const ui = {
  btnOpenWorkspace: document.getElementById('btn-open-workspace'),
  workspacePath: document.getElementById('workspace-path'),
  snapshotIndicator: document.getElementById('snapshot-indicator'),
  spinner: document.getElementById('global-spinner'),
  tfWorkspaceSelect: document.getElementById('tf-workspace-select'),
  tfvarsBox: document.getElementById('tfvars-box'),
  tfvarsList: document.getElementById('tfvars-list'),
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
  resizerSidebar: document.getElementById('resizer-sidebar'),
  resizerLogs: document.getElementById('resizer-logs'),
  // Cytoscape graph container is #cy
  contextMenu: document.getElementById('context-menu'),
  // Rename modal
  renameModal: document.getElementById('rename-modal'),
  renameInput: document.getElementById('rename-input'),
  btnRenameOk: document.getElementById('btn-rename-ok'),
  btnRenameCancel: document.getElementById('btn-rename-cancel'),
  // Import modal
  importModal: document.getElementById('import-modal'),
  importAddress: document.getElementById('import-address'),
  importIdInput: document.getElementById('import-id'),
  btnImportOk: document.getElementById('btn-import-ok'),
  btnImportCancel: document.getElementById('btn-import-cancel'),
  // (state refactor/import controls removed from Inspect tab)
  mvSrc: document.getElementById('mv-src'),
  mvDst: document.getElementById('mv-dst'),
  btnStateMv: document.getElementById('btn-state-mv'),
  rmAddr: document.getElementById('rm-addr'),
  btnStateRm: document.getElementById('btn-state-rm'),
  importAddr: document.getElementById('import-addr'),
  importId: document.getElementById('import-id'),
  btnImport: document.getElementById('btn-import'),
  btnToggleLogs: document.getElementById('btn-toggle-logs'),
};

let state = {
  cwd: '',
  resources: [],
  selectedAddress: '',
  graph: { nodes: [], edges: [] },
  graphPositions: new Map(), // address -> {x,y}
  snapshotAt: null, // ISO string when terraform state was last pulled
  terraformWorkspaces: { list: [], current: '' },
  selectedVarFiles: new Set(),
  sidebarWidthPx: 320,
  logsHeightPct: 40,
  // Track expanded/collapsed modules in Resources sidebar
  expandedModules: new Set(),
  knownModules: new Set(),
};

let cy = null;
let cyEventsBound = false;
let inflightCount = 0;

function setSpinnerVisible(visible) {
  if (!ui.spinner) return;
  if (visible) ui.spinner.classList.remove('hidden');
  else ui.spinner.classList.add('hidden');
}

function beginBusy() {
  inflightCount = Math.max(0, inflightCount) + 1;
  setSpinnerVisible(true);
}

function endBusy() {
  inflightCount = Math.max(0, inflightCount - 1);
  if (inflightCount === 0) setSpinnerVisible(false);
}

async function callWithSpinner(fn) {
  beginBusy();
  try { return await fn(); }
  finally { endBusy(); }
}

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

function updateLayoutSizes() {
  const root = document.querySelector('.layout');
  if (root) {
    const w = Math.max(220, Math.min(state.sidebarWidthPx, Math.floor(window.innerWidth * 0.6)));
    root.style.setProperty('--sidebar-width', w + 'px');
    const pct = Math.max(15, Math.min(state.logsHeightPct, 80));
    root.style.setProperty('--logs-height', pct + '%');
  }
  if (cy) {
    setTimeout(() => {
      cy.resize();
      applyBestLayout();
    }, 0);
  }
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
  // Reset selections on workspace change
  state.selectedVarFiles = new Set();
  state.terraformWorkspaces = { list: [], current: '' };
  renderTfvarsList();
  renderWorkspaceDropdown();
}

function formatRelativeTime(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - then) / 1000));
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function renderSnapshotIndicator() {
  if (!ui.snapshotIndicator) return;
  const rel = formatRelativeTime(state.snapshotAt);
  ui.snapshotIndicator.textContent = `Snapshot: ${rel}`;
  if (state.snapshotAt) {
    try {
      const d = new Date(state.snapshotAt);
      ui.snapshotIndicator.title = `Last state pull: ${d.toLocaleString()}`;
    } catch (_) {
      ui.snapshotIndicator.title = 'Last state pull time unavailable';
    }
  } else {
    ui.snapshotIndicator.title = 'Last state pull time unavailable';
  }
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
    await afterWorkspaceChanged();
  }
}

function appendLog({ stream, message }) {
  const prefix = stream === 'stderr' ? '[err] ' : '';
  const html = ansiToHtml(prefix + String(message || ''));
  ui.logsPre.insertAdjacentHTML('beforeend', html);
  // Trim logs to prevent unbounded DOM growth
  try {
    const MAX_CHARS = 2_000_000; // ~2MB of text
    if (ui.logsPre.textContent.length > MAX_CHARS) {
      const excess = ui.logsPre.textContent.length - MAX_CHARS;
      // Remove oldest nodes until below threshold
      let removed = 0;
      while (removed < excess && ui.logsPre.firstChild) {
        removed += (ui.logsPre.firstChild.textContent || '').length;
        ui.logsPre.removeChild(ui.logsPre.firstChild);
      }
    }
  } catch (_) {}
  ui.logsPre.scrollTop = ui.logsPre.scrollHeight;
}
function renderWorkspaceDropdown() {
  const sel = ui.tfWorkspaceSelect;
  if (!sel) return;
  sel.innerHTML = '';
  if (!state.cwd) {
    const opt = document.createElement('option');
    opt.textContent = '—';
    opt.value = '';
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  const { list, current } = state.terraformWorkspaces;
  if (!list || list.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = '(default)';
    opt.value = 'default';
    sel.appendChild(opt);
    sel.value = 'default';
    return;
  }
  for (const name of list) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  sel.value = current || 'default';
}

function renderTfvarsList() {
  const container = ui.tfvarsList;
  if (!container) return;
  container.innerHTML = '';
  if (!state.cwd) {
    container.textContent = 'No workspace selected';
    return;
  }
  const items = state.availableTfvars || [];
  if (!items.length) {
    container.textContent = 'No *.tfvars found';
    return;
  }
  items.forEach((filePath) => {
    const row = document.createElement('label');
    row.className = 'tfvar-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.selectedVarFiles.has(filePath);
    cb.addEventListener('change', () => {
      if (cb.checked) state.selectedVarFiles.add(filePath);
      else state.selectedVarFiles.delete(filePath);
    });
    const span = document.createElement('span');
    span.className = 'tfvar-path';
    span.title = filePath;
    // Show path relative to cwd for readability
    let rel = filePath;
    try {
      if (state.cwd && filePath.startsWith(state.cwd)) rel = filePath.slice(state.cwd.length + 1);
    } catch (_) {}
    span.textContent = rel;
    row.appendChild(cb);
    row.appendChild(span);
    container.appendChild(row);
  });
}

function getSelectedVarFilesArray() {
  return Array.from(state.selectedVarFiles);
}

async function refreshWorkspaceMeta() {
  if (!state.cwd) return;
  // Workspaces
  try {
    const res = await window.api.listWorkspaces(state.cwd);
    state.terraformWorkspaces = { list: res.workspaces || [], current: res.current || '' };
  } catch (_) {
    state.terraformWorkspaces = { list: [], current: '' };
  }
  renderWorkspaceDropdown();
  // Tfvars
  try {
    const res = await window.api.listTfvars(state.cwd);
    state.availableTfvars = (res && res.files) || [];
  } catch (_) {
    state.availableTfvars = [];
  }
  renderTfvarsList();
}

async function afterWorkspaceChanged() {
  await refreshWorkspaceMeta();
  await refreshResources();
}


function clearLogs() {
  ui.logsPre.textContent = '';
}

// Basic ANSI SGR to HTML converter for logs
function ansiToHtml(text) {
  if (!text) return '';
  const escape = (s) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const classesForCode = (code) => {
    const n = Number(code);
    switch (n) {
      case 0: return ['reset'];
      case 1: return ['ansi-bold'];
      case 2: return ['ansi-dim'];
      case 4: return ['ansi-underline'];
      case 30: return ['ansi-fg-black'];
      case 31: return ['ansi-fg-red'];
      case 32: return ['ansi-fg-green'];
      case 33: return ['ansi-fg-yellow'];
      case 34: return ['ansi-fg-blue'];
      case 35: return ['ansi-fg-magenta'];
      case 36: return ['ansi-fg-cyan'];
      case 37: return ['ansi-fg-white'];
      case 90: return ['ansi-fg-bright-black'];
      case 91: return ['ansi-fg-bright-red'];
      case 92: return ['ansi-fg-bright-green'];
      case 93: return ['ansi-fg-bright-yellow'];
      case 94: return ['ansi-fg-bright-blue'];
      case 95: return ['ansi-fg-bright-magenta'];
      case 96: return ['ansi-fg-bright-cyan'];
      case 97: return ['ansi-fg-bright-white'];
      default: return [];
    }
  };

  const segments = [];
  const closeStack = [];
  let i = 0;
  while (i < text.length) {
    const escIdx = text.indexOf('\u001b[', i);
    if (escIdx === -1) {
      segments.push(escape(text.slice(i)));
      break;
    }
    if (escIdx > i) segments.push(escape(text.slice(i, escIdx)));
    const mIdx = text.indexOf('m', escIdx + 2);
    if (mIdx === -1) {
      segments.push(escape(text.slice(escIdx)));
      break;
    }
    const seq = text.slice(escIdx + 2, mIdx);
    const codes = seq.split(';').filter((s) => s.length > 0);
    if (codes.includes('0')) {
      while (closeStack.length) segments.push(closeStack.pop());
    }
    for (const c of codes) {
      if (c === '0') continue;
      const cls = classesForCode(c);
      if (cls.length) {
        segments.push(`<span class="${cls.join(' ')}">`);
        closeStack.push('</span>');
      }
    }
    i = mIdx + 1;
  }
  while (closeStack.length) segments.push(closeStack.pop());
  return segments.join('');
}

async function withLogs(task) {
  clearLogs();
  const unsubscribe = window.api.onLog(appendLog);
  beginBusy();
  try {
    const result = await task();
    if (result && typeof result.code !== 'undefined') {
      const html = ansiToHtml(`\n[exit code ${result.code}]\n`);
      ui.logsPre.insertAdjacentHTML('beforeend', html);
    }
    return result;
  } finally {
    if (typeof unsubscribe === 'function') unsubscribe();
    endBusy();
  }
}

function renderResources() {
  ui.resourcesList.innerHTML = '';

  // Helper: derive type/name for display after stripping module prefixes
  const getTypeAndName = (addr) => {
    let s = String(addr);
    if (s.startsWith('module.')) {
      const parts = s.split('.');
      let i = 0;
      while (i < parts.length && parts[i] === 'module' && i + 1 < parts.length) i += 2;
      s = parts.slice(i).join('.');
    }
    const p = s.split('.');
    if (p[0] === 'data') {
      return { type: `${p[0]}.${p[1]}`, name: p.slice(2).join('.') };
    }
    return { type: p[0], name: p.slice(1).join('.') };
  };

  // Build resource entries: union of existing and planned-only (with change info)
  const existingBases = new Set(state.resources.map(baseAddress));
  const changeBy = new Map(state.graph.nodes
    .filter((n) => (n.type || 'resource') === 'resource' && n.change)
    .map((n) => [n.id, n.change]));

  const collectResourceEntry = (addr) => {
    const base = baseAddress(addr);
    const node = state.graph.nodes.find((n) => (n.type || 'resource') === 'resource' && n.id === base);
    const change = (node && node.change) || '';
    return { addr, base, change };
  };

  const resourceMap = new Map(); // base -> entry with possibly representative addr
  // Existing state resources (include instances as-is)
  state.resources.forEach((addr) => {
    const base = baseAddress(addr);
    if (!resourceMap.has(base)) resourceMap.set(base, collectResourceEntry(addr));
  });
  // Planned-only resources (that are not present in state)
  state.graph.nodes
    .filter((n) => (n.type || 'resource') === 'resource' && !existingBases.has(n.id))
    .forEach((n) => {
      if (!resourceMap.has(n.id)) resourceMap.set(n.id, { addr: n.id, base: n.id, change: n.change || (n.planned ? 'create' : '') });
    });

  // Build module tree structure
  const modules = new Set(state.graph.nodes.filter((n) => (n.type || 'resource') === 'module' || n.type === 'module').map((n) => n.id));
  // Ensure parent module nodes exist for any deeper module ids
  Array.from(modules).forEach((mid) => {
    const parts = mid.split('.');
    for (let i = 2; i < parts.length; i += 2) {
      const parent = parts.slice(0, i).join('.');
      if (parent.startsWith('module.') && !modules.has(parent)) modules.add(parent);
    }
  });

  const tree = new Map(); // id -> { id, childrenModules:Set, resources:[] }
  const ensureModuleNode = (id) => {
    const key = id || '';
    if (!tree.has(key)) tree.set(key, { id: key, childrenModules: new Set(), resources: [] });
    return tree.get(key);
  };
  // Root container
  ensureModuleNode('');

  // Create module nodes and parent-child relations
  modules.forEach((mid) => {
    ensureModuleNode(mid);
    const parts = mid.split('.');
    let parent = '';
    if (parts.length > 2) {
      parent = parts.slice(0, parts.length - 2).join('.');
    }
    ensureModuleNode(parent).childrenModules.add(mid);
  });

  // Assign resources to their module container
  for (const entry of resourceMap.values()) {
    const mod = getModulePrefixFromAddress(entry.base);
    ensureModuleNode(mod).resources.push(entry);
  }

  // Initialize expansion defaults for modules never seen before
  tree.forEach((node, id) => {
    if (!id) return; // skip root
    if (!state.knownModules.has(id)) {
      state.knownModules.add(id);
      state.expandedModules.add(id); // default expanded on first discovery
    }
  });

  // Render recursively
  const renderModule = (id, container) => {
    const node = tree.get(id);
    if (!node) return;

    // Sort children modules by id for stability
    const childrenMods = Array.from(node.childrenModules).sort((a, b) => a.localeCompare(b));
    const resources = node.resources.slice().sort((a, b) => a.base.localeCompare(b.base));

    // If this is not root, render a module header item
    let moduleChildrenContainer = container;
    if (id) {
      // Aggregate change markers from descendant resources
      const aggregate = { create: 0, delete: 0, modify: 0, replace: 0 };
      const collectAgg = (mid) => {
        const mnode = tree.get(mid);
        if (mnode) {
          mnode.resources.forEach((r) => {
            if (r.change && aggregate.hasOwnProperty(r.change)) aggregate[r.change] += 1;
          });
          mnode.childrenModules.forEach(collectAgg);
        }
      };
      collectAgg(id);

      const li = document.createElement('li');
      li.className = 'module-item';
      li.dataset.address = id;
      const expanded = state.expandedModules.has(id);
      const counts = Object.entries(aggregate).filter(([_, v]) => v > 0).map(([k, v]) => `${k[0]}${v}`).join(' ');
      li.innerHTML = `
        <span class="chevron">${expanded ? '▾' : '▸'}</span>
        <div class="module-header">
          <span class="module-id">${id}</span>
          ${counts ? `<span class="module-badges">${counts}</span>` : ''}
        </div>
      `;
      li.addEventListener('mousedown', (e) => {
        // Left-click toggles; prevent text selection quirks
        if (e.button !== 0) return;
        e.preventDefault();
        if (state.expandedModules.has(id)) state.expandedModules.delete(id);
        else state.expandedModules.add(id);
        renderResources();
      });
      li.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const x = e.pageX || (e.clientX + window.scrollX);
        const y = e.pageY || (e.clientY + window.scrollY);
        showContextMenu(x, y, id);
      });
      container.appendChild(li);

      // Children container
      const ul = document.createElement('ul');
      ul.className = 'resources-sublist';
      ul.style.display = expanded ? '' : 'none';
      container.appendChild(ul);
      moduleChildrenContainer = ul;
    }

    // Render child modules
    childrenMods.forEach((mid) => renderModule(mid, moduleChildrenContainer));

    // Render resources in this module
    resources.forEach((entry) => {
      const li = document.createElement('li');
      li.dataset.address = entry.addr;
      const { type, name } = getTypeAndName(entry.base);
      const change = entry.change || '';
      let marker = '';
      if (change === 'create') marker = '+';
      else if (change === 'delete') marker = '-';
      else if (change === 'modify') marker = '~';
      else if (change === 'replace') marker = '-/+';
      let changeLabel = '';
      if (change === 'create') changeLabel = 'will be created';
      else if (change === 'delete') changeLabel = 'will be deleted';
      else if (change === 'modify') changeLabel = 'will be modified';
      else if (change === 'replace') changeLabel = 'will be recreated';
      li.classList.add(`change-${change || 'none'}`);
      li.innerHTML = `
        <span class="marker">${marker || ''}</span>
        <div>
          <span class="resource-id"><span class="resource-type">${type}</span>.<span class="resource-name">${name}</span></span>
          ${changeLabel ? `<div class="resource-change">${changeLabel}</div>` : ''}
        </div>
      `;
      li.addEventListener('click', async () => {
        document.querySelectorAll('.resources-list li').forEach((el) => el.classList.remove('active'));
        li.classList.add('active');
        state.selectedAddress = entry.addr;
        await loadResourceDetails(entry.addr);
      });
      li.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const x = e.pageX || (e.clientX + window.scrollX);
        const y = e.pageY || (e.clientY + window.scrollY);
        showContextMenu(x, y, entry.addr);
      });
      moduleChildrenContainer.appendChild(li);
    });
  };

  renderModule('', ui.resourcesList);
}

async function refreshResources() {
  if (!state.cwd) return;
  const res = await callWithSpinner(() => window.api.stateList(state.cwd));
  state.resources = res.resources || [];
  if (res && res.snapshotAt) state.snapshotAt = res.snapshotAt;
  renderSnapshotIndicator();
  await buildGraph();
  renderResources();
}

async function loadResourceDetails(address) {
  if (!state.cwd) return;
  ui.resourceDetails.textContent = 'Loading...';
  const detail = await callWithSpinner(() => window.api.stateShow(state.cwd, address));
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
  const varFiles = getSelectedVarFilesArray();
  await withLogs(() => window.api.plan(state.cwd, { varFiles }));
  // Rebuild from plan-json to immediately reflect planned graph
  await buildGraph();
  // Update the resources panel to reflect planned changes/markers and planned-only resources
  renderResources();
  if (isGraphActive()) renderGraph();
}

async function doApply() {
  if (!(await ensureWorkspaceSelected())) return;
  const varFiles = getSelectedVarFilesArray();
  await withLogs(() => window.api.apply(state.cwd, { varFiles }));
  await refreshResources();
  if (isGraphActive()) renderGraph();
}

async function doRefresh() {
  if (!(await ensureWorkspaceSelected())) return;
  const varFiles = getSelectedVarFilesArray();
  await withLogs(() => window.api.refresh(state.cwd, { varFiles }));
  await refreshResources();
  if (isGraphActive()) renderGraph();
}

async function doDestroy() {
  if (!(await ensureWorkspaceSelected())) return;
  const ok = confirm('Are you sure you want to destroy all managed infrastructure?');
  if (!ok) return;
  const varFiles = getSelectedVarFilesArray();
  await withLogs(() => window.api.destroy(state.cwd, { varFiles }));
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
  const varFiles = getSelectedVarFilesArray();
  const [sj, pj] = await callWithSpinner(() => Promise.all([
    window.api.showJson(state.cwd),
    window.api.planJson(state.cwd, { varFiles }),
  ]));
  if (sj && sj.snapshotAt) {
    // Prefer the most recent snapshot timestamp we see
    if (!state.snapshotAt || new Date(sj.snapshotAt).getTime() > new Date(state.snapshotAt).getTime()) {
      state.snapshotAt = sj.snapshotAt;
      renderSnapshotIndicator();
    }
  }
  const showJson = sj.json || null;
  const planJson = pj.json || null;
  const planDot = '';

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

  // Derive change types from plan
  const changeBy = new Map();
  if (planJson && Array.isArray(planJson.resource_changes)) {
    for (const rc of planJson.resource_changes) {
      const addr = baseAddress(rc.address || (rc.type && rc.name ? `${rc.type}.${rc.name}` : ''));
      if (!addr) continue;
      const actions = (rc.change && rc.change.actions) || [];
      let change = '';
      const hasCreate = actions.includes('create');
      const hasDelete = actions.includes('delete');
      const hasUpdate = actions.includes('update');
      if (hasCreate && hasDelete) change = 'replace';
      else if (hasUpdate) change = 'modify';
      else if (hasCreate) change = 'create';
      else if (hasDelete) change = 'delete';
      if (change) changeBy.set(addr, change);
    }
  }

  // Build nodes: union of existing and planned creates
  const nodeIds = new Set([...existing, ...plannedCreates]);
  const nodeMap = new Map(Array.from(nodeIds).map((addr) => [addr, { id: addr, type: 'resource', planned: plannedCreates.has(addr) && !existing.has(addr), change: changeBy.get(addr) || '', inputs: new Set(), outputs: new Set() }]));
  const ensureNodeLocal = (addr) => {
    const key = baseAddress(addr);
    let n = nodeMap.get(key);
    if (!n) {
      n = { id: key, type: 'resource', planned: plannedCreates.has(key) && !existing.has(key), change: changeBy.get(key) || '', inputs: new Set(), outputs: new Set() };
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
            const resModulePrefix = getModulePrefixFromAddress(addr);
            refs.forEach((ref) => {
              const a = normalizeRefToAddress(ref);
              if (!a) return;
              if (a.startsWith('var.')) {
                // Scope variable refs to the module of the resource being evaluated
                const scopedVar = makeScopedVarId(a, resModulePrefix);
                if (scopedVar) deps.add(baseAddress(scopedVar));
              } else {
                deps.add(baseAddress(a));
              }
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
  } catch (_) {}

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

  // (DOT graph fallback disabled; plan/state JSON provide sufficient data for edges)

  // Collapse variable nodes by rewiring edges across them, removing var.* nodes entirely
  try {
    const isVarId = (id) => typeof id === 'string' && (id.startsWith('var.') || id.includes('.var.'));
    const incomingBy = new Map(); // varId -> [sourceId]
    const outgoingBy = new Map(); // varId -> [targetId]
    for (const e of edges) {
      if (isVarId(e.to)) {
        const arr = incomingBy.get(e.to) || [];
        arr.push(e.from);
        incomingBy.set(e.to, arr);
      }
      if (isVarId(e.from)) {
        const arr = outgoingBy.get(e.from) || [];
        arr.push(e.to);
        outgoingBy.set(e.from, arr);
      }
    }
    const varIds = new Set([...incomingBy.keys(), ...outgoingBy.keys()]);
    const spliced = [];
    varIds.forEach((v) => {
      const sources = incomingBy.get(v) || [];
      const targets = outgoingBy.get(v) || [];
      for (const s of sources) {
        for (const t of targets) {
          if (!isVarId(s) && !isVarId(t)) spliced.push({ from: s, to: t });
        }
      }
    });
    // Keep only non-variable edges, then add spliced ones (dedup happens later)
    const kept = edges.filter((e) => !isVarId(e.from) && !isVarId(e.to));
    edges.splice(0, edges.length, ...kept, ...spliced);
  } catch (_) {}

  // Ensure we have nodes for all module/variable endpoints referenced by edges (including module.<path>.var.<name>)
  for (const { from, to } of edges) {
    if (from.startsWith('module.') && !nodeMap.has(from.split('.', 2).slice(0, 2).join('.'))) {
      nodeMap.set(from.split('.', 2).slice(0, 2).join('.'), { id: from.split('.', 2).slice(0, 2).join('.'), type: 'module', planned: false, inputs: new Set() });
    }
    if (to.startsWith('module.') && !nodeMap.has(to.split('.', 2).slice(0, 2).join('.'))) {
      nodeMap.set(to.split('.', 2).slice(0, 2).join('.'), { id: to.split('.', 2).slice(0, 2).join('.'), type: 'module', planned: false, inputs: new Set() });
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

// (DOT parse helper removed)

function renderGraph() {
  const container = document.getElementById('cy');
  if (!cy) {
    cy = cytoscape({
      container,
      style: [
        { selector: 'node', style: { 'background-color': '#111827', 'label': 'data(label)', 'font-family': 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace', 'font-size': 11, 'text-wrap': 'wrap', 'text-max-width': 240, 'color': '#d1d5db', 'border-width': 1, 'border-color': '#374151', 'shape': 'rectangle', 'text-valign': 'center', 'text-halign': 'center', 'width': 'label', 'height': 'label', 'padding': 8 } },
        { selector: 'node[type = "module"]', style: { 'background-color': '#1f2937', 'border-color': '#374151', 'label': 'data(label)', 'text-valign': 'center', 'text-halign': 'center', 'padding': 12 } },
        // variable nodes no longer rendered
        { selector: 'node[planned = "true"]', style: { 'border-style': 'dashed' } },
        { selector: 'edge', style: { 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'line-color': '#6b7280', 'target-arrow-color': '#6b7280', 'width': 1 } },
        { selector: 'node[change = "create"]', style: { 'color': '#10b981', 'border-color': '#10b981' } },
        { selector: 'node[change = "delete"]', style: { 'color': '#ef4444', 'border-color': '#ef4444' } },
        { selector: 'node[change = "modify"]', style: { 'color': '#f59e0b', 'border-color': '#f59e0b' } },
        { selector: 'node[change = "replace"]', style: { 'color': '#f59e0b', 'border-color': '#ef4444' } }
      ]
    });
  }

  const elements = [];
  const parentSet = new Set();
  for (const n of state.graph.nodes) {
    const change = n.change || '';
    let prefix = '';
    if (change === 'create') prefix = '+ ';
    else if (change === 'delete') prefix = '- ';
    else if (change === 'modify') prefix = '~ ';
    else if (change === 'replace') prefix = '-/+ ';
    const ele = { data: { id: n.id, label: prefix + n.id, type: n.type || 'resource', planned: String(Boolean(n.planned)), change } };
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
      const pos = evt.renderedPosition || evt.position || evt.target.renderedPosition();
      const rect = cy.container().getBoundingClientRect();
      const pageX = rect.left + (pos.x || 0);
      const pageY = rect.top + (pos.y || 0);
      showContextMenu(pageX, pageY, evt.target.id());
    });
    cyEventsBound = true;
  }

  // no overlay buttons; use right-click menu options
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

function toggleModuleCollapse(node) {
  if (!cy || !cy.expandCollapse) return;
  const api = cy.expandCollapse('get') || cy.expandCollapse({ layoutBy: { name: 'cose', animate: false } });
  let pending = 0;
  const done = () => {
    pending--;
    if (pending <= 0) {
      cy.off('expandcollapse.collapsedone', done);
      cy.off('expandcollapse.expanddone', done);
      applyBestLayout();
    }
  };
  cy.on('expandcollapse.collapsedone', done);
  cy.on('expandcollapse.expanddone', done);
  pending = 1;
  if (node.isExpandable && node.isExpandable()) api.expand(node);
  else if (node.isCollapsible && node.isCollapsible()) api.collapse(node);
  else {
    // try toggle
    if (node.data('expanded') === false) api.expand(node);
    else api.collapse(node);
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
  const modules = cy.nodes('[type = "module"]');
  let pending = 0;
  const done = () => {
    pending--;
    if (pending <= 0) {
      cy.off('expandcollapse.collapsedone', done);
      cy.off('expandcollapse.expanddone', done);
      applyBestLayout();
    }
  };
  cy.on('expandcollapse.collapsedone', done);
  cy.on('expandcollapse.expanddone', done);
  modules.forEach((n) => {
    pending++;
    if (collapse) api.collapse(n); else api.expand(n);
  });
  if (pending === 0) applyBestLayout();
}

// (legacy drag helper removed)

function showContextMenu(x, y, address) {
  ui.contextMenu.style.left = x + 'px';
  ui.contextMenu.style.top = y + 'px';
  ui.contextMenu.classList.remove('hidden');
  ui.contextMenu.dataset.address = address;
  // Enable/disable items contextually
  const isModule = String(address).startsWith('module.');
  const base = baseAddress(address);
  const inState = (state.resources || []).some((r) => baseAddress(r) === base);
  const node = state.graph.nodes.find((n) => n.id === base && (n.type || 'resource') === 'resource');
  const change = (node && node.change) || '';
  // Import should be enabled only when this is a planned create and not present in state
  const importItem = ui.contextMenu.querySelector('.menu-item[data-action="import"]');
  if (importItem) {
    // Allow import whenever there is a planned create for this address (base),
    // even if some instances already exist in state.
    const canImport = !isModule && change === 'create';
    importItem.classList.toggle('disabled', !canImport);
    importItem.title = canImport ? '' : 'Available only for planned create resources not yet in state';
  }
  // Collapse/Expand items enabled only for modules
  const collapseItem = ui.contextMenu.querySelector('.menu-item[data-action="collapse-module"]');
  const expandItem = ui.contextMenu.querySelector('.menu-item[data-action="expand-module"]');
  if (collapseItem) {
    collapseItem.classList.toggle('disabled', !isModule);
    collapseItem.title = isModule ? '' : 'Only applicable to modules';
  }
  if (expandItem) {
    expandItem.classList.toggle('disabled', !isModule);
    expandItem.title = isModule ? '' : 'Only applicable to modules';
  }
}

function hideContextMenu() {
  ui.contextMenu.classList.add('hidden');
  ui.contextMenu.dataset.address = '';
}

function showRenameModal(defaultAddress) {
  ui.renameModal.dataset.source = defaultAddress || '';
  ui.renameInput.value = defaultAddress || '';
  ui.renameModal.classList.remove('hidden');
  setTimeout(() => ui.renameInput.focus(), 0);
}

function hideRenameModal() {
  ui.renameModal.classList.add('hidden');
  ui.renameModal.dataset.source = '';
}

function showImportModal(defaultAddress) {
  if (!ui.importModal) return;
  ui.importModal.dataset.address = defaultAddress || '';
  if (ui.importAddress) ui.importAddress.value = defaultAddress || '';
  if (ui.importIdInput) ui.importIdInput.value = '';
  ui.importModal.classList.remove('hidden');
  setTimeout(() => ui.importAddress && ui.importAddress.focus(), 0);
}

function hideImportModal() {
  if (!ui.importModal) return;
  ui.importModal.classList.add('hidden');
  ui.importModal.dataset.address = '';
}

function wireContextMenu() {
  window.addEventListener('click', hideContextMenu);
  const cyContainer = document.getElementById('cy');
  if (cyContainer) {
    cyContainer.addEventListener('contextmenu', (e) => {
      // prevent the browser menu on the graph canvas so our custom menu can show
      e.preventDefault();
    });
  }
  ui.contextMenu.addEventListener('click', async (e) => {
    const item = e.target.closest('.menu-item');
    if (!item) return;
    const action = item.dataset.action;
    const address = ui.contextMenu.dataset.address;
    hideContextMenu();
    if (!address) return;
    if (action === 'rename') {
      showRenameModal(address);
    } else if (action === 'remove') {
      const ok = confirm(`Remove ${address} from state?`);
      if (!ok) return;
      await withLogs(() => window.api.stateRemove(state.cwd, address));
      await refreshResources();
    } else if (action === 'show') {
      const res = await callWithSpinner(() => window.api.stateShow(state.cwd, address));
      const text = (res.stdout || res.stderr || '').trim();
      if (text) {
        ui.resourceDetails.textContent = text;
      }
    } else if (action === 'import') {
      showImportModal(address);
    } else if (action === 'collapse-module') {
      // Resources sidebar collapse
      if (String(address).startsWith('module.')) {
        state.expandedModules.delete(address);
        renderResources();
      }
      // Graph collapse (if present)
      if (cy) {
        const n = cy.getElementById(address);
        if (n && n.data('type') === 'module') toggleModuleCollapse(n);
      }
    } else if (action === 'expand-module') {
      // Resources sidebar expand
      if (String(address).startsWith('module.')) {
        state.expandedModules.add(address);
        renderResources();
      }
      // Graph expand (if present)
      if (cy) {
        const n = cy.getElementById(address);
        if (n && n.data('type') === 'module') toggleModuleCollapse(n);
      }
    }
  });
}

function wireEvents() {
  ui.btnOpenWorkspace.addEventListener('click', pickWorkspace);
  if (ui.tfWorkspaceSelect) {
    ui.tfWorkspaceSelect.addEventListener('change', async () => {
      const name = ui.tfWorkspaceSelect.value;
      if (!state.cwd || !name) return;
      await withLogs(() => window.api.selectWorkspaceName(state.cwd, name));
      await refreshWorkspaceMeta();
      await refreshResources();
    });
  }
  ui.btnInit.addEventListener('click', doInit);
  ui.btnPlan.addEventListener('click', doPlan);
  ui.btnApply.addEventListener('click', doApply);
  ui.btnRefresh.addEventListener('click', doRefresh);
  ui.btnDestroy.addEventListener('click', doDestroy);
  if (ui.btnStateMv) ui.btnStateMv.addEventListener('click', doStateMove);
  if (ui.btnStateRm) ui.btnStateRm.addEventListener('click', doStateRemove);
  if (ui.btnImport) ui.btnImport.addEventListener('click', doImport);
  ui.tabInspect.addEventListener('click', () => activateTab('inspect'));
  ui.tabGraph.addEventListener('click', () => activateTab('graph'));
  const collapseBtn = document.getElementById('btn-collapse-modules');
  const expandBtn = document.getElementById('btn-expand-modules');
  const relayoutBtn = document.getElementById('btn-relayout');
  if (collapseBtn) collapseBtn.addEventListener('click', () => { collapseExpandModules(true); applyBestLayout(); });
  if (expandBtn) expandBtn.addEventListener('click', () => { collapseExpandModules(false); applyBestLayout(); });
  if (relayoutBtn) relayoutBtn.addEventListener('click', () => applyBestLayout());
  // Resources sidebar controls
  const resCollapseAll = document.getElementById('btn-res-collapse-all');
  const resExpandAll = document.getElementById('btn-res-expand-all');
  if (resCollapseAll) resCollapseAll.addEventListener('click', () => {
    // Collapse all known modules
    state.knownModules.forEach((m) => state.expandedModules.delete(m));
    renderResources();
  });
  if (resExpandAll) resExpandAll.addEventListener('click', () => {
    // Expand all known modules
    state.knownModules.forEach((m) => state.expandedModules.add(m));
    renderResources();
  });
  wireContextMenu();

  // Logs collapse
  if (ui.btnToggleLogs) {
    ui.btnToggleLogs.addEventListener('click', () => {
      const logs = document.querySelector('.logs');
      const expanded = ui.btnToggleLogs.getAttribute('aria-expanded') !== 'false';
      if (expanded) {
        ui.btnToggleLogs.textContent = '▸';
        ui.btnToggleLogs.setAttribute('aria-expanded', 'false');
        logs.classList.add('collapsed');
        state.logsHeightPct = 0; // visually collapsed
      } else {
        ui.btnToggleLogs.textContent = '▾';
        ui.btnToggleLogs.setAttribute('aria-expanded', 'true');
        logs.classList.remove('collapsed');
        if (state.logsHeightPct < 15) state.logsHeightPct = 30;
      }
      updateLayoutSizes();
    });
  }

  // Sidebar resizer drag
  if (ui.resizerSidebar) {
    let dragging = false;
    const onMove = (ev) => {
      if (!dragging) return;
      const x = ev.touches ? ev.touches[0].clientX : ev.clientX;
      state.sidebarWidthPx = Math.max(220, Math.min(x, window.innerWidth - 300));
      updateLayoutSizes();
      ev.preventDefault();
    };
    const onUp = () => { dragging = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); window.removeEventListener('touchmove', onMove); window.removeEventListener('touchend', onUp); };
    ui.resizerSidebar.addEventListener('mousedown', () => { dragging = true; window.addEventListener('mousemove', onMove, { passive: false }); window.addEventListener('mouseup', onUp); });
    ui.resizerSidebar.addEventListener('touchstart', () => { dragging = true; window.addEventListener('touchmove', onMove, { passive: false }); window.addEventListener('touchend', onUp); });
  }

  // Logs resizer drag (vertical)
  if (ui.resizerLogs) {
    let draggingV = false;
    const onMoveV = (ev) => {
      if (!draggingV) return;
      const y = ev.touches ? ev.touches[0].clientY : ev.clientY;
      const content = document.querySelector('.content');
      const rect = content.getBoundingClientRect();
      const fromTop = y - rect.top;
      const pct = Math.round(((rect.height - fromTop) / rect.height) * 100);
      state.logsHeightPct = Math.max(15, Math.min(pct, 80));
      const logs = document.querySelector('.logs');
      logs.classList.remove('collapsed');
      if (ui.btnToggleLogs) { ui.btnToggleLogs.textContent = '▾'; ui.btnToggleLogs.setAttribute('aria-expanded', 'true'); }
      updateLayoutSizes();
      ev.preventDefault();
    };
    const onUpV = () => { draggingV = false; window.removeEventListener('mousemove', onMoveV); window.removeEventListener('mouseup', onUpV); window.removeEventListener('touchmove', onMoveV); window.removeEventListener('touchend', onUpV); };
    ui.resizerLogs.addEventListener('mousedown', () => { draggingV = true; window.addEventListener('mousemove', onMoveV, { passive: false }); window.addEventListener('mouseup', onUpV); });
    ui.resizerLogs.addEventListener('touchstart', () => { draggingV = true; window.addEventListener('touchmove', onMoveV, { passive: false }); window.addEventListener('touchend', onUpV); });
  }

  window.addEventListener('resize', updateLayoutSizes);

  // Toast: show friendly label (not the full command) from main process queue events
  if (window.api && typeof window.api.onCommand === 'function') {
    window.api.onCommand((payload) => {
      const toast = document.getElementById('toast');
      if (!toast || !payload || !payload.event) return;
      if (payload.event === 'start') {
        const label = String(payload.label || 'terraform');
        toast.textContent = `Running: ${label}`;
        toast.classList.remove('hidden');
      } else if (payload.event === 'end') {
        toast.classList.add('hidden');
        toast.textContent = '';
      }
    });
  }

  // Rename modal actions
  ui.btnRenameCancel.addEventListener('click', hideRenameModal);
  ui.btnRenameOk.addEventListener('click', async () => {
    const address = ui.renameModal.dataset.source || ui.contextMenu.dataset.address || state.selectedAddress || '';
    const dest = (ui.renameInput.value || '').trim();
    hideRenameModal();
    if (!address || !dest || dest === address) return;
    const base = baseAddress(address);
    const isModule = String(address).startsWith('module.');
    const hasIndex = String(address).includes('[');
    const matchingInstances = (state.resources || []).filter((r) => baseAddress(r) === base);

    let movePairs = [];
    if (isModule) {
      // Rename a module call by moving every state object whose address starts with this module path
      const escapeReg = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const modPrefix = address; // e.g., module.a or module.a.module.b
      const re = new RegExp(`^${escapeReg(modPrefix)}(\\[[^\\]]+\\])?\\\.`);
      const affected = (state.resources || []).filter((r) => re.test(r));
      // If nothing directly matched, also consider baseAddress on state items (defensive)
      if (affected.length === 0) {
        const reBase = new RegExp(`^${escapeReg(base)}(\\[[^\\]]+\\])?\\\.`);
        affected.push(...(state.resources || []).filter((r) => reBase.test(baseAddress(r) + (r.endsWith(']') ? '' : ''))));
      }
      // Build pairs preserving instance key if present immediately after the module
      movePairs = affected.map((src) => {
        const m = src.match(re);
        const instancePart = m && m[1] ? m[1] : '';
        const remainder = src.slice((m ? m[0].length : (modPrefix + '.').length));
        const dst = `${dest}${instancePart}.${remainder}`;
        return [src, dst];
      });
      if (movePairs.length === 0) {
        alert('No state objects found under this module to move.');
        return;
      }
    } else if (!hasIndex && matchingInstances.length > 1) {
      movePairs = matchingInstances.map((src) => {
        const suffix = src.slice(base.length);
        return [src, dest + suffix];
      });
    } else if (!hasIndex && matchingInstances.length === 1) {
      const only = matchingInstances[0];
      const suffix = only.slice(base.length);
      movePairs = [[only, dest + suffix]];
    } else {
      movePairs = [[address, dest]];
    }

    await withLogs(async () => {
      let last = null;
      for (const [src, dst] of movePairs) {
        last = await window.api.stateMove(state.cwd, src, dst);
      }
      return last;
    });
    await refreshResources();
  });

  // Allow Enter/Escape in input
  ui.renameInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ui.btnRenameOk.click();
    } else if (ev.key === 'Escape') {
      hideRenameModal();
    }
  });

  // Import modal actions
  if (ui.btnImportCancel) ui.btnImportCancel.addEventListener('click', hideImportModal);
  if (ui.btnImportOk) ui.btnImportOk.addEventListener('click', async () => {
    const address = (ui.importAddress && ui.importAddress.value || ui.importModal.dataset.address || '').trim();
    const id = (ui.importIdInput && ui.importIdInput.value || '').trim();
    hideImportModal();
    if (!address || !id) return;
    const varFiles = getSelectedVarFilesArray();
    await withLogs(() => window.api.importResource(state.cwd, address, id, { varFiles }));
    await refreshResources();
  });
  if (ui.importAddress) ui.importAddress.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') ui.btnImportOk && ui.btnImportOk.click();
    else if (ev.key === 'Escape') hideImportModal();
  });
  if (ui.importIdInput) ui.importIdInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') ui.btnImportOk && ui.btnImportOk.click();
    else if (ev.key === 'Escape') hideImportModal();
  });
}

async function boot() {
  wireEvents();
  updateLayoutSizes();
  const saved = await window.api.getWorkspace();
  if (saved) {
    setWorkspace(saved);
    await afterWorkspaceChanged();
  }
}

boot();



