const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

/**
 * Simple JSON config to persist last used workspace directory
 */
const userDataDir = app.getPath('userData');
const configFilePath = path.join(userDataDir, 'config.json');

// Persistent Terraform command history (metadata + log files)
const historyDir = path.join(userDataDir, 'history');
const historyLogsDir = path.join(historyDir, 'logs');
const historyIndexPath = path.join(historyDir, 'index.json');
const HISTORY_LIMIT = 200; // keep last N records
const appBuildInfo = createAppBuildInfo();

/**
 * In-memory index of history items
 * Each item: { id, label, cwd, args, startAt, endAt, exitCode }
 */
let historyIndex = [];
const stateSnapshotCache = new Map();

function collectBuildHashFiles(rootDir) {
  const files = [];
  const includeFile = (filePath) => {
    if (fs.existsSync(filePath)) {
      files.push(filePath);
    }
  };
  const walk = (dirPath) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  };

  includeFile(path.join(rootDir, 'package.json'));
  walk(path.join(rootDir, 'electron'));
  walk(path.join(rootDir, 'renderer'));

  return files.sort((a, b) => a.localeCompare(b));
}

function createAppBuildInfo() {
  const rootDir = path.join(__dirname, '..');
  const hasher = crypto.createHash('sha256');
  const files = collectBuildHashFiles(rootDir);
  for (const filePath of files) {
    try {
      const relativePath = path.relative(rootDir, filePath).replace(/\\/g, '/');
      hasher.update(relativePath);
      hasher.update('\0');
      hasher.update(fs.readFileSync(filePath));
      hasher.update('\0');
    } catch (_) {}
  }
  const hash = hasher.digest('hex').slice(0, 8);
  const version = app.getVersion();
  const mode = app.isPackaged ? 'prod' : 'dev';
  return {
    hash,
    mode,
    version,
    startedAt: new Date().toISOString(),
    title: `Terraform UI - build ${hash}`,
  };
}

function ensureHistoryStorage() {
  try {
    fs.mkdirSync(historyLogsDir, { recursive: true });
    if (!fs.existsSync(historyIndexPath)) {
      fs.writeFileSync(historyIndexPath, JSON.stringify({ items: [] }, null, 2), 'utf-8');
    }
  } catch (err) {
    console.error('Failed to ensure history storage:', err);
  }
}

function loadHistoryIndex() {
  ensureHistoryStorage();
  try {
    const raw = fs.readFileSync(historyIndexPath, 'utf-8');
    const obj = JSON.parse(raw || '{}');
    historyIndex = Array.isArray(obj.items) ? obj.items : [];
  } catch (err) {
    console.error('Failed to load history index:', err);
    historyIndex = [];
  }
}

function saveHistoryIndex() {
  try {
    fs.writeFileSync(historyIndexPath, JSON.stringify({ items: historyIndex }, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save history index:', err);
  }
}

function getLogPathForId(id) {
  return path.join(historyLogsDir, `${id}.log`);
}

function pruneHistoryIfNeeded() {
  try {
    if (historyIndex.length <= HISTORY_LIMIT) {return;}
    // sort by startAt (asc) and remove oldest beyond limit
    historyIndex.sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
    const toRemove = historyIndex.splice(0, historyIndex.length - HISTORY_LIMIT);
    saveHistoryIndex();
    // best-effort delete old log files
    toRemove.forEach((it) => {
      try { fs.unlinkSync(getLogPathForId(it.id)); } catch (_) {}
    });
  } catch (err) {
    console.error('Failed to prune history:', err);
  }
}

function createHistoryRecord(label, cwd) {
  try {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const item = { id, label: String(label || ''), cwd: String(cwd || ''), args: [], startAt: new Date().toISOString(), endAt: null, exitCode: null };
    historyIndex.push(item);
    // keep index relatively sorted by start time desc for convenience
    historyIndex.sort((a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime());
    saveHistoryIndex();
    pruneHistoryIfNeeded();
    // ensure empty file exists
    fs.writeFileSync(getLogPathForId(id), '', 'utf-8');
    return id;
  } catch (err) {
    console.error('Failed to create history record:', err);
    return null;
  }
}

function setHistoryArgs(id, args) {
  try {
    const it = historyIndex.find((x) => x.id === id);
    if (!it) {return;}
    it.args = Array.isArray(args) ? args : [];
    saveHistoryIndex();
  } catch (_) {}
}

function appendHistoryLog(id, stream, message) {
  if (!id) {return;}
  try {
    const prefix = stream === 'stderr' ? '[err] ' : '';
    fs.appendFileSync(getLogPathForId(id), prefix + String(message || ''), 'utf-8');
  } catch (err) {
    // ignore append failures; do not crash the app
  }
}

function finalizeHistoryRecord(id, exitCode) {
  try {
    const it = historyIndex.find((x) => x.id === id);
    if (!it) {return;}
    it.exitCode = typeof exitCode === 'number' ? exitCode : Number(exitCode) || 0;
    it.endAt = new Date().toISOString();
    // also append exit code line to the log file for completeness
    try { fs.appendFileSync(getLogPathForId(id), `\n[exit code ${it.exitCode}]\n`, 'utf-8'); } catch (_) {}
    saveHistoryIndex();
  } catch (err) {
    console.error('Failed to finalize history record:', err);
  }
}

function readConfig() {
  try {
    if (fs.existsSync(configFilePath)) {
      const raw = fs.readFileSync(configFilePath, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('Failed to read config:', err);
  }
  return {};
}

function writeConfig(config) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(configFilePath, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('Failed to write config:', err);
  }
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    title: appBuildInfo.title,
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    show: false,
    autoHideMenuBar: true,
  });

  // Hide native menu bar (Windows/Linux)
  try { mainWindow.setMenuBarVisibility(false); } catch (_) {}

  mainWindow.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
    mainWindow.setTitle(appBuildInfo.title);
  });

  mainWindow.once('ready-to-show', () => {
    try {
      // Maximize on first show so the app opens fully expanded
      mainWindow.maximize();
    } catch (_) { /* ignore */ }
    mainWindow.show();
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Remove application menu entirely
  try { Menu.setApplicationMenu(null); } catch (_) {}
  createWindow();
  // Load command history index and ensure storage exists
  loadHistoryIndex();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {createWindow();}
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {app.quit();}
});

/**
 * Spawn a terraform process with given args in a working directory
 * Streams stdout/stderr to renderer via 'terraform:log' channel
 * Returns a promise with the full stdout/stderr and exit code
 */
function runTerraformStreamed(workingDirectory, args) {
  return new Promise((resolve) => {
    const child = spawn('terraform', args, {
      cwd: workingDirectory,
      shell: false,
      windowsHide: true,
      env: { ...process.env, TF_IN_AUTOMATION: '1' },
    });

    let stdout = '';
    let stderr = '';
    const MAX_BUFFER = 10 * 1024 * 1024; // 10MB per stream (tail kept)
    let resolved = false;

    const sendLog = (data, stream) => {
      const message = data.toString();
      if (stream === 'stdout') {
        stdout += message;
        if (stdout.length > MAX_BUFFER) {stdout = stdout.slice(stdout.length - MAX_BUFFER);}
      }
      if (stream === 'stderr') {
        stderr += message;
        if (stderr.length > MAX_BUFFER) {stderr = stderr.slice(stderr.length - MAX_BUFFER);}
      }
      // Also append to the current history record if present
      if (currentHistoryId) {
        appendHistoryLog(currentHistoryId, stream, message);
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terraform:log', { stream, message });
      }
    };

    child.stdout.on('data', (d) => sendLog(d, 'stdout'));
    child.stderr.on('data', (d) => sendLog(d, 'stderr'));

    // Record the args used for this command on the history item
    try { if (currentHistoryId) {setHistoryArgs(currentHistoryId, args);} } catch (_) {}

    child.on('error', (err) => {
      const hint = err && err.code === 'ENOENT'
        ? 'Terraform CLI not found on PATH. Please install Terraform and ensure it is accessible from the system PATH.\n'
        : '';
      sendLog(`Error spawning terraform: ${err.message}\n${hint}`, 'stderr');
      if (!resolved) {
        resolved = true;
        resolve({ code: 127, stdout, stderr, args });
      }
    });

    child.on('close', (code) => {
      if (!resolved) {
        resolved = true;
        resolve({ code, stdout, stderr, args });
      }
    });
  });
}

// Global serialization for Terraform commands (queue/mutex)
let terraformLock = Promise.resolve();
let currentHistoryId = null; // ID of the history record for the currently running command (serialized)

function withTerraformQueue(label, cwd, fn) {
  const run = async () => {
    try {
      // Create a history record for this command and broadcast start
      currentHistoryId = createHistoryRecord(label, cwd);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terraform:command', { event: 'start', label, cwd, id: currentHistoryId });
      }
      const res = await fn();
      // Finalize history with exit code
      try { if (currentHistoryId) {finalizeHistoryRecord(currentHistoryId, res && typeof res.code !== 'undefined' ? res.code : 0);} } catch (_) {}
      return res;
    } finally {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terraform:command', { event: 'end', label, cwd, id: currentHistoryId });
      }
      currentHistoryId = null;
    }
  };
  const p = terraformLock.then(run, run);
  terraformLock = p.catch(() => {});
  return p;
}

function isValidDirectory(dirPath) {
  try {
    if (typeof dirPath !== 'string' || dirPath.trim().length === 0) {return false;}
    const st = fs.statSync(dirPath);
    return st.isDirectory();
  } catch (_) {
    return false;
  }
}

function withValidCwd(label, cwd, fn) {
  if (!isValidDirectory(cwd)) {
    const msg = `Invalid workspace directory: ${String(cwd || '')}`;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terraform:log', { stream: 'stderr', message: msg + '\n' });
    }
    return Promise.resolve({ code: 1, stdout: '', stderr: msg });
  }
  return withTerraformQueue(label, cwd, fn);
}

/**
 * Extract resource addresses from a pulled tfstate JSON object.
 * Supports Terraform state v4 structure where top-level `resources` exist,
 * and each resource may have a `module`, `mode`, `type`, `name`, and `instances`.
 */
function extractAddressesFromTfstateJson(stateObj) {
  try {
    if (!stateObj || !Array.isArray(stateObj.resources)) {return [];}
    const addresses = [];
    for (const res of stateObj.resources) {
      if (!res || !res.type || !res.name) {continue;}
      const modulePrefix = res.module ? res.module + '.' : '';
      const base = (res.mode === 'data')
        ? `data.${res.type}.${res.name}`
        : `${res.type}.${res.name}`;
      const instances = Array.isArray(res.instances) ? res.instances : [];
      if (instances.length === 0) {
        addresses.push(modulePrefix + base);
        continue;
      }
      for (const inst of instances) {
        const key = inst && Object.prototype.hasOwnProperty.call(inst, 'index_key')
          ? inst.index_key
          : undefined;
        if (key === undefined || key === null) {
          addresses.push(modulePrefix + base);
        } else {
          const idx = Array.isArray(key)
            ? `[${key.map((k) => JSON.stringify(k)).join(',')}]`
            : `[${JSON.stringify(key)}]`;
          addresses.push(modulePrefix + base + idx);
        }
      }
    }
    // Ensure uniqueness and stable order
    return Array.from(new Set(addresses)).sort();
  } catch (_) {
    return [];
  }
}

function getStateSnapshotCacheKey(cwd) {
  try {
    return path.resolve(String(cwd || ''));
  } catch (_) {
    return String(cwd || '');
  }
}

function invalidateStateSnapshot(cwd) {
  if (cwd) {
    stateSnapshotCache.delete(getStateSnapshotCacheKey(cwd));
    return;
  }
  stateSnapshotCache.clear();
}

async function getStateSnapshot(cwd, options = {}) {
  const key = getStateSnapshotCacheKey(cwd);
  const cached = stateSnapshotCache.get(key);
  if (!options.force && cached) {
    return { ...cached, fromCache: true };
  }

  const pullRes = await runTerraformStreamed(cwd, ['state', 'pull']);
  let stateJson = null;
  let resources = [];
  let snapshotAt = null;
  try {
    stateJson = JSON.parse(pullRes.stdout || '');
    resources = extractAddressesFromTfstateJson(stateJson);
    snapshotAt = new Date().toISOString();
  } catch (_) {
    return { ...pullRes, stateJson: null, resources: [], snapshotAt: null, fromCache: false };
  }

  const createdAt = Date.now();
  const snapshot = {
    code: pullRes.code,
    stdout: pullRes.stdout,
    stderr: pullRes.stderr,
    args: pullRes.args,
    stateJson,
    resources,
    snapshotAt,
    createdAt,
  };
  if (pullRes.code === 0) {
    stateSnapshotCache.set(key, snapshot);
  }
  return { ...snapshot, fromCache: false };
}

async function withStateSnapshotFile(cwd, fn) {
  const snapshot = await getStateSnapshot(cwd);
  if (snapshot.code !== 0 || !snapshot.stdout) {
    return { snapshot, result: null };
  }

  const tmpName = `tfstate-ui-${Date.now()}-${Math.random().toString(36).slice(2)}.tfstate`;
  const tmpPath = path.join(os.tmpdir(), tmpName);
  try {
    fs.writeFileSync(tmpPath, snapshot.stdout, 'utf-8');
    const result = await fn(tmpPath, snapshot);
    return { snapshot, result };
  } catch (_) {
    return { snapshot, result: null };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore unlink failure */ }
  }
}

async function withStateMutation(label, cwd, fn) {
  invalidateStateSnapshot(cwd);
  const res = await withValidCwd(label, cwd, fn);
  invalidateStateSnapshot(cwd);
  return res;
}

async function detectRefreshOnlySupport(workingDirectory) {
  // Conservative default: prefer refresh-only if available
  try {
    const result = await runTerraformStreamed(workingDirectory, ['version']);
    const text = (result.stdout || '') + (result.stderr || '');
    // Terraform v0.15+ supports -refresh-only. Assume true for v1+
    const match = text.match(/Terraform v(\d+)\.(\d+)\.(\d+)/i);
    if (match) {
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      return major >= 1 || (major === 0 && minor >= 15);
    }
  } catch (e) {
    // ignore, fallback below
  }
  return true;
}

// Build additional -var-file arguments
function buildVarFileArgs(varFiles) {
  try {
    const files = Array.isArray(varFiles) ? varFiles : [];
    return files.filter(Boolean).map((f) => `-var-file=${f}`);
  } catch (_) {
    return [];
  }
}

// Parse `terraform workspace list` output
function parseWorkspaceList(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const workspaces = [];
  let current = '';
  for (const line of lines) {
    const isCurrent = line.startsWith('*');
    const name = line.replace(/^\*\s*/, '');
    workspaces.push(name);
    if (isCurrent) {current = name;}
  }
  return { workspaces, current };
}

// Recursively find *.tfvars and *.tfvars.json under cwd (excluding .terraform/.git/node_modules)
function findTfvarsFiles(rootDir) {
  const results = [];
  const stack = [rootDir];
  const IGNORE = new Set(['.terraform', '.git', 'node_modules']);
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!IGNORE.has(ent.name)) {stack.push(full);}
      } else if (ent.isFile()) {
        if (/\.tfvars(\.json)?$/i.test(ent.name)) {
          results.push(full);
        }
      }
    }
  }
  // stable sort: root-first then alphabetical
  results.sort((a, b) => a.localeCompare(b));
  return results;
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {return null;}
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (_) {
    return null;
  }
}

function readCurrentTerraformWorkspace(cwd) {
  try {
    const envPath = path.join(cwd, '.terraform', 'environment');
    if (fs.existsSync(envPath)) {
      const name = fs.readFileSync(envPath, 'utf-8').trim();
      if (name) {return name;}
    }
  } catch (_) {}
  return 'default';
}

function findDeclaredBackendType(cwd) {
  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile() || !/\.tf$/i.test(ent.name)) {continue;}
      const text = fs.readFileSync(path.join(cwd, ent.name), 'utf-8');
      const match = text.match(/\bbackend\s+"([^"]+)"/);
      if (match && match[1]) {
        return { type: match[1], file: ent.name };
      }
    }
  } catch (_) {}
  return null;
}

function displayBackendName(type) {
  const names = {
    azurerm: 'Azure Storage',
    cloud: 'Terraform Cloud',
    consul: 'Consul',
    cos: 'Tencent COS',
    etcd: 'etcd',
    etcdv3: 'etcd v3',
    gcs: 'Google Cloud Storage',
    http: 'HTTP',
    kubernetes: 'Kubernetes',
    local: 'Local',
    oss: 'Alibaba OSS',
    pg: 'PostgreSQL',
    remote: 'Terraform Cloud',
    s3: 'Amazon S3',
  };
  return names[type] || String(type || 'Unknown');
}

function safeConfigString(value) {
  if (value === undefined || value === null || value === '') {return '';}
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function redactUrl(raw) {
  const text = safeConfigString(raw);
  if (!text) {return '';}
  try {
    const url = new URL(text);
    if (url.username) {url.username = 'redacted';}
    if (url.password) {url.password = 'redacted';}
    for (const key of Array.from(url.searchParams.keys())) {
      if (/(token|secret|password|sig|signature|key|credential)/i.test(key)) {
        url.searchParams.set(key, 'redacted');
      }
    }
    return url.toString();
  } catch (_) {
    return text.replace(/\/\/([^:@/]+):([^@/]+)@/, '//redacted:redacted@');
  }
}

function safeFieldsForBackend(type, config, workspace) {
  const cfg = config && typeof config === 'object' ? config : {};
  const get = (key) => safeConfigString(cfg[key]);
  const fields = [];
  const add = (label, value) => {
    if (value) {fields.push({ label, value });}
  };

  if (type === 's3') {
    const bucket = get('bucket');
    const key = get('key');
    const prefix = get('workspace_key_prefix') || 'env:';
    const effectiveKey = workspace && workspace !== 'default' && key ? `${prefix}/${workspace}/${key}` : key;
    add('Bucket', bucket);
    add('Object', effectiveKey);
    add('Region', get('region'));
  } else if (type === 'azurerm') {
    add('Storage account', get('storage_account_name'));
    add('Container', get('container_name'));
    add('Blob', get('key'));
    add('Resource group', get('resource_group_name'));
  } else if (type === 'gcs') {
    add('Bucket', get('bucket'));
    add('Prefix', get('prefix'));
  } else if (type === 'local') {
    add('Path', get('path'));
    add('Workspace directory', get('workspace_dir'));
  } else if (type === 'remote' || type === 'cloud') {
    add('Hostname', get('hostname'));
    add('Organization', get('organization'));
    if (cfg.workspaces && typeof cfg.workspaces === 'object') {
      add('Workspace', safeConfigString(cfg.workspaces.name));
      add('Workspace prefix', safeConfigString(cfg.workspaces.prefix));
    }
  } else if (type === 'http') {
    add('Address', redactUrl(cfg.address));
  } else if (type === 'consul') {
    add('Address', redactUrl(cfg.address));
    add('Path', get('path'));
  } else if (type === 'kubernetes') {
    add('Secret', get('secret_suffix') || get('secret_name'));
    add('Namespace', get('namespace'));
  } else if (type === 'pg') {
    add('Schema', get('schema_name'));
  } else {
    const allow = ['bucket', 'container', 'container_name', 'endpoint', 'hostname', 'key', 'name', 'organization', 'path', 'prefix', 'region', 'storage_account_name'];
    for (const key of allow) {
      add(key.replace(/_/g, ' '), safeConfigString(cfg[key]));
    }
  }

  add('Workspace', workspace || 'default');
  return fields;
}

function resolveLocalStatePath(cwd, config, workspace) {
  const cfg = config && typeof config === 'object' ? config : {};
  if (workspace && workspace !== 'default') {
    const workspaceDir = safeConfigString(cfg.workspace_dir) || 'terraform.tfstate.d';
    return path.resolve(cwd, workspaceDir, workspace, 'terraform.tfstate');
  }
  const statePath = safeConfigString(cfg.path) || 'terraform.tfstate';
  return path.isAbsolute(statePath) ? statePath : path.resolve(cwd, statePath);
}

function compactStateStorageDetail(type, fields) {
  const valueFor = (label) => {
    const field = fields.find((f) => f.label === label);
    return field ? field.value : '';
  };
  if (type === 's3') {
    return [valueFor('Bucket'), valueFor('Object')].filter(Boolean).join('/');
  }
  if (type === 'azurerm') {
    return [valueFor('Storage account'), valueFor('Container'), valueFor('Blob')].filter(Boolean).join('/');
  }
  if (type === 'gcs') {
    return [valueFor('Bucket'), valueFor('Prefix')].filter(Boolean).join('/');
  }
  if (type === 'local') {
    return valueFor('Path');
  }
  if (type === 'remote' || type === 'cloud') {
    return [valueFor('Organization'), valueFor('Workspace') || valueFor('Workspace prefix')].filter(Boolean).join('/');
  }
  return fields.length ? fields[0].value : '';
}

function buildStateStorageInfo(cwd) {
  const workspace = readCurrentTerraformWorkspace(cwd);
  const backendStatePath = path.join(cwd, '.terraform', 'terraform.tfstate');
  const backendState = readJsonFile(backendStatePath);
  const backend = backendState && backendState.backend && typeof backendState.backend === 'object'
    ? backendState.backend
    : null;

  let type = backend && backend.type ? String(backend.type) : '';
  let config = backend && backend.config && typeof backend.config === 'object' ? backend.config : {};
  let source = backend ? 'initialized' : 'fallback';
  let note = '';

  if (!type) {
    const declared = findDeclaredBackendType(cwd);
    if (declared) {
      type = declared.type;
      source = 'declared';
      note = `Backend declared in ${declared.file}, but initialized backend metadata was not found.`;
    } else {
      type = 'local';
      source = 'local-default';
      note = 'No initialized backend metadata or backend declaration was found.';
    }
  }

  if (type === 'local') {
    config = { ...config, path: resolveLocalStatePath(cwd, config, workspace) };
  }

  const fields = safeFieldsForBackend(type, config, workspace);
  const displayName = displayBackendName(type);
  const detail = compactStateStorageDetail(type, fields);
  const titleLines = [
    `Terraform state backend: ${displayName} (${type})`,
    ...fields.map((field) => `${field.label}: ${field.value}`),
  ];
  if (note) {titleLines.push(note);}

  return {
    code: 0,
    type,
    displayName,
    label: `State: ${displayName}`,
    detail,
    fields,
    source,
    workspace,
    title: titleLines.join('\n'),
  };
}

// Workspace persistence helpers
ipcMain.handle('workspace:get', async () => {
  const cfg = readConfig();
  return cfg.workspacePath || '';
});

ipcMain.handle('workspace:set', async (_event, workspacePath) => {
  const cfg = readConfig();
  if (isValidDirectory(workspacePath)) {
    cfg.workspacePath = workspacePath;
    writeConfig(cfg);
    return cfg.workspacePath;
  }
  return cfg.workspacePath || '';
});

ipcMain.handle('workspace:select', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) {return '';}
  const selected = result.filePaths[0];
  if (isValidDirectory(selected)) {
    const cfg = readConfig();
    cfg.workspacePath = selected;
    writeConfig(cfg);
    return selected;
  }
  return '';
});

// Open external URLs (if any are added later)
ipcMain.handle('openExternal', async (_event, url) => {
  await shell.openExternal(url);
});

ipcMain.handle('app:build-info', async () => {
  return appBuildInfo;
});

// Terraform commands
ipcMain.handle('terraform:init', async (_e, cwd, options = {}) => {
  // Support basic init options: -upgrade, -reconfigure, -backend-config
  const args = ['init', '-input=false'];
  try {
    if (options && options.upgrade === true) {args.push('-upgrade');}
    if (options && options.reconfigure === true) {args.push('-reconfigure');}
    if (options && Array.isArray(options.backendConfig)) {
      for (const kv of options.backendConfig) {
        if (!kv) {continue;}
        args.push(`-backend-config=${kv}`);
      }
    }
  } catch (_) {}
  return withStateMutation('init', cwd, () => runTerraformStreamed(cwd, args));
});

function buildPlanArgs(options) {
  const args = ['plan', '-input=false'];
  const varArgs = buildVarFileArgs(options && options.varFiles);
  args.push(...varArgs);
  try {
    if (options) {
      if (options.lock === false) {args.push('-lock=false');}
      if (options.refresh === false) {args.push('-refresh=false');}
      if (options.destroy === true) {args.push('-destroy');}
      if (options.parallelism && Number.isFinite(Number(options.parallelism))) {args.push(`-parallelism=${Number(options.parallelism)}`);}
      if (Array.isArray(options.targets)) {
        for (const t of options.targets) {
          if (!t) {continue;}
          args.push(`-target=${t}`);
        }
      }
    }
  } catch (_) {}
  return args;
}

ipcMain.handle('terraform:plan', async (_e, cwd, options) => {
  const args = buildPlanArgs(options);
  return withValidCwd('plan', cwd, () => runTerraformStreamed(cwd, args));
});

ipcMain.handle('terraform:apply', async (_e, cwd, options) => {
  const varArgs = buildVarFileArgs(options && options.varFiles);
  return withStateMutation('apply', cwd, () => runTerraformStreamed(cwd, ['apply', '-input=false', '-auto-approve', ...varArgs]));
});

ipcMain.handle('terraform:destroy', async (_e, cwd, options) => {
  const varArgs = buildVarFileArgs(options && options.varFiles);
  return withStateMutation('destroy', cwd, () => runTerraformStreamed(cwd, ['destroy', '-input=false', '-auto-approve', ...varArgs]));
});

ipcMain.handle('terraform:refresh', async (_e, cwd, options) => {
  const varArgs = buildVarFileArgs(options && options.varFiles);
  return withStateMutation('refresh', cwd, async () => {
    const supportsRefreshOnly = await detectRefreshOnlySupport(cwd);
    if (supportsRefreshOnly) {
      return runTerraformStreamed(cwd, ['apply', '-refresh-only', '-input=false', '-auto-approve', ...varArgs]);
    }
    return runTerraformStreamed(cwd, ['refresh', '-input=false', ...varArgs]);
  });
});

ipcMain.handle('terraform:state:list', async (_e, cwd) => {
  return withValidCwd('state pull', cwd, async () => {
    // Prefer pulling state JSON and deriving addresses for remote/local backends uniformly
    const snapshot = await getStateSnapshot(cwd);
    if (!snapshot.stateJson) {
      // Fallback to `state list` if parsing fails
      const listRes = await runTerraformStreamed(cwd, ['state', 'list']);
      const resources = (listRes.stdout || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const snapshotAt = listRes.code === 0 ? new Date().toISOString() : null;
      return { ...listRes, resources, snapshotAt };
    }
    return { ...snapshot, resources: snapshot.resources, snapshotAt: snapshot.snapshotAt };
  });
});

ipcMain.handle('terraform:state:storage', async (_e, cwd) => {
  try {
    if (!isValidDirectory(cwd)) {return { code: 1, error: 'Invalid workspace directory' };}
    return buildStateStorageInfo(cwd);
  } catch (err) {
    return { code: 1, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('terraform:state:show', async (_e, cwd, address) => {
  return withValidCwd('state show', cwd, async () => {
    const cached = await withStateSnapshotFile(cwd, (tmpPath) => {
      return runTerraformStreamed(cwd, ['state', 'show', `-state=${tmpPath}`, address]);
    });
    if (cached.result) {
      return { ...cached.result, snapshotAt: cached.snapshot.snapshotAt, fromCache: true };
    }
    return runTerraformStreamed(cwd, ['state', 'show', address]);
  });
});

ipcMain.handle('terraform:show:json', async (_e, cwd) => {
  return withValidCwd('show:json', cwd, async () => {
    // Render JSON from the cached state snapshot.
    const cached = await withStateSnapshotFile(cwd, (tmpPath) => {
      return runTerraformStreamed(cwd, ['show', '-json', tmpPath]);
    });
    if (!cached.result) {
      // Fallback to direct show -json if pull failed
      const res = await runTerraformStreamed(cwd, ['show', '-json']);
      let json = null;
      try { json = JSON.parse(res.stdout); } catch (_) {}
      return { ...res, json, snapshotAt: null };
    }
    let json = null;
    try { json = JSON.parse(cached.result.stdout); } catch (_) { /* ignore parse failure */ }
    return { ...cached.result, json, snapshotAt: cached.snapshot.snapshotAt };
  });
});

ipcMain.handle('terraform:state:mv', async (_e, cwd, sourceAddress, destAddress) => {
  return withStateMutation('state mv', cwd, () => runTerraformStreamed(cwd, ['state', 'mv', sourceAddress, destAddress]));
});

ipcMain.handle('terraform:state:rm', async (_e, cwd, address) => {
  return withStateMutation('state rm', cwd, () => runTerraformStreamed(cwd, ['state', 'rm', address]));
});

ipcMain.handle('terraform:import', async (_e, cwd, address, id, options) => {
  const varArgs = buildVarFileArgs(options && options.varFiles);
  return withStateMutation('import', cwd, () => runTerraformStreamed(cwd, ['import', '-input=false', ...varArgs, address, id]));
});

ipcMain.handle('terraform:plan:json', async (_e, cwd, options) => {
  return withValidCwd('plan:json', cwd, async () => {
    const tmpName = `tfplan-ui-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`;
    const tmpPath = path.join(os.tmpdir(), tmpName);
    const args = buildPlanArgs(options);
    // ensure -out is present for show -json step
    const planRes = await runTerraformStreamed(cwd, [...args, `-out=${tmpPath}`]);
    if (planRes.code !== 0) {
      // best-effort cleanup
      try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore unlink failure */ }
      return { ...planRes, json: null };
    }
    const showRes = await runTerraformStreamed(cwd, ['show', '-json', tmpPath]);
    let json = null;
    try {
      json = JSON.parse(showRes.stdout);
    } catch (_) {
      // ignore
    }
    try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore unlink failure */ }
    return { ...showRes, json };
  });
});

// (Removed graph:plan handler; DOT graph no longer used)

// Terraform workspaces
ipcMain.handle('terraform:workspaces:list', async (_e, cwd) => {
  return withValidCwd('workspace list', cwd, async () => {
    const res = await runTerraformStreamed(cwd, ['workspace', 'list']);
    const parsed = parseWorkspaceList(res.stdout || res.stderr || '');
    return { ...res, ...parsed };
  });
});

ipcMain.handle('terraform:workspace:select', async (_e, cwd, name) => {
  return withStateMutation('workspace select', cwd, () => runTerraformStreamed(cwd, ['workspace', 'select', name]));
});

// List tfvars files
ipcMain.handle('terraform:tfvars:list', async (_e, cwd) => {
  try {
    if (!isValidDirectory(cwd)) {return { code: 1, files: [], error: 'Invalid workspace directory' };}
    const files = findTfvarsFiles(cwd);
    return { code: 0, files };
  } catch (err) {
    return { code: 1, files: [], error: String(err && err.message ? err.message : err) };
  }
});

// Persist selection of tfvars per workspace path
ipcMain.handle('tfvars:selection:get', async (_e, cwd) => {
  try {
    const cfg = readConfig();
    const all = cfg.tfvarsSelections || {};
    const key = String(cwd || '');
    const selected = Array.isArray(all[key]) ? all[key] : [];
    return { files: selected };
  } catch (err) {
    return { files: [], error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('tfvars:selection:set', async (_e, cwd, files) => {
  try {
    const cfg = readConfig();
    if (!cfg.tfvarsSelections) {cfg.tfvarsSelections = {};}
    const key = String(cwd || '');
    cfg.tfvarsSelections[key] = Array.isArray(files) ? files.filter(Boolean) : [];
    writeConfig(cfg);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

// Log history IPC
ipcMain.handle('logs:history:list', async () => {
  try {
    // Return shallow copy sorted by startAt desc
    const items = historyIndex.slice().sort((a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime());
    return { items };
  } catch (err) {
    return { items: [], error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('logs:history:get', async (_e, id) => {
  try {
    const item = historyIndex.find((x) => x.id === id) || null;
    if (!item) {return { item: null, text: '', error: 'Not found' };}
    let text = '';
    try { text = fs.readFileSync(getLogPathForId(id), 'utf-8'); } catch (_) { text = ''; }
    return { item, text };
  } catch (err) {
    return { item: null, text: '', error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('logs:history:clear', async () => {
  try {
    // best-effort clear
    historyIndex.forEach((it) => { try { fs.unlinkSync(getLogPathForId(it.id)); } catch (_) {} });
    historyIndex = [];
    saveHistoryIndex();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});



