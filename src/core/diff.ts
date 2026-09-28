import { sameJson, pluginBindings } from "./json.ts"
import { requiresIsolatedLaunch } from "./profiles.ts"
import type { EffectiveProfile, ProfileChange, RuntimeCapabilities, SwitchPlan } from "./types.ts"

const PRIORITY: Record<ProfileChange["kind"], number> = {
  LIVE: 1,
  INSTANCE_RELOAD: 2,
  GLOBAL_RELOAD: 3,
  PROCESS_RESTART: 4,
}

function add(changes: ProfileChange[], kind: ProfileChange["kind"], area: string, reason: string): void {
  if (!changes.some((item) => item.kind === kind && item.area === area)) changes.push({ kind, area, reason })
}

export function planProfileSwitch(input: {
  from: EffectiveProfile
  to: EffectiveProfile
  capabilities: RuntimeCapabilities
  activeProfileIsIsolated?: boolean
  activeTurns?: number
}): SwitchPlan {
  const { from, to, capabilities } = input
  const changes: ProfileChange[] = []
  const activeProfileIsIsolated = input.activeProfileIsIsolated === true

  if (!sameJson(pluginBindings(from.plugins.tui), pluginBindings(to.plugins.tui))) {
    if (capabilities.supportsTuiPluginToggle) add(changes, "LIVE", "tui-plugins", "TUI plugins have public activate/deactivate operations.")
    else add(changes, "PROCESS_RESTART", "tui-plugins", "This OpenCode build does not expose live TUI plugin toggling.")
  }

  if (!sameJson(pluginBindings(from.plugins.server), pluginBindings(to.plugins.server))) {
    if (capabilities.supportsGlobalConfigUpdate) {
      add(changes, "GLOBAL_RELOAD", "server-plugins", "The global server plugin list changes through OpenCode's config API and reloads all server instances.")
    } else {
      add(changes, "PROCESS_RESTART", "server-plugins", "Server plugin configuration is startup-bound on this build.")
    }
  }

  if (!sameJson(from.config, to.config)) {
    if (capabilities.supportsInstanceDispose) add(changes, "INSTANCE_RELOAD", "config", "Profile config is re-read when OpenCode instances are disposed and recreated.")
    else add(changes, "PROCESS_RESTART", "config", "Instance disposal is unavailable; profile config is startup-bound.")
  }

  if (from.id !== to.id && changes.length === 0) {
    add(changes, "LIVE", "profile", "The active profile label and persisted selection change without reloading OpenCode.")
  }

  if (
    from.inheritance.projectConfig !== to.inheritance.projectConfig ||
    from.inheritance.projectServerPlugins !== to.inheritance.projectServerPlugins
  ) {
    if (capabilities.supportsProjectConfigToggle && capabilities.supportsInstanceDispose) {
      add(changes, "INSTANCE_RELOAD", "project-config", "The stable project-config flag is re-read during instance bootstrap.")
    } else {
      add(changes, "PROCESS_RESTART", "project-config", "Project config discovery is a process startup setting on this build.")
    }
  }

  if (from.inheritance.projectSkills !== to.inheritance.projectSkills && !to.inheritance.projectSkills && !activeProfileIsIsolated) {
    add(changes, "PROCESS_RESTART", "project-skills", "External .agents/.claude skill flags are read when the OpenCode process starts.")
  }

  if (requiresIsolatedLaunch(to) && (!activeProfileIsIsolated || from.id !== to.id)) {
    add(changes, "PROCESS_RESTART", "config-home", "Full isolation needs a separate config/home root; a runtime overlay cannot hide global discovery sources.")
  } else if (activeProfileIsIsolated && from.id !== to.id) {
    add(changes, "PROCESS_RESTART", "isolated-config-home", "Changing the isolated config home requires launching the target profile process.")
  }

  if (!sameJson(from.environment, to.environment)) {
    add(changes, "PROCESS_RESTART", "environment", "Profile environment variables are fixed when the OpenCode process starts.")
  }

  const required = changes.length === 0
    ? "NONE"
    : changes.reduce((best, item) => PRIORITY[item.kind] > PRIORITY[best] ? item.kind : best, "LIVE" as ProfileChange["kind"])
  const explanation = changes.map((change) => `${change.area}: ${change.reason}`)
  if (required === "NONE") explanation.push("No runtime changes are required.")
  const serverChange = changes.some((change) => change.kind === "GLOBAL_RELOAD" || change.kind === "INSTANCE_RELOAD")
  return {
    from: from.id,
    to: to.id,
    changes,
    required,
    confirmationRequired: serverChange || (input.activeTurns ?? 0) > 0,
    explanation,
  }
}
