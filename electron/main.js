const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
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

/**
 * In-memory index of history items
 * Each item: { id, label, cwd, args, startAt, endAt, exitCode }
 */
let historyIndex = [];

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
    if (historyIndex.length <= HISTORY_LIMIT) return;
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
    if (!it) return;
    it.args = Array.isArray(args) ? args : [];
    saveHistoryIndex();
  } catch (_) {}
}

function appendHistoryLog(id, stream, message) {
  if (!id) return;
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
    if (!it) return;
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
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    show: false,
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
  createWindow();
  // Load command history index and ensure storage exists
  loadHistoryIndex();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
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
        if (stdout.length > MAX_BUFFER) stdout = stdout.slice(stdout.length - MAX_BUFFER);
      }
      if (stream === 'stderr') {
        stderr += message;
        if (stderr.length > MAX_BUFFER) stderr = stderr.slice(stderr.length - MAX_BUFFER);
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
    try { if (currentHistoryId) setHistoryArgs(currentHistoryId, args); } catch (_) {}

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
      try { if (currentHistoryId) finalizeHistoryRecord(currentHistoryId, res && typeof res.code !== 'undefined' ? res.code : 0); } catch (_) {}
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
    if (typeof dirPath !== 'string' || dirPath.trim().length === 0) return false;
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
    if (!stateObj || !Array.isArray(stateObj.resources)) return [];
    const addresses = [];
    for (const res of stateObj.resources) {
      if (!res || !res.type || !res.name) continue;
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
    if (isCurrent) current = name;
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
        if (!IGNORE.has(ent.name)) stack.push(full);
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
  if (result.canceled || result.filePaths.length === 0) return '';
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

// Terraform commands
ipcMain.handle('terraform:init', async (_e, cwd) => {
  return withValidCwd('init', cwd, () => runTerraformStreamed(cwd, ['init', '-input=false']));
});

ipcMain.handle('terraform:plan', async (_e, cwd, options) => {
  const varArgs = buildVarFileArgs(options && options.varFiles);
  return withValidCwd('plan', cwd, () => runTerraformStreamed(cwd, ['plan', '-input=false', ...varArgs]));
});

ipcMain.handle('terraform:apply', async (_e, cwd, options) => {
  const varArgs = buildVarFileArgs(options && options.varFiles);
  return withValidCwd('apply', cwd, () => runTerraformStreamed(cwd, ['apply', '-input=false', '-auto-approve', ...varArgs]));
});

ipcMain.handle('terraform:destroy', async (_e, cwd, options) => {
  const varArgs = buildVarFileArgs(options && options.varFiles);
  return withValidCwd('destroy', cwd, () => runTerraformStreamed(cwd, ['destroy', '-input=false', '-auto-approve', ...varArgs]));
});

ipcMain.handle('terraform:refresh', async (_e, cwd, options) => {
  const varArgs = buildVarFileArgs(options && options.varFiles);
  return withValidCwd('refresh', cwd, async () => {
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
    const pullRes = await runTerraformStreamed(cwd, ['state', 'pull']);
    let resources = [];
    let snapshotAt = null;
    try {
      const obj = JSON.parse(pullRes.stdout || '');
      resources = extractAddressesFromTfstateJson(obj);
      snapshotAt = new Date().toISOString();
    } catch (_) {
      // Fallback to `state list` if parsing fails
      const listRes = await runTerraformStreamed(cwd, ['state', 'list']);
      resources = (listRes.stdout || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      return { ...listRes, resources, snapshotAt };
    }
    return { ...pullRes, resources, snapshotAt };
  });
});

ipcMain.handle('terraform:state:show', async (_e, cwd, address) => {
  return withValidCwd('state show', cwd, () => runTerraformStreamed(cwd, ['state', 'show', address]));
});

ipcMain.handle('terraform:show:json', async (_e, cwd) => {
  return withValidCwd('show:json', cwd, async () => {
    // Pull current state to a temp file in OS temp dir, then render JSON
    const tmpName = `tfstate-ui-${Date.now()}-${Math.random().toString(36).slice(2)}.tfstate`;
    const tmpPath = path.join(os.tmpdir(), tmpName);
    const pullRes = await runTerraformStreamed(cwd, ['state', 'pull']);
    if (pullRes.code !== 0 || !pullRes.stdout) {
      // Fallback to direct show -json if pull failed
      const res = await runTerraformStreamed(cwd, ['show', '-json']);
      let json = null;
      try { json = JSON.parse(res.stdout); } catch (_) {}
      return { ...res, json, snapshotAt: null };
    }
    const snapshotAt = new Date().toISOString();
    try {
      fs.writeFileSync(tmpPath, pullRes.stdout, 'utf-8');
    } catch (_) {
      // If writing fails, fallback
      const res = await runTerraformStreamed(cwd, ['show', '-json']);
      let json = null;
      try { json = JSON.parse(res.stdout); } catch (_) {}
      return { ...res, json, snapshotAt: null };
    }
    const showRes = await runTerraformStreamed(cwd, ['show', '-json', tmpPath]);
    let json = null;
    try { json = JSON.parse(showRes.stdout); } catch (_) { /* ignore parse failure */ }
    try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore unlink failure */ }
    return { ...showRes, json, snapshotAt };
  });
});

ipcMain.handle('terraform:state:mv', async (_e, cwd, sourceAddress, destAddress) => {
  return withValidCwd('state mv', cwd, () => runTerraformStreamed(cwd, ['state', 'mv', sourceAddress, destAddress]));
});

ipcMain.handle('terraform:state:rm', async (_e, cwd, address) => {
  return withValidCwd('state rm', cwd, () => runTerraformStreamed(cwd, ['state', 'rm', address]));
});

ipcMain.handle('terraform:import', async (_e, cwd, address, id, options) => {
  const varArgs = buildVarFileArgs(options && options.varFiles);
  return withValidCwd('import', cwd, () => runTerraformStreamed(cwd, ['import', '-input=false', ...varArgs, address, id]));
});

ipcMain.handle('terraform:plan:json', async (_e, cwd, options) => {
  return withValidCwd('plan:json', cwd, async () => {
    const tmpName = `tfplan-ui-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`;
    const tmpPath = path.join(os.tmpdir(), tmpName);
    const varArgs = buildVarFileArgs(options && options.varFiles);
    const planRes = await runTerraformStreamed(cwd, ['plan', '-input=false', `-out=${tmpPath}`, ...varArgs]);
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
  return withValidCwd('workspace select', cwd, () => runTerraformStreamed(cwd, ['workspace', 'select', name]));
});

// List tfvars files
ipcMain.handle('terraform:tfvars:list', async (_e, cwd) => {
  try {
    if (!isValidDirectory(cwd)) return { code: 1, files: [], error: 'Invalid workspace directory' };
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
    if (!cfg.tfvarsSelections) cfg.tfvarsSelections = {};
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
    if (!item) return { item: null, text: '', error: 'Not found' };
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



