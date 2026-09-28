import { shortPluginName } from "./json.ts"
import type { EffectiveProfile, IsolationReport, PluginKind, PluginReference, ProfileChange, ProfileDefinition } from "./types.ts"

export type ProfilePickerValue =
  | { kind: "profile"; id: string }
  | { kind: "action"; id: "create" | "temporary" | "duplicate" | "edit" | "delete" | "plugins" | "github" | "previous" | "base" }

export interface ProfilePickerOption {
  title: string
  description: string
  category: string
  value: ProfilePickerValue
  disabled?: boolean
}

export function pluginMetadataDescription(input: {
  plugin: PluginReference
  kind: PluginKind
  installed: boolean
  active: boolean
}): string {
  const { plugin, kind, installed, active } = input
  const origin = plugin.source ?? (plugin.spec.startsWith("github:")
    ? "github"
    : /^(?:file:|\/|[A-Za-z]:[\\/]|\.{1,2}[\\/])/.test(plugin.spec)
      ? "file"
      : "npm")
  const revision = plugin.commit ? `commit ${plugin.commit}` : plugin.version ? `version ${plugin.version}` : `spec ${plugin.spec}`
  const current = kind === "tui" ? active ? "active in TUI runtime" : "inactive in TUI runtime" : active ? "configured in server plugin list" : "not configured in server plugin list"
  return [
    plugin.description?.trim() || "No description available.",
    `Creator: ${plugin.author || "unknown"}`,
    `Origin: ${origin}`,
    revision,
    plugin.repository ? `Repository: ${plugin.repository}` : undefined,
    `Installed: ${installed ? "yes" : "no"}`,
    current,
  ].filter(Boolean).join(" · ")
}

function countRecord(value: unknown): number {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.keys(value).length : 0
}

function profileDescription(
  profile: EffectiveProfile,
  isolation: IsolationReport,
  restart?: ProfileChange,
  pluginState?: (kind: "server" | "tui", spec: string) => string,
): string {
  const plugins = [
    ...profile.plugins.server.map((item) => `server:${shortPluginName(item)} [${pluginState?.("server", item.spec) ?? (item.installedAt ? "installed" : "configured")}]`),
    ...profile.plugins.tui.map((item) => `tui:${shortPluginName(item)} [${pluginState?.("tui", item.spec) ?? (item.installedAt ? "installed" : "configured")}]`),
  ]
  const pluginText = plugins.length ? `plugins ${plugins.slice(0, 3).join(", ")}${plugins.length > 3 ? ` +${plugins.length - 3}` : ""}` : "0 profile plugins"
  const skillConfig = profile.config.skills && typeof profile.config.skills === "object" && !Array.isArray(profile.config.skills)
    ? profile.config.skills as Record<string, unknown>
    : {}
  const skills = [skillConfig.paths, skillConfig.urls].reduce<number>((count, value) => count + (Array.isArray(value) ? value.length : 0), 0)
  const skillsText = [
    profile.inheritance.globalSkills ? "skills inherited" : "no inherited global skills",
    `${skills} profile skill source${skills === 1 ? "" : "s"}`,
  ].join(" · ")
  const mcp = countRecord(profile.config.mcp)
  const mcpText = [
    profile.inheritance.mcp ? "MCPs inherited" : "no inherited MCPs",
    `${mcp} profile MCP${mcp === 1 ? "" : "s"}`,
  ].join(" · ")
  const isolationText = isolation.complete ? "isolated" : `isolation: ${isolation.entries.find((item) => item.state === "launch-required" || item.state === "partial")?.state ?? "layered"}`
  const restartText = restart ? `switch: ${restart.kind.toLowerCase().replaceAll("_", " ")}` : "switch: live"
  const temporaryText = profile.temporary ? "temporary" : "saved"
  return [profile.description || "No description", pluginText, skillsText, mcpText, isolationText, temporaryText, restartText].join(" · ")
}

export function buildProfilePickerOptions(input: {
  profiles: EffectiveProfile[]
  activeId: string
  isolation: (profile: EffectiveProfile) => IsolationReport
  restart: (profile: EffectiveProfile) => ProfileChange | undefined
  hasPrevious: boolean
  pluginState?: (kind: "server" | "tui", spec: string) => string
}): ProfilePickerOption[] {
  const options = [...input.profiles]
    .sort((a, b) => a.id === input.activeId ? -1 : b.id === input.activeId ? 1 : a.name.localeCompare(b.name))
    .map((profile): ProfilePickerOption => ({
      title: `${profile.id === input.activeId ? "✓ " : ""}${profile.name}${profile.temporary ? " [temporary]" : ""}${profile.isolationMode === "isolated-launch" ? " [isolated launch]" : ""}`,
      description: profileDescription(profile, input.isolation(profile), input.restart(profile), input.pluginState),
      category: "Profiles",
      value: { kind: "profile", id: profile.id },
    }))
  options.push(
    { title: "Create profile", description: "Start from the shared base", category: "Manage", value: { kind: "action", id: "create" } },
    { title: "Create temporary profile", description: "Clone the active setup and delete it when left", category: "Manage", value: { kind: "action", id: "temporary" } },
    { title: "Duplicate profile", description: "Copy profile config and plugin references", category: "Manage", value: { kind: "action", id: "duplicate" } },
    { title: "Edit metadata or config", description: "Change the description or JSON config", category: "Manage", value: { kind: "action", id: "edit" } },
    { title: "Inspect plugin metadata", description: "Show creator, origin, version/ref, description, installation, and active state", category: "Plugins", value: { kind: "action", id: "plugins" } },
    { title: "Add GitHub plugin", description: "Inspect package metadata, pin a commit, then install", category: "Plugins", value: { kind: "action", id: "github" } },
  )
  if (input.hasPrevious) options.push({ title: "Switch to previous profile", description: "Return to the profile used before this one", category: "Manage", value: { kind: "action", id: "previous" } })
  options.push({ title: "Return to base", description: "Restore the plugin list captured before switching", category: "Manage", value: { kind: "action", id: "base" } })
  options.push({ title: "Delete profile", description: "Remove a saved profile's own files", category: "Manage", value: { kind: "action", id: "delete" } })
  return options
}

export function profileIds(profiles: Array<ProfileDefinition | EffectiveProfile>): string[] {
  return profiles.map((profile) => profile.id)
}
