const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

/**
 * Simple JSON config to persist last used workspace directory
 */
const userDataDir = app.getPath('userData');
const configFilePath = path.join(userDataDir, 'config.json');

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
    mainWindow.show();
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

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
      shell: true,
      env: { ...process.env, TF_IN_AUTOMATION: '1' },
    });

    let stdout = '';
    let stderr = '';

    const sendLog = (data, stream) => {
      const message = data.toString();
      if (stream === 'stdout') stdout += message;
      if (stream === 'stderr') stderr += message;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terraform:log', { stream, message });
      }
    };

    child.stdout.on('data', (d) => sendLog(d, 'stdout'));
    child.stderr.on('data', (d) => sendLog(d, 'stderr'));

    child.on('error', (err) => {
      sendLog(`Error spawning terraform: ${err.message}\n`, 'stderr');
    });

    child.on('close', (code) => {
      resolve({ code, stdout, stderr, args });
    });
  });
}

// Global serialization for Terraform commands (queue/mutex)
let terraformLock = Promise.resolve();

function withTerraformQueue(label, cwd, fn) {
  const run = async () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terraform:command', { event: 'start', label, cwd });
      }
      const res = await fn();
      return res;
    } finally {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terraform:command', { event: 'end', label, cwd });
      }
    }
  };
  const p = terraformLock.then(run, run);
  terraformLock = p.catch(() => {});
  return p;
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
  cfg.workspacePath = workspacePath;
  writeConfig(cfg);
  return cfg.workspacePath;
});

ipcMain.handle('workspace:select', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return '';
  const selected = result.filePaths[0];
  const cfg = readConfig();
  cfg.workspacePath = selected;
  writeConfig(cfg);
  return selected;
});

// Open external URLs (if any are added later)
ipcMain.handle('openExternal', async (_event, url) => {
  await shell.openExternal(url);
});

// Terraform commands
ipcMain.handle('terraform:init', async (_e, cwd) => {
  return withTerraformQueue('init', cwd, () => runTerraformStreamed(cwd, ['init', '-input=false']));
});

ipcMain.handle('terraform:plan', async (_e, cwd, options) => {
  const varArgs = buildVarFileArgs(options && options.varFiles);
  return withTerraformQueue('plan', cwd, () => runTerraformStreamed(cwd, ['plan', ...varArgs]));
});

ipcMain.handle('terraform:apply', async (_e, cwd, options) => {
  const varArgs = buildVarFileArgs(options && options.varFiles);
  return withTerraformQueue('apply', cwd, () => runTerraformStreamed(cwd, ['apply', '-auto-approve', ...varArgs]));
});

ipcMain.handle('terraform:destroy', async (_e, cwd, options) => {
  const varArgs = buildVarFileArgs(options && options.varFiles);
  return withTerraformQueue('destroy', cwd, () => runTerraformStreamed(cwd, ['destroy', '-auto-approve', ...varArgs]));
});

ipcMain.handle('terraform:refresh', async (_e, cwd, options) => {
  const varArgs = buildVarFileArgs(options && options.varFiles);
  return withTerraformQueue('refresh', cwd, async () => {
    const supportsRefreshOnly = await detectRefreshOnlySupport(cwd);
    if (supportsRefreshOnly) {
      return runTerraformStreamed(cwd, ['apply', '-refresh-only', '-auto-approve', ...varArgs]);
    }
    return runTerraformStreamed(cwd, ['refresh', ...varArgs]);
  });
});

ipcMain.handle('terraform:state:list', async (_e, cwd) => {
  return withTerraformQueue('state pull', cwd, async () => {
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
  return withTerraformQueue('state show', cwd, () => runTerraformStreamed(cwd, ['state', 'show', address]));
});

ipcMain.handle('terraform:show:json', async (_e, cwd) => {
  return withTerraformQueue('show:json', cwd, async () => {
    // Pull current state to a temp file, then ask terraform to render JSON from that snapshot
    const tmpName = `tfstate-ui-${Date.now()}.tfstate`;
    const tmpPath = path.join(cwd, tmpName);
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
    try { json = JSON.parse(showRes.stdout); } catch (_) {}
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    return { ...showRes, json, snapshotAt };
  });
});

ipcMain.handle('terraform:state:mv', async (_e, cwd, sourceAddress, destAddress) => {
  return withTerraformQueue('state mv', cwd, () => runTerraformStreamed(cwd, ['state', 'mv', sourceAddress, destAddress]));
});

ipcMain.handle('terraform:state:rm', async (_e, cwd, address) => {
  return withTerraformQueue('state rm', cwd, () => runTerraformStreamed(cwd, ['state', 'rm', address]));
});

ipcMain.handle('terraform:import', async (_e, cwd, address, id) => {
  return withTerraformQueue('import', cwd, () => runTerraformStreamed(cwd, ['import', address, id]));
});

ipcMain.handle('terraform:plan:json', async (_e, cwd, options) => {
  return withTerraformQueue('plan:json', cwd, async () => {
    const tmpName = `tfplan-ui-${Date.now()}.bin`;
    const tmpPath = path.join(cwd, tmpName);
    const varArgs = buildVarFileArgs(options && options.varFiles);
    const planRes = await runTerraformStreamed(cwd, ['plan', '-input=false', `-out=${tmpName}`, ...varArgs]);
    if (planRes.code !== 0) {
      // best-effort cleanup
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      return { ...planRes, json: null };
    }
    const showRes = await runTerraformStreamed(cwd, ['show', '-json', tmpName]);
    let json = null;
    try {
      json = JSON.parse(showRes.stdout);
    } catch (_) {
      // ignore
    }
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    return { ...showRes, json };
  });
});

ipcMain.handle('terraform:graph:plan', async (_e, cwd, options) => {
  return withTerraformQueue('graph:plan', cwd, async () => {
    const tmpName = `tfplan-ui-${Date.now()}.bin`;
    const tmpPath = path.join(cwd, tmpName);
    const varArgs = buildVarFileArgs(options && options.varFiles);
    const planRes = await runTerraformStreamed(cwd, ['plan', '-input=false', `-out=${tmpName}`, ...varArgs]);
    if (planRes.code !== 0) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      return { ...planRes, dot: '' };
    }
    const graphRes = await runTerraformStreamed(cwd, ['graph', `-plan=${tmpName}`, '-draw-cycles']);
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    return { ...graphRes, dot: graphRes.stdout };
  });
});

// Terraform workspaces
ipcMain.handle('terraform:workspaces:list', async (_e, cwd) => {
  return withTerraformQueue('workspace list', cwd, async () => {
    const res = await runTerraformStreamed(cwd, ['workspace', 'list']);
    const parsed = parseWorkspaceList(res.stdout || res.stderr || '');
    return { ...res, ...parsed };
  });
});

ipcMain.handle('terraform:workspace:select', async (_e, cwd, name) => {
  return withTerraformQueue('workspace select', cwd, () => runTerraformStreamed(cwd, ['workspace', 'select', name]));
});

// List tfvars files
ipcMain.handle('terraform:tfvars:list', async (_e, cwd) => {
  try {
    const files = findTfvarsFiles(cwd);
    return { code: 0, files };
  } catch (err) {
    return { code: 1, files: [], error: String(err && err.message ? err.message : err) };
  }
});



