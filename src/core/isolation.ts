import type { EffectiveProfile, IsolationEntry, IsolationReport } from "./types.ts"
import { requiresIsolatedLaunch } from "./profiles.ts"

export function profileIsolationReport(profile: EffectiveProfile, processLaunchActive = false): IsolationReport {
  const isolatedConfig = requiresIsolatedLaunch(profile) && processLaunchActive
  const projectConfigUnavailable = isolatedConfig || (processLaunchActive && !profile.inheritance.projectSkills)
  const entries: IsolationEntry[] = []
  const add = (
    source: IsolationEntry["source"],
    requested: IsolationEntry["requested"],
    state: IsolationEntry["state"],
    mechanism: string,
  ) => entries.push({ source, requested, state, mechanism })

  add(
    "global-config",
    profile.inheritance.globalConfig ? "inherit" : "exclude",
    profile.inheritance.globalConfig ? isolatedConfig ? "partial" : "inherited" : isolatedConfig ? "excluded" : "launch-required",
    profile.inheritance.globalConfig
      ? isolatedConfig ? "The isolated config home omits the original global config, despite this profile requesting it." : "OpenCode loads its global config before the profile overlay."
      : isolatedConfig
        ? "A separate XDG/AppData config home prevents the normal global config from loading."
        : "OpenCode always merges Global.Path.config; OPENCODE_CONFIG_DIR is an additional layer.",
  )
  add(
    "project-config",
    profile.inheritance.projectConfig ? "inherit" : "exclude",
    profile.inheritance.projectConfig ? projectConfigUnavailable ? "partial" : "inherited" : "excluded",
    profile.inheritance.projectConfig
      ? projectConfigUnavailable ? "This launch disables project config to prevent project skill discovery; project config cannot be kept independently." : "Project config and .opencode sources are enabled."
      : "OPENCODE_DISABLE_PROJECT_CONFIG is applied before instance re-bootstrap.",
  )
  add(
    "global-home-config",
    profile.inheritance.globalConfig ? "inherit" : "exclude",
    profile.inheritance.globalConfig ? isolatedConfig ? "partial" : "inherited" : isolatedConfig ? "excluded" : "launch-required",
    profile.inheritance.globalConfig
      ? isolatedConfig ? "The isolated HOME omits the user's normal .opencode directory, despite this profile requesting it." : "The user's home-level .opencode directory remains discoverable."
      : isolatedConfig
        ? "The isolated process uses a profile-owned HOME, so the normal home .opencode directory is not scanned."
        : "Global home-level .opencode files are still discovered by the stable runtime.",
  )
  add(
    "global-server-plugins",
    profile.inheritance.globalServerPlugins ? "inherit" : "exclude",
    profile.inheritance.globalServerPlugins ? isolatedConfig ? "partial" : "inherited" : isolatedConfig ? "excluded" : "launch-required",
    profile.inheritance.globalServerPlugins
      ? isolatedConfig ? "The isolated config includes captured package references, but not local plugin files from the original global directory." : "The profile includes the captured global plugin list."
      : isolatedConfig
        ? "The isolated config contains only the manager and this profile's server plugins."
        : "The stable loader also discovers local plugin files in the global config directory.",
  )
  add(
    "project-server-plugins",
    profile.inheritance.projectServerPlugins ? "inherit" : "exclude",
    profile.inheritance.projectServerPlugins ? projectConfigUnavailable ? "partial" : "inherited" : "excluded",
    profile.inheritance.projectServerPlugins
      ? projectConfigUnavailable ? "This launch disables project plugin discovery along with project config." : "Project plugin sources are enabled."
      : "Project config and project .opencode discovery are disabled for the re-bootstrap.",
  )
  add(
    "global-tui-plugins",
    profile.inheritance.globalTuiPlugins ? "inherit" : "exclude",
    profile.inheritance.globalTuiPlugins ? "inherited" : "partial",
    "OpenCode 1.18.32 exposes live TUI plugin activation and deactivation; the profile manager and host-internal TUI plugins stay protected.",
  )
  add(
    "project-tui-plugins",
    profile.inheritance.projectTuiPlugins ? "inherit" : "exclude",
    profile.inheritance.projectTuiPlugins ? "inherited" : "excluded",
    "The 1.18.32 TUI plugin registry is global; profile-owned TUI plugins are reconciled through the public runtime API.",
  )
  add(
    "global-skills",
    profile.inheritance.globalSkills ? "inherit" : "exclude",
    profile.inheritance.globalSkills ? isolatedConfig ? "partial" : "inherited" : isolatedConfig ? "excluded" : "launch-required",
    profile.inheritance.globalSkills
      ? isolatedConfig ? "The isolated config and HOME omit normal global skill directories, despite this profile requesting them." : "Global OpenCode skill directories are available."
      : isolatedConfig
        ? "The isolated config and HOME contain no inherited user skills; the core built-in skill is permission-denied."
        : "Stable skill discovery scans the global config directory regardless of the profile overlay.",
  )
  add(
    "project-skills",
    profile.inheritance.projectSkills ? "inherit" : "exclude",
    profile.inheritance.projectSkills ? projectConfigUnavailable ? "partial" : "inherited" : processLaunchActive ? "excluded" : "launch-required",
    profile.inheritance.projectSkills
      ? projectConfigUnavailable ? "This launch disables project config or skill discovery, despite this profile requesting project skills." : "Project and external skill sources are available."
      : processLaunchActive
        ? "Project config and external project skill discovery are disabled at process launch."
        : "OpenCode reads external .agents/.claude skill flags at process startup, so relaunch this profile to apply the exclusion.",
  )
  add(
    "mcp",
    profile.inheritance.mcp ? "inherit" : "exclude",
    profile.inheritance.mcp ? isolatedConfig ? "partial" : "inherited" : "excluded",
    profile.inheritance.mcp
      ? isolatedConfig ? "The isolated config home omits MCPs from the original global and project config, despite this profile requesting them." : "Configured global and project MCPs are inherited."
      : "Resolved MCP entries are set to enabled:false before the instance services load.",
  )
  add("managed-config", "inherit", "protected", "System-managed OpenCode settings may still apply and are outside user profile control.")
  add(
    "remote-config",
    profile.inheritance.globalConfig ? "inherit" : "exclude",
    profile.inheritance.globalConfig && !isolatedConfig ? "inherited" : "partial",
    profile.inheritance.globalConfig && !isolatedConfig
      ? "Authenticated organization remote config remains available."
      : "Remote config may still be fetched from shared authentication; stable exposes no profile-scoped disable API.",
  )
  const allAgentSourcesExcluded = isolatedConfig && !profile.inheritance.globalConfig && !profile.inheritance.projectConfig
  const someAgentSourcesExcluded = isolatedConfig || !profile.inheritance.globalConfig || projectConfigUnavailable || !profile.inheritance.projectConfig
  add(
    "agents-commands",
    profile.inheritance.globalConfig && profile.inheritance.projectConfig ? "inherit" : "exclude",
    allAgentSourcesExcluded ? "excluded" : someAgentSourcesExcluded ? "partial" : "inherited",
    isolatedConfig
      ? "The isolated config omits normal global and project auto-discovered agent and command files."
      : "The profile overlay can replace resolved config, but auto-discovered global home files remain in the source set.",
  )
  add("sessions-auth", "inherit", "protected", "OpenCode data/state and authentication directories remain shared so session history and credentials survive profile launches.")

  const complete = entries.every((entry) => entry.requested === "inherit"
    ? entry.state === "inherited" || entry.state === "protected"
    : entry.state === "excluded")
  return { complete, mode: profile.isolationMode, entries }
}
