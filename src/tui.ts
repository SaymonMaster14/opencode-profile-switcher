import { jsx } from "@opentui/solid/jsx-runtime"
import { createSignal } from "solid-js"
import type { TuiDialogSelectOption, TuiPlugin, TuiPluginApi, TuiPluginMeta, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { pluginConfigMatches, pluginReferences, readGlobalConfig, setGlobalServerPlugins, disposeAllInstances, disposeCurrentInstance } from "./adapters/opencode11832.ts"
import { reconcileTuiPlugins } from "./adapters/tui11832.ts"
import { planProfileSwitch } from "./core/diff.ts"
import { discoverGitHubPlugin } from "./core/github.ts"
import { profileIsolationReport } from "./core/isolation.ts"
import { uniquePlugins } from "./core/json.ts"
import { buildProfilePickerOptions, pluginMetadataDescription, type ProfilePickerValue } from "./core/picker.ts"
import { baseProfile, createProfile, resolveEffectiveProfile } from "./core/profiles.ts"
import {
  cleanupAbandonedTemporaries,
  clearRuntimeLease,
  createStoredProfile,
  ensureStore,
  profileStoreRoot,
  readStore,
  removeStoredProfile,
  setActiveProfile,
  setPendingProfile,
  updateStoredProfile,
  updateStoreIndex,
  writeRuntimeLease,
} from "./core/store.ts"
import { MANAGER_PLUGIN_ID, type EffectiveProfile, type PluginReference, type ProfileDefinition } from "./core/types.ts"
import { normalizeProfileId, parseProfile } from "./core/validation.ts"

type Choice = ProfilePickerValue
const originalProjectConfigFlag = process.env.OPENCODE_DISABLE_PROJECT_CONFIG
const requestedRunId = process.env.OPENCODE_PROFILE_RUN_ID
const launchRunId = requestedRunId && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requestedRunId) ? requestedRunId : crypto.randomUUID()
process.env.OPENCODE_PROFILE_RUN_ID = launchRunId

function toast(api: TuiPluginApi, message: string, variant: "info" | "success" | "warning" | "error" = "info") {
  api.ui.toast({ message, variant, duration: 5000 })
}

function resultData<T>(result: { data?: T; error?: unknown }, name: string): T {
  if (result.error) throw new Error(`${name}: ${String(result.error)}`)
  if (result.data === undefined) throw new Error(`${name}: OpenCode returned no data`)
  return result.data
}

function normalizeConfigObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object")
  if ("plugin" in value) throw new Error("Use the profile's Plugins action; config.plugin is managed separately")
  return value as Record<string, unknown>
}

function currentProfileId(index: Awaited<ReturnType<typeof readStore>>["index"]): string {
  if (process.env.OPENCODE_PROFILE_LAUNCH === "1" && process.env.OPENCODE_PROFILE_ID) return process.env.OPENCODE_PROFILE_ID
  return index.activeProfileId
}

function statusReferences(api: TuiPluginApi): PluginReference[] {
  return api.plugins.list().filter((plugin) => plugin.active).map((plugin) => ({ spec: plugin.spec, id: plugin.id }))
}

function runtimeHasTuiPlugin(api: TuiPluginApi, reference: PluginReference): boolean {
  return api.plugins.list().some((plugin) => plugin.spec === reference.spec || (reference.id && plugin.id === reference.id))
}

function profileMap(snapshot: Awaited<ReturnType<typeof readStore>>) {
  return new Map(snapshot.profiles.map((profile) => [profile.id, profile]))
}

function effective(snapshot: Awaited<ReturnType<typeof readStore>>, id: string): EffectiveProfile {
  return resolveEffectiveProfile(id, profileMap(snapshot), snapshot.index)
}

function currentEffective(snapshot: Awaited<ReturnType<typeof readStore>>): EffectiveProfile {
  const selected = currentProfileId(snapshot.index)
  if (selected === "base") return baseProfile(snapshot.index)
  return effective(snapshot, selected)
}

function capabilities(api: TuiPluginApi) {
  const version = api.app.version
  const [major, minor, patch] = version.split(/[.-]/).slice(0, 3).map((item) => Number.parseInt(item, 10))
  const stable118 = major === 1 && (minor > 18 || (minor === 18 && (patch || 0) >= 32))
  return {
    version,
    supportsTuiPluginToggle: stable118 && typeof api.plugins.activate === "function" && typeof api.plugins.deactivate === "function",
    supportsInstanceDispose: stable118 && typeof api.client.instance.dispose === "function",
    supportsGlobalConfigUpdate: stable118 && typeof api.client.global.config.update === "function",
    supportsProjectConfigToggle: stable118,
    supportsIsolatedLaunch: true,
    supportsDesktopExtension: false as const,
  }
}

async function readServerPlugins(api: TuiPluginApi): Promise<PluginReference[]> {
  return pluginReferences((await readGlobalConfig(api.client)).plugin)
}

function serverPluginMissing(profile: EffectiveProfile, snapshot: Awaited<ReturnType<typeof readStore>>, current: PluginReference[]) {
  const installed = [
    ...snapshot.index.baseServerPlugins,
    ...current,
    ...snapshot.profiles.flatMap((item) => item.plugins.server.filter((reference) => reference.installedAt)),
  ]
  return profile.plugins.server
    .filter((plugin) => plugin.id !== MANAGER_PLUGIN_ID && !installed.some((item) => item.spec === plugin.spec))
    .map((plugin) => plugin.spec)
}

function expectedSummary(profile: EffectiveProfile, api: TuiPluginApi, isolation: ReturnType<typeof profileIsolationReport>, restart?: string) {
  const plugins = [...profile.plugins.server, ...profile.plugins.tui]
    .filter((item) => item.id !== MANAGER_PLUGIN_ID)
    .map((item) => item.name ?? item.id ?? item.spec)
  const skillConfig = profile.config.skills && typeof profile.config.skills === "object" && !Array.isArray(profile.config.skills)
    ? profile.config.skills as Record<string, unknown>
    : {}
  const skills = [skillConfig.paths, skillConfig.urls].reduce<number>((count, value) => count + (Array.isArray(value) ? value.length : 0), 0)
  const mcpConfig = profile.config.mcp && typeof profile.config.mcp === "object" && !Array.isArray(profile.config.mcp)
    ? profile.config.mcp as Record<string, unknown>
    : {}
  const mcpCount = Object.keys(mcpConfig).length
  const inherited = [
    profile.inheritance.globalSkills ? "global skills" : "no inherited global skills",
    profile.inheritance.mcp ? `${api.state.mcp().length} visible MCPs` : `${mcpCount} profile MCPs`,
  ].join(" · ")
  const pluginSummary = plugins.length ? `${plugins.slice(0, 3).join(", ")}${plugins.length > 3 ? ` +${plugins.length - 3}` : ""}` : "no profile plugins"
  const status = isolation.complete ? "isolation verified by launch mode" : isolation.entries.some((item) => item.state === "launch-required") ? "launch required for full isolation" : "layered"
  return [profile.description || "No description", pluginSummary, `${skills} profile skill sources`, inherited, status, restart ?? "switch: live"].join(" · ")
}

function environmentSnapshot() {
  return {
    disableProjectConfig: process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
    profileId: process.env.OPENCODE_PROFILE_ID,
    storeDir: process.env.OPENCODE_PROFILE_STORE_DIR,
    launch: process.env.OPENCODE_PROFILE_LAUNCH,
  }
}

function applyProfileEnvironment(root: string, profile: EffectiveProfile) {
  process.env.OPENCODE_PROFILE_STORE_DIR = root
  if (profile.id === "base") {
    if (originalProjectConfigFlag === undefined) delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
    else process.env.OPENCODE_DISABLE_PROJECT_CONFIG = originalProjectConfigFlag
    delete process.env.OPENCODE_PROFILE_ID
    delete process.env.OPENCODE_PROFILE_LAUNCH
    return
  }
  const projectConfigFlag = profile.inheritance.projectConfig ? originalProjectConfigFlag : "true"
  if (projectConfigFlag === undefined) delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
  else process.env.OPENCODE_DISABLE_PROJECT_CONFIG = projectConfigFlag
  process.env.OPENCODE_PROFILE_ID = profile.id
  delete process.env.OPENCODE_PROFILE_LAUNCH
}

function restoreEnvironment(snapshot: ReturnType<typeof environmentSnapshot>) {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  restore("OPENCODE_DISABLE_PROJECT_CONFIG", snapshot.disableProjectConfig)
  restore("OPENCODE_PROFILE_ID", snapshot.profileId)
  restore("OPENCODE_PROFILE_STORE_DIR", snapshot.storeDir)
  restore("OPENCODE_PROFILE_LAUNCH", snapshot.launch)
}

function missingTuiPlugins(api: TuiPluginApi, profile: EffectiveProfile) {
  return profile.plugins.tui
    .filter((plugin) => plugin.id !== MANAGER_PLUGIN_ID && !runtimeHasTuiPlugin(api, plugin) && !plugin.installedAt)
    .map((plugin) => plugin.spec)
}

async function ensureTuiPlugins(api: TuiPluginApi, profile: EffectiveProfile): Promise<void> {
  for (const reference of profile.plugins.tui) {
    if (reference.id === MANAGER_PLUGIN_ID || runtimeHasTuiPlugin(api, reference)) continue
    if (!reference.installedAt) throw new Error(`TUI plugin is discovered but not installed: ${reference.spec}`)
    if (!(await api.plugins.add(reference.spec))) throw new Error(`OpenCode could not activate installed TUI plugin ${reference.spec}`)
  }
}

const tui: TuiPlugin = async (api, _options, meta: TuiPluginMeta) => {
  const root = profileStoreRoot(api.state.path.config)
  const managerSpec = meta.spec || "opencode-profile-switcher"
  let globalPlugins: PluginReference[] = []
  try {
    globalPlugins = await readServerPlugins(api)
  } catch (error) {
    toast(api, `Could not read global plugin config: ${(error as Error).message}`, "warning")
  }
  const initialTuiPlugins = statusReferences(api)
  let snapshot = await ensureStore(root, {
    managerSpec,
    baseServerPlugins: globalPlugins,
    baseTuiPlugins: initialTuiPlugins,
  })
  const beforeTemporaryCleanup = snapshot
  const abandoned = await cleanupAbandonedTemporaries(root, launchRunId)
  if (abandoned.length) {
    snapshot = await readStore(root)
    const abandonedActive = abandoned.includes(beforeTemporaryCleanup.index.activeProfileId)
    if (abandonedActive && process.env.OPENCODE_PROFILE_LAUNCH !== "1") {
      try {
        const priorActive = beforeTemporaryCleanup.index.activeProfileId === "base"
          ? baseProfile(beforeTemporaryCleanup.index, managerSpec)
          : resolveEffectiveProfile(beforeTemporaryCleanup.index.activeProfileId, profileMap(beforeTemporaryCleanup), beforeTemporaryCleanup.index)
        const actual = await readServerPlugins(api)
        const knownApplied = [
          beforeTemporaryCleanup.index.lastAppliedServerPlugins,
          priorActive.plugins.server,
          beforeTemporaryCleanup.index.baseServerPlugins,
        ].filter((items): items is PluginReference[] => items !== null)
        if (knownApplied.some((items) => pluginConfigMatches(actual, items))) {
          const restoredId = snapshot.index.activeProfileId
          const restored = restoredId === "base" ? baseProfile(snapshot.index, managerSpec) : resolveEffectiveProfile(restoredId, profileMap(snapshot), snapshot.index)
          if (!pluginConfigMatches(actual, restored.plugins.server)) {
            await setGlobalServerPlugins(api.client, restored.plugins.server)
            await disposeAllInstances(api.client)
          }
          await updateStoreIndex(root, (index) => ({ ...index, lastAppliedServerPlugins: restored.plugins.server }))
          snapshot = await readStore(root)
        } else {
          toast(api, "Removed an abandoned temporary profile. Global server plugin edits were preserved; return to Base to rebase them before switching.", "warning")
        }
      } catch (error) {
        toast(api, `Removed an abandoned temporary profile, but could not restore its server plugin list: ${(error as Error).message}`, "warning")
      }
    }
    toast(api, `Removed ${abandoned.length} temporary profile${abandoned.length === 1 ? "" : "s"} left by a closed session`, "info")
  }
  const [activeLabel, setActiveLabel] = createSignal("OpenCode profile: Base")
  const caps = capabilities(api)
  let leaseTimer: ReturnType<typeof setInterval> | undefined

  const updateLease = async () => {
    const current = await readStore(root)
    const id = currentProfileId(current.index)
    const temporaryProfileId = current.profiles.find((profile) => profile.id === id)?.temporary ? id : null
    await writeRuntimeLease(root, { runId: launchRunId, pid: process.pid, updatedAt: Date.now(), temporaryProfileId })
  }

  const loadSnapshot = async () => {
    snapshot = await readStore(root)
    return snapshot
  }

  const updateIndicator = async () => {
    const current = await loadSnapshot()
    const id = currentProfileId(current.index)
    const name = id === "base" ? "Base" : current.profiles.find((profile) => profile.id === id)?.name ?? id
    const suffix = process.env.OPENCODE_PROFILE_LAUNCH === "1" ? " · isolated launch" : ""
    setActiveLabel(`Profile · ${name}${suffix}`)
    await updateLease()
  }

  const resolveView = async () => {
    const current = await loadSnapshot()
    const profiles = [baseProfile(current.index, managerSpec), ...current.profiles.map((item) => resolveEffectiveProfile(item.id, profileMap(current), current.index))]
    const activeId = currentProfileId(current.index)
    const active = activeId === "base" ? baseProfile(current.index, managerSpec) : resolveEffectiveProfile(activeId, profileMap(current), current.index)
    const globalServerSpecs = new Set(pluginReferences((await readGlobalConfig(api.client)).plugin).map((item) => item.spec))
    const installedRefs = [
      ...current.index.baseServerPlugins,
      ...current.index.baseTuiPlugins,
      ...current.profiles.flatMap((item) => [...item.plugins.server, ...item.plugins.tui]).filter((item) => item.installedAt),
    ]
    const options = buildProfilePickerOptions({
      profiles,
      activeId,
      hasPrevious: Boolean(current.index.previousProfileId),
      pluginState: (kind, spec) => {
        if (kind === "server") return globalServerSpecs.has(spec) ? "configured" : installedRefs.some((item) => item.spec === spec) ? "installed" : "discovered"
        const status = api.plugins.list().find((item) => item.spec === spec)
        return status?.active ? "active" : status ? "installed" : installedRefs.some((item) => item.spec === spec) ? "installed" : "discovered"
      },
      isolation: (profile) => profileIsolationReport(profile, process.env.OPENCODE_PROFILE_LAUNCH === "1" && process.env.OPENCODE_PROFILE_ID === profile.id),
      restart: (profile) => {
        const plan = planProfileSwitch({
          from: active,
          to: profile,
          capabilities: caps,
          activeProfileIsIsolated: process.env.OPENCODE_PROFILE_LAUNCH === "1",
        })
        return plan.required === "NONE" ? undefined : plan.changes.find((change) => change.kind === plan.required)
      },
    })
    return { current, profiles, active, options }
  }

  const showPicker = async () => {
    try {
      const view = await resolveView()
      api.ui.dialog.replace(() => api.ui.DialogSelect<Choice>({
        title: "OpenCode profiles",
        placeholder: "Search profiles and actions",
        options: view.options as TuiDialogSelectOption<Choice>[],
        onSelect: (option) => {
          api.ui.dialog.clear()
          void handleChoice(option.value).catch((error) => toast(api, (error as Error).message, "error"))
        },
      }))
    } catch (error) {
      toast(api, `Could not load profiles: ${(error as Error).message}`, "error")
    }
  }

  const ask = (title: string, value: string, onConfirm: (value: string) => void) => {
    api.ui.dialog.replace(() => api.ui.DialogPrompt({
      title,
      value,
      placeholder: "Type a value",
      onConfirm: (next) => {
        api.ui.dialog.clear()
        onConfirm(next)
      },
      onCancel: () => api.ui.dialog.clear(),
    }))
  }

  const confirm = (title: string, message: string, onConfirm: () => void) => {
    api.ui.dialog.replace(() => api.ui.DialogConfirm({
      title,
      message,
      onConfirm: () => {
        api.ui.dialog.clear()
        onConfirm()
      },
      onCancel: () => api.ui.dialog.clear(),
    }))
  }

  const selectProfile = (title: string, onSelect: (id: string) => void, includeBase = true) => {
    void resolveView().then((view) => {
      const rows = view.profiles.filter((profile) => includeBase || profile.id !== "base").map((profile) => ({
        title: profile.name,
        value: profile.id,
        description: profile.description || profile.id,
      }))
      api.ui.dialog.replace(() => api.ui.DialogSelect<string>({
        title,
        options: rows,
        onSelect: (option) => {
          api.ui.dialog.clear()
          onSelect(option.value)
        },
        onFilter: () => undefined,
      }))
    }).catch((error) => toast(api, (error as Error).message, "error"))
  }

  const inspectPluginMetadata = () => selectProfile("Choose profile whose plugins to inspect", (id) => {
    void (async () => {
      const current = await readStore(root)
      const profile = id === "base" ? baseProfile(current.index, managerSpec) : resolveEffectiveProfile(id, profileMap(current), current.index)
      const serverSpecs = new Set(pluginReferences((await readGlobalConfig(api.client)).plugin).map((item) => item.spec))
      const rows = ( ["server", "tui"] as const).flatMap((kind) => profile.plugins[kind]
        .filter((reference) => reference.id !== MANAGER_PLUGIN_ID && reference.spec !== managerSpec)
        .map((reference) => {
          const status = kind === "tui"
            ? api.plugins.list().find((item) => item.spec === reference.spec || (reference.id && item.id === reference.id))
            : undefined
          const active = kind === "tui" ? Boolean(status?.active) : serverSpecs.has(reference.spec)
          const installed = Boolean(reference.installedAt || status || serverSpecs.has(reference.spec))
          const title = `${reference.name ?? reference.id ?? reference.spec} (${kind})`
          return {
            title,
            value: {
              title,
              message: pluginMetadataDescription({ plugin: reference, kind, installed, active }),
            },
          }
        }))
      if (!rows.length) {
        api.ui.dialog.replace(() => api.ui.DialogAlert({ title: `Plugins · ${profile.name}`, message: "This profile has no user plugin references." }))
        return
      }
      api.ui.dialog.setSize("large")
      api.ui.dialog.replace(() => api.ui.DialogSelect({
        title: `Plugins · ${profile.name}`,
        placeholder: "Select a plugin to inspect its metadata",
        options: rows.map((row) => ({ title: row.title, value: row.value, description: row.value.message })),
        onSelect: (option) => {
          api.ui.dialog.replace(() => api.ui.DialogAlert({ title: option.value.title, message: option.value.message }))
        },
      }))
    })().catch((error) => toast(api, `Could not inspect plugin metadata: ${(error as Error).message}`, "error"))
  })

  const applySwitch = async (targetId: string, forceReload = false): Promise<boolean> => {
    const before = await loadSnapshot()
    const fromId = currentProfileId(before.index)
    const from = fromId === "base" ? baseProfile(before.index, managerSpec) : resolveEffectiveProfile(fromId, profileMap(before), before.index)
    const target = targetId === "base" ? baseProfile(before.index, managerSpec) : resolveEffectiveProfile(targetId, profileMap(before), before.index)
    const globalConfig = await readGlobalConfig(api.client)
    const oldServer = pluginReferences(globalConfig.plugin)
    const expectedServer = before.index.lastAppliedServerPlugins ?? (before.index.activeProfileId === "base" ? before.index.baseServerPlugins : null)
    if (expectedServer && !pluginConfigMatches(oldServer, expectedServer)) {
      throw new Error("Global server plugins changed outside the profile manager; return to Base to rebase without overwriting the edit")
    }
    const serverChanged = !pluginConfigMatches(oldServer, target.plugins.server)
    const plan = planProfileSwitch({
      from,
      to: target,
      capabilities: caps,
      activeProfileIsIsolated: process.env.OPENCODE_PROFILE_LAUNCH === "1",
    })
    if (forceReload && plan.required === "NONE") plan.required = "INSTANCE_RELOAD"

    if (target.isolationMode === "isolated-launch" && !(process.env.OPENCODE_PROFILE_LAUNCH === "1" && process.env.OPENCODE_PROFILE_ID === target.id)) {
      await setPendingProfile(root, targetId)
      toast(api, `Full isolation requires a new process. After exiting OpenCode, run: opencode-profile launch ${targetId}`, "warning")
      return false
    }

    const missing = [...missingTuiPlugins(api, target), ...serverPluginMissing(target, before, oldServer)]
    if (missing.length) {
      toast(api, `Install these profile plugins first: ${missing.join(", ")}`, "warning")
      return false
    }

    const envBefore = environmentSnapshot()
    const oldIndex = before.index
    let tuiRollback: (() => Promise<void>) | undefined
    let globalConfigChanged = false
    let activeStateChanged = false
    try {
      await ensureTuiPlugins(api, target)
      await setActiveProfile(root, targetId)
      activeStateChanged = true
      applyProfileEnvironment(root, target)
      if (serverChanged) {
        globalConfigChanged = true
        await setGlobalServerPlugins(api.client, target.plugins.server)
      }
      const reconciled = await reconcileTuiPlugins({
        control: api.plugins,
        desired: target.plugins.tui,
        managerId: MANAGER_PLUGIN_ID,
        managerSpec,
      })
      if (reconciled.missing.length) throw new Error(`TUI plugin is not installed: ${reconciled.missing.join(", ")}`)
      tuiRollback = reconciled.rollback

      if (serverChanged) await disposeAllInstances(api.client)
      else if (plan.changes.some((change) => change.kind === "INSTANCE_RELOAD") || forceReload) await disposeCurrentInstance(api.client)

      await updateStoreIndex(root, (index) => ({ ...index, lastAppliedServerPlugins: target.plugins.server }))
      if (from.temporary && from.id !== target.id) await removeStoredProfile(root, from.id)
      await updateIndicator()
      const turnedOff = reconciled.deactivated.length
      const reloadText = serverChanged ? "server instances reloaded" : plan.required === "INSTANCE_RELOAD" || forceReload ? "instance reloaded" : "live switch"
      toast(api, `${target.name} active · ${turnedOff} TUI plugins turned off · ${reloadText}`, "success")
      return true
    } catch (error) {
      await tuiRollback?.().catch(() => undefined)
      restoreEnvironment(envBefore)
      if (globalConfigChanged) {
        await setGlobalServerPlugins(api.client, oldServer).catch(() => undefined)
        await disposeAllInstances(api.client).catch(() => undefined)
      }
      if (activeStateChanged) {
        await updateStoreIndex(root, (index) => ({
          ...index,
          activeProfileId: oldIndex.activeProfileId,
          previousProfileId: oldIndex.previousProfileId,
          pendingProfileId: oldIndex.pendingProfileId,
        })).catch(() => undefined)
      }
      await updateIndicator().catch(() => undefined)
      toast(api, `Profile switch rolled back: ${(error as Error).message}`, "error")
      return false
    }
  }

  const switchTo = async (id: string, forceReload = false, afterSwitch?: () => Promise<void>) => {
    let view = await resolveView()
    const currentGlobal = await readGlobalConfig(api.client)
    const currentServer = pluginReferences(currentGlobal.plugin)
    const expectedServer = view.current.index.lastAppliedServerPlugins ?? (view.current.index.activeProfileId === "base" ? view.current.index.baseServerPlugins : null)
    if (expectedServer && !pluginConfigMatches(currentServer, expectedServer)) {
      if (id !== "base") {
        const actualSpecs = currentServer.map((item) => item.spec).join(", ") || "(empty)"
        const expectedSpecs = expectedServer.map((item) => item.spec).join(", ") || "(empty)"
        toast(api, `Global server plugins changed outside the profile manager (current: ${actualSpecs}; expected: ${expectedSpecs}). Return to Base to rebase the current list before another switch.`, "warning")
        return
      }
      await updateStoreIndex(root, (index) => ({ ...index, baseServerPlugins: currentServer, lastAppliedServerPlugins: null }))
      view = await resolveView()
    }
    const profile = id === "base" ? baseProfile(view.current.index, managerSpec) : resolveEffectiveProfile(id, profileMap(view.current), view.current.index)
    const fromId = currentProfileId(view.current.index)
    const from = fromId === "base" ? baseProfile(view.current.index, managerSpec) : resolveEffectiveProfile(fromId, profileMap(view.current), view.current.index)
    const plan = planProfileSwitch({
      from,
      to: profile,
      capabilities: caps,
      activeProfileIsIsolated: process.env.OPENCODE_PROFILE_LAUNCH === "1",
    })
    const deferredDelete = afterSwitch ? " Deletion is deferred; relaunch, then run Delete profile again." : ""

    if (profile.isolationMode === "isolated-launch" && !(process.env.OPENCODE_PROFILE_LAUNCH === "1" && process.env.OPENCODE_PROFILE_ID === profile.id)) {
      await setPendingProfile(root, id)
      confirm(
        "Process restart required",
        `${profile.name} needs an isolated config and home directory so global plugins, skills, and project settings do not leak. Exit this TUI, then run: opencode-profile launch ${profile.id}${deferredDelete}`,
        () => toast(api, `Run after exiting OpenCode: opencode-profile launch ${profile.id}${deferredDelete}`, "warning"),
      )
      return
    }
    if (plan.required === "PROCESS_RESTART") {
      await setPendingProfile(root, id)
      confirm("Process restart required", `${plan.explanation.join("\n")}\n\nRun after exiting OpenCode: opencode-profile launch ${id}${deferredDelete}`, () => {
        toast(api, `Run after exiting OpenCode: opencode-profile launch ${id}${deferredDelete}`, "warning")
      })
      return
    }
    if (id === fromId && plan.required === "NONE" && !forceReload) {
      toast(api, `${profile.name} is already active`, "info")
      return
    }
    const explain = plan.explanation.length ? plan.explanation.join("\n") : "Profile metadata changed; apply it by reloading the current instance."
    const isGlobal = plan.required === "GLOBAL_RELOAD" || !pluginConfigMatches((await readGlobalConfig(api.client)).plugin, profile.plugins.server)
    if (isGlobal || plan.required === "INSTANCE_RELOAD" || forceReload) {
      confirm(
        isGlobal ? "Reload server instances?" : "Reload current instance?",
        `${explain}\n\n${isGlobal ? "This updates the server plugin list and reloads OpenCode instances. Session history remains on disk; wait until active generations are idle." : "The current server instance will be recreated; session history remains on disk."}`,
        () => {
          void applySwitch(id, forceReload).then(async (applied) => {
            if (applied) await afterSwitch?.()
          }).catch((error) => toast(api, (error as Error).message, "error"))
        },
      )
      return
    }
    if (await applySwitch(id, forceReload)) await afterSwitch?.()
  }

  const createNamed = (temporary = false) => {
    ask(temporary ? "Temporary profile name" : "Profile name", temporary ? "experiment" : "work", (name) => {
      let id: string
      try {
        id = normalizeProfileId(name)
      } catch (error) {
        toast(api, (error as Error).message, "error")
        return
      }
      ask("Profile description", "", (description) => {
        void (async () => {
          const current = await resolveView()
          const source = temporary ? current.active : baseProfile(current.current.index, managerSpec)
          const profile = createProfile({
            id: temporary ? `tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` : id,
            name: temporary ? `${name} (temporary)` : name,
            description,
            extends: temporary && source.id !== "base" ? source.id : "base",
            config: temporary ? source.config : {},
            plugins: temporary ? source.plugins : { server: [], tui: [] },
            ...(temporary ? { inheritance: source.inheritance, isolationMode: source.isolationMode } : {}),
            ...(temporary ? { temporary: { createdAt: Date.now(), ownerRunId: launchRunId } } : {}),
          })
          await createStoredProfile(root, profile)
          toast(api, `Created profile ${profile.name}`, "success")
          if (temporary) await switchTo(profile.id)
          else await showPicker()
        })().catch((error) => toast(api, (error as Error).message, "error"))
      })
    })
  }

  const duplicate = () => selectProfile("Choose profile to duplicate", (sourceId) => {
    const source = sourceId === "base" ? baseProfile(snapshot.index, managerSpec) : snapshot.profiles.find((item) => item.id === sourceId)
    if (!source) return toast(api, `Unknown profile ${sourceId}`, "error")
    ask("New profile name", `${source.name}-copy`, (name) => {
      try {
        const id = normalizeProfileId(name)
        const profile = createProfile({
          id,
          name,
          description: source.description,
          extends: source.id === "base" ? "base" : (source as ProfileDefinition).extends,
          config: source.config,
          plugins: source.plugins,
          inheritance: source.inheritance,
          isolationMode: source.isolationMode,
          environment: "environment" in source ? source.environment : {},
        })
        void createStoredProfile(root, profile).then(() => showPicker()).catch((error) => toast(api, (error as Error).message, "error"))
      } catch (error) {
        toast(api, (error as Error).message, "error")
      }
    })
  })

  const editProfile = () => selectProfile("Choose profile to edit", (id) => {
    if (id === "base") return toast(api, "The base profile is restored from your original OpenCode config and cannot be edited", "info")
    api.ui.dialog.replace(() => api.ui.DialogSelect<string>({
      title: "Edit profile",
      options: [
        { title: "Name", value: "name", description: "Change the profile label" },
        { title: "Description", value: "description", description: "Change the selector description" },
        { title: "OpenCode config JSON", value: "config", description: "Replace the profile config object" },
        { title: "Plugin sets JSON", value: "plugins", description: "Replace server and TUI plugin references" },
        { title: "Sources and isolation JSON", value: "sources", description: "Choose inherited config, plugins, skills, MCPs, and launch isolation" },
      ],
      onSelect: (option) => {
        api.ui.dialog.clear()
        void (async () => {
          const current = await readStore(root)
          const profile = current.profiles.find((item) => item.id === id)
          if (!profile) throw new Error(`Unknown profile ${id}`)
          if (option.value === "name" || option.value === "description") {
            ask(option.value === "name" ? "Profile name" : "Profile description", option.value === "name" ? profile.name : profile.description, (value) => {
              const next = { ...profile, [option.value]: value, updatedAt: Date.now() }
              void updateStoredProfile(root, next).then(() => switchTo(id, id === currentProfileId(current.index))).catch((error: unknown) => toast(api, (error as Error).message, "error"))
            })
            return
          }
          const value = option.value === "config"
            ? profile.config
            : option.value === "plugins"
              ? profile.plugins
              : { inheritance: profile.inheritance, isolationMode: profile.isolationMode }
          const title = option.value === "config" ? "Profile config JSON" : option.value === "plugins" ? "Profile plugin sets JSON" : "Profile sources and isolation JSON"
          ask(title, JSON.stringify(value), (text) => {
            try {
              const parsed: unknown = JSON.parse(text)
              const next = option.value === "config"
                ? { ...profile, config: normalizeConfigObject(text), updatedAt: Date.now() }
                : option.value === "plugins"
                  ? { ...profile, plugins: parsed as ProfileDefinition["plugins"], updatedAt: Date.now() }
                  : typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
                    ? {
                        ...profile,
                        ...(Object.hasOwn(parsed, "inheritance") ? { inheritance: (parsed as Record<string, unknown>).inheritance as ProfileDefinition["inheritance"] } : {}),
                        ...(Object.hasOwn(parsed, "isolationMode") ? { isolationMode: (parsed as Record<string, unknown>).isolationMode as ProfileDefinition["isolationMode"] } : {}),
                        updatedAt: Date.now(),
                      }
                    : (() => { throw new Error("Expected an object") })()
              const validated = parseProfile(next)
              void updateStoredProfile(root, validated).then(() => switchTo(id, id === currentProfileId(current.index))).catch((error: unknown) => toast(api, (error as Error).message, "error"))
            } catch (error) {
              toast(api, `Profile JSON was not saved: ${(error as Error).message}`, "error")
            }
          })
        })().catch((error) => toast(api, (error as Error).message, "error"))
      },
    }))
  })

  const deleteProfile = () => selectProfile("Choose profile to delete", (id) => {
    if (id === "base" || id === "raw") return toast(api, "Built-in profiles cannot be deleted", "warning")
    confirm("Delete profile?", `Delete ${id} and its configuration files? Shared package caches and OpenCode sessions are kept.`, () => {
      void (async () => {
        const remove = async () => {
          if (currentProfileId((await readStore(root)).index) === id) throw new Error("Profile is still active; it was not deleted")
          await removeStoredProfile(root, id)
          await updateIndicator()
          toast(api, `Deleted profile ${id}`, "success")
          await showPicker()
        }
        if (currentProfileId((await readStore(root)).index) === id) {
          await switchTo("base", false, remove)
          return
        }
        await remove()
      })().catch((error) => toast(api, (error as Error).message, "error"))
    })
  }, false)

  const addGitHubPlugin = () => selectProfile("Choose profile for this plugin", (profileId) => {
    if (profileId === "base") return toast(api, "Choose a saved profile; the base profile is not managed by the profile manager", "warning")
    ask("GitHub plugin source", "owner/repository#branch-or-tag", (source) => {
      void (async () => {
        const discovered = await discoverGitHubPlugin(source)
        const info = discovered.reference
        const details = [
          `${info.name} by ${info.author}`,
          info.description || discovered.readmeSummary || "No description in package metadata or README.",
          `Repository: ${info.repository}`,
          `Pinned commit: ${discovered.commit}`,
          `Exports: ${[discovered.hasServer ? "server" : "", discovered.hasTui ? "TUI" : ""].filter(Boolean).join(" + ") || "not an OpenCode plugin"}`,
          "Installation loads trusted plugin code. Review the source before approving.",
        ].join("\n\n")
        if (!discovered.hasServer && !discovered.hasTui) throw new Error("This package does not declare a server or TUI plugin entrypoint")
        confirm("Install this pinned GitHub plugin?", details, () => {
          void (async () => {
            const install = await api.plugins.install(info.spec, { global: true })
            if (!install.ok) throw new Error(install.message)
            if (discovered.hasTui && !install.tui) throw new Error("GitHub metadata declared a TUI entrypoint, but OpenCode 1.18.32 did not register one")
            const current = await readStore(root)
            const activeIdBeforeInstall = currentProfileId(current.index)
            const targetIsActive = activeIdBeforeInstall === profileId
            let tui = api.plugins.list().find((item) => item.spec === info.spec || item.spec.includes(discovered.packageName))
            if (discovered.hasTui && !tui) {
              if (!(await api.plugins.add(info.spec))) throw new Error(`OpenCode installed ${info.spec}, but could not load its TUI entrypoint`)
              tui = api.plugins.list().find((item) => item.spec === info.spec || item.spec.includes(discovered.packageName))
            }
            if (discovered.hasTui && !targetIsActive && tui?.active) await api.plugins.deactivate(tui.id)
            const installedAt = Date.now()
            const installedServer = { ...discovered.serverReference, installedAt }
            const installedTui = { ...discovered.tuiReference, installedAt, ...(tui ? { id: tui.id } : {}) }
            const existing = current.profiles.find((item) => item.id === profileId)
            if (!existing) throw new Error(`Profile ${profileId} disappeared during install`)
            const updated: ProfileDefinition = {
              ...existing,
              plugins: {
                server: discovered.hasServer ? uniquePlugins([...existing.plugins.server, installedServer]) : existing.plugins.server,
                tui: discovered.hasTui ? uniquePlugins([...existing.plugins.tui, installedTui]) : existing.plugins.tui,
              },
              updatedAt: Date.now(),
            }
            await updateStoredProfile(root, parseProfile(updated))
            const latest = await readStore(root)
            const activeId = currentProfileId(latest.index)
            const active = activeId === "base" ? baseProfile(latest.index, managerSpec) : resolveEffectiveProfile(activeId, profileMap(latest), latest.index)
            const wasInActive = activeId === profileId
            const serverResult = await readGlobalConfig(api.client)
            const previous = pluginReferences(serverResult.plugin)
            if (!wasInActive) {
              await setGlobalServerPlugins(api.client, active.plugins.server)
              const toggled = await reconcileTuiPlugins({ control: api.plugins, desired: active.plugins.tui, managerId: MANAGER_PLUGIN_ID, managerSpec })
              if (toggled.missing.length) throw new Error(`Installed package did not register a TUI entry: ${toggled.missing.join(", ")}`)
              if (!pluginConfigMatches(previous, active.plugins.server)) await disposeAllInstances(api.client)
            } else {
              if (discovered.hasTui && tui && !tui.active) await api.plugins.add(info.spec)
              await setGlobalServerPlugins(api.client, active.plugins.server)
              if (discovered.hasServer) await disposeAllInstances(api.client)
            }
            await updateStoreIndex(root, (index) => ({ ...index, lastAppliedServerPlugins: active.plugins.server }))
            await updateIndicator()
            toast(api, `${info.name} installed and pinned to ${discovered.commit.slice(0, 12)}`, "success")
            await showPicker()
          })().catch((error) => toast(api, `Plugin installation failed: ${(error as Error).message}`, "error"))
        })
      })().catch((error) => toast(api, `GitHub discovery failed: ${(error as Error).message}`, "error"))
    })
  }, false)

  const handleChoice = async (choice: Choice) => {
    if (choice.kind === "profile") return switchTo(choice.id)
    switch (choice.id) {
      case "create": return createNamed(false)
      case "temporary": return createNamed(true)
      case "duplicate": return duplicate()
      case "edit": return editProfile()
      case "delete": return deleteProfile()
      case "plugins": return inspectPluginMetadata()
      case "github": return addGitHubPlugin()
      case "base": return switchTo("base")
      case "previous": {
        const current = await readStore(root)
        return current.index.previousProfileId ? switchTo(current.index.previousProfileId) : toast(api, "There is no previous profile", "info")
      }
    }
  }

  await updateIndicator()
  api.keymap.registerLayer({
    commands: [{
      name: "profile.switcher.open",
      namespace: "palette",
      title: "OpenCode profile manager",
      desc: "Switch profiles, inspect plugin sets, and manage temporary profiles",
      slashName: "profile",
      run: () => { void showPicker() },
    }],
  })

  api.slots.register({
    slots: {
      app_bottom: () => jsx("text", { children: () => activeLabel() }),
    },
  })
  leaseTimer = setInterval(() => { void updateLease().catch(() => undefined) }, 15_000)
  leaseTimer.unref?.()
  api.lifecycle.onDispose(() => {
    if (leaseTimer) clearInterval(leaseTimer)
    return clearRuntimeLease(root, launchRunId)
  })
}

const plugin: TuiPluginModule = { id: MANAGER_PLUGIN_ID, tui }
export default plugin
export { tui }
