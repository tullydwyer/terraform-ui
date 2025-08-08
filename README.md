# terraform-ui
An advanced user UI for Terraform.

## Features
- **Resources explorer**: Browse all resources in the current workspace and inspect details.
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
