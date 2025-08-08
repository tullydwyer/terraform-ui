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



