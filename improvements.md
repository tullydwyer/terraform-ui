# Improvements

Findings from the repository review, organized as a practical backlog.

## Quality Gates

- [x] Fix the current lint failure. `npm run lint` previously reported 8 errors and 208 warnings, mostly in `renderer/renderer.js`.
- [x] Remove the duplicate `escapeHtml` declaration in `renderer/renderer.js`.
- [x] Replace unsafe direct `hasOwnProperty` usage with `Object.prototype.hasOwnProperty.call(...)`.
- [x] Clean up regex lint errors and unused variables so lint can become a reliable CI gate.
- [x] Add a test script and run it alongside lint before packaging.

## Security

- [ ] Remove remote runtime scripts and styles from `renderer/index.html`.
- [ ] Vendor Cytoscape, ELK, Highlight.js, and fonts locally through npm or checked-in static assets.
- [ ] Add a strict Content Security Policy for the Electron renderer.
- [ ] Validate `openExternal` URLs before passing them to `shell.openExternal`.
- [ ] Validate IPC inputs in the main process, including workspace paths, tfvars paths, Terraform addresses, workspace names, and import IDs.
- [ ] Ensure selected tfvars files are inside the active workspace before passing them to Terraform.
- [ ] Review persisted command logs for sensitive data exposure and add retention/redaction controls.

## Terraform Safety

- [ ] Rework `apply` so it does not blindly run with `-auto-approve`.
- [ ] Link apply operations to a reviewed plan, ideally by applying a generated plan file.
- [ ] Add a stronger confirmation flow for destructive or state-changing actions.
- [ ] Remove dead `destroy` IPC/preload paths if the UI intentionally no longer supports destroy.
- [ ] If destroy support returns, require explicit typed confirmation and clear workspace/tfvars review.
- [ ] Add Cancel/Stop support for long-running Terraform commands.
- [ ] Show queued/running command state instead of only a global spinner/toast.
- [ ] Warn before closing the app while Terraform is still running.

## Architecture

- [ ] Split the large `renderer/renderer.js` file into focused modules.
- [ ] Extract log rendering/search/ANSI parsing into a logs module.
- [ ] Extract resource tree rendering and address display helpers.
- [ ] Extract graph JSON parsing and edge construction into pure helper functions.
- [ ] Extract Terraform button workflows from DOM wiring.
- [ ] Keep pure Terraform parsing helpers testable outside Electron.
- [ ] Replace scattered `alert`/`confirm` calls with consistent app modal flows.

## Testing

- [ ] Add unit tests for `extractAddressesFromTfstateJson`.
- [ ] Add unit tests for `parseWorkspaceList`.
- [ ] Add unit tests for address normalization and module-prefix helpers.
- [ ] Add unit tests for tfvars discovery and selection filtering.
- [ ] Add unit tests for ANSI-to-HTML escaping.
- [ ] Add graph construction tests using small Terraform JSON fixtures.
- [ ] Add an Electron smoke test that opens the sample workspace and verifies resources, logs, and graph rendering.

## Dependencies And Packaging

- [x] Upgrade Electron from the current 30.x line after testing breaking changes.
- [x] Upgrade `electron-builder`.
- [x] Run `npm audit` after dependency upgrades and document any accepted residual risk.
- [x] Add app icon/build resources or remove stale `buildResources` config if unused.
- [x] Consider code signing and update strategy before distributing installers.
- [x] Review whether `example_terraform/**/*` should be included in production packages.

## Documentation

- [ ] Update README feature list to match the current UI.
- [ ] Remove or clarify the README mention of one-click destroy.
- [ ] Update the roadmap because the graph view is already implemented.
- [ ] Document where command history/logs are stored.
- [ ] Document security assumptions and Terraform CLI requirements more explicitly.
- [ ] Fix the likely typo `example_terraform/_varaibles.tf`.
