# terraform-ui
An advanced user UI for Terraform.

## Features
- **Resources explorer**: Browse all resources in the current workspace and inspect details.
- **Dependency graph**: Visual graph of resources and their references (from Terraform JSON). Right-click nodes to rename (state mv) or remove from state.
- **One-click actions**: Buttons for `init`, `plan`, `refresh`, `apply`, `destroy` with live logs.
- **State refactor tools**: Run `terraform state mv` and `terraform state rm` safely.
- **Import helper**: Import existing infrastructure with `terraform import`.

## Tech Stack
- Electron app (main + preload + renderer, no bundler required)

## Prerequisites
- Node.js 18+
- Terraform CLI installed and available on PATH

## Quickstart
1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the app:
   ```bash
   npm start
   ```
3. In the app, click “Open Workspace” and select a folder containing your Terraform configuration.

You can try the sample under `example_terraform/tfm-example`.

## Build (Windows .exe)
- Ensure you are on Windows with Node 18+ installed.
- Install dependencies (`npm install`).
- Build an installer (.exe):
  ```bash
  npm run dist:win
  ```
  Outputs to `dist/` (NSIS one-click installer). For 64-bit only build:
  ```bash
  npm run dist:win:x64
  ```

Notes:
- The app is packaged using Electron Builder (NSIS target). The generated installer will install a desktop app that launches `electron/main.js` with the bundled renderer.
- You still need the Terraform CLI installed on the machine where you run the app; this project does not bundle Terraform itself.

Troubleshooting (Windows symlink privilege during build):
- If the build fails with a 7-Zip error like “Cannot create symbolic link: A required privilege is not held by the client”, do one of the following:
  - Run PowerShell as Administrator and re-run the build
  - Or enable Windows Developer Mode (Settings → Privacy & Security → For developers → Developer Mode), then re-open PowerShell
- Clear the partially extracted cache before retrying:
  ```powershell
  if (Test-Path "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign") {
    Remove-Item "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign" -Recurse -Force
  }
  npm run dist:win
  ```

## Usage Notes
- Logs stream in real-time at the bottom panel.
- “Refresh” uses `apply -refresh-only` when supported, falling back to `terraform refresh` on older versions.
- Resource details are shown via `terraform state show <address>`.
- State refactor:
  - Move: provide source and destination addresses (e.g., `aws_instance.web` → `aws_instance.web_new`).
  - Remove: removes a resource from state only (does not destroy in cloud).
- Import: provide resource address and provider-specific ID.

## Security
- The renderer has no Node.js access. A secure preload exposes a minimal API over IPC.

## Project Structure
```
terraform-ui/
  electron/
    main.js        # Electron main process & IPC handlers
    preload.js     # Secure API exposed to renderer
  renderer/
    index.html     # UI layout
    renderer.js    # UI logic & IPC calls
    styles.css     # Styling
  example_terraform/  # Sample config
  package.json
  README.md
```

## Roadmap
- Plan/apply diff viewer from JSON output
- Graph view of resource dependencies
- Multi-workspace selection and favorites
- TS + React renderer
