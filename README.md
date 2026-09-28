# OpenCode Profile Switcher

An OpenCode plugin for saving work profiles and switching them from the TUI. A profile can carry its own OpenCode config overlay, server and TUI plugin lists, environment variables, inheritance choices, and isolation mode.

## What works on OpenCode 1.18.32

- Type `/profile` in the TUI to choose a profile. The menu shows its description, plugin names and installation state, skills and MCP sources, and whether a reload or separate launch is needed. **Inspect plugin metadata** shows each profile plugin's description, creator, origin, version/ref/commit, repository, installed state, and active/configured state.
- Create, duplicate, edit, and delete profiles. A temporary profile is deleted when you switch away from it; if OpenCode closes while it is active, it is cleaned on the next TUI start.
- Toggle loaded TUI plugins through the public TUI plugin API. A server plugin list change is saved through OpenCode's global config API and reloads server instances. Existing session records remain on disk.
- Inspect a GitHub package's repository metadata, package description, author, README summary, entrypoints, and resolved commit before confirming installation. The saved profile reference is pinned to that commit.
- Launch the built-in **Raw** profile with `opencode-profile launch raw` (or `bun run src/cli.ts launch raw` from this checkout). It uses a separate config and home root, disables project config and external skill discovery, and denies the built-in skill tool. Session data, authentication, and package caches stay shared.

The profile system is a workflow boundary, not a security sandbox for plugin code. An installed plugin runs with the permissions of the OpenCode process. Review its source before confirming installation.

## Install this checkout for development

OpenCode 1.18.32 loads the server and TUI halves from separate config files. After `bun install`, add the checkout directory's absolute `file:///...` URL (the folder containing `package.json`) to the `plugin` array in both your global `opencode.json` and `tui.json`. The package exports the server and `./tui` entrypoints under the same spec, which lets Base restore one consistent plugin identity. Restart OpenCode once to load it; later profile changes use the running TUI.

The helper can also be run from this checkout:

```sh
bun run src/cli.ts list
bun run src/cli.ts launch raw
```

To install from GitHub manually, pass a full commit SHA to OpenCode's global plugin installer. OpenCode 1.18.32 records the package in both the server and TUI plugin configs.

## Install on Windows

With OpenCode installed and available in PowerShell, run this one command:

```powershell
iex (irm https://raw.githubusercontent.com/SaymonMaster14/opencode-profile-switcher/main/install.ps1)
```

The installer resolves the current `main` commit, pins that exact commit, and uses OpenCode's global plugin installer to register both plugin entrypoints for your user account. Restart OpenCode, then type `/profile` in the TUI.

## Create and edit profiles

Use `/profile` and select **Create profile**. The editor lets you change the profile name, description, config JSON, plugin sets JSON, and source policy JSON. The source policy has this shape:

```json
{
  "inheritance": {
    "globalConfig": true,
    "projectConfig": true,
    "globalServerPlugins": true,
    "projectServerPlugins": true,
    "globalTuiPlugins": true,
    "projectTuiPlugins": true,
    "globalSkills": true,
    "projectSkills": true,
    "mcp": true
  },
  "isolationMode": "layered"
}
```

Set an inheritance value to `false` to stop inheriting that source. Excluding global config, global server plugins, or global skills requires a separate process launch because OpenCode 1.18.32 discovers some of those sources before plugin config hooks run. Excluding project skills also requires launching again; the runtime cannot hide project skill discovery independently from project config, so the isolation report marks that tradeoff.

The built-in **Base** profile restores the plugin lists captured when the manager first initializes. If another tool changes the global server plugin list, the manager detects the difference and asks you to return to Base to adopt that list before applying another profile.

## Example profiles

The files in [`examples/profiles`](examples/profiles) are schema-validated reference profiles. Create a profile with `/profile`, then copy the `config`, `plugins`, and `inheritance`/`isolationMode` sections into the corresponding editor actions.

- [`clean-room.json`](examples/profiles/clean-room.json) shows an isolated profile without inherited plugins, skills, project config, or MCPs.
- [`review-workflow.json`](examples/profiles/review-workflow.json) shows inline agent/command config, a profile-owned `skills/` path, and MCP exclusion. Put any profile-specific `SKILL.md` files in that profile's `skills/` directory.

## Compatibility

The implementation and real-server smoke test target **OpenCode stable 1.18.32**. The server and TUI entrypoints use the 1.x plugin contract; the TUI checks the runtime version and required methods before enabling live switching. No OpenCode 2.x-only APIs are required. Other OpenCode releases are not claimed as verified; re-run the smoke test before relying on a different release.

The core profile model and switch planner do not import TUI APIs. The OpenCode 1.18.32 server and process-launch integrations are isolated under `src/server.ts` and `src/adapters/opencode11832Launch.ts`; TUI-specific reconciliation lives in `src/adapters/tui11832.ts`. `SwitchPlan` and `RuntimeCapabilities` are the host-neutral boundary for a future UI adapter. `RuntimeCapabilities.supportsDesktopExtension` reports `false` for this release, so a supported Desktop integration can be added without changing the profile store or switch planner. OCDX is not wired in: it runs through a separate Desktop extension channel and state, not the normal stable Desktop plugin host.

## Isolation limits

The picker reports source-by-source whether a source is inherited, excluded, partial, protected, or requires another launch. The Raw profile removes the normal global and project config roots, project/home plugin discovery, and user skill directories from its process. Its separate home uses `OPENCODE_TEST_HOME`, the home-path override present in the exact 1.18.32 source; this is an internal, test-named hook, so recheck it before targeting another OpenCode release. OpenCode still has a built-in skill registration, which Raw denies through permissions. The profile manager and host-internal TUI plugins remain active; Raw excludes the inherited user plugin set. System-managed settings may still apply. Authenticated remote config may still be fetched because 1.18.32 does not expose a profile-scoped switch for it. Session data, credentials, and package caches are deliberately shared.

Layered profiles do not isolate arbitrary remote config, system-managed config, or direct plugin files discovered from paths that the profile manager cannot toggle at runtime. Do not treat an isolation report as proof against malicious plugins or machine-wide policy.

## Desktop support

OpenCode 1.18.32 exposes no supported plugin API for adding a native Desktop dropdown or registering a Desktop restart action. Its Desktop menu is assembled from a fixed menu definition in the upstream app. This repository therefore provides the native `/profile` picker in the TUI and a process launcher for full isolation; it does not claim a Desktop dropdown. A true in-app Desktop selector needs an upstream extension point or a change to OpenCode itself.

Sources checked at the exact stable tag: [TUI plugin API](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/plugin/src/tui.ts), [server plugin loader](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/plugin/index.ts), [global home-path resolution](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/core/src/global.ts), [Desktop menu definition](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/app/src/desktop-menu.ts), and [Desktop menu actions](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/desktop/src/main/menu.ts).

## Development checks

```sh
bun run typecheck
bun test
bun run smoke:stable
```

The stable smoke test uses temporary config/data roots, exercises a pinned GitHub install through the OpenCode 1.18.32 CLI, starts the real server, updates the global server-plugin list through the SDK and reloads instances, disposes an instance, verifies sessions remain, and checks the Raw launch sources.
