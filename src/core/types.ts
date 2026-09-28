export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export const BASE_PROFILE_ID = "base"
export const RAW_PROFILE_ID = "raw"
export const MANAGER_PLUGIN_ID = "opencode-profile-switcher"

export type PluginKind = "server" | "tui"
export type PluginSource = "github" | "npm" | "file" | "unknown"

export interface PluginReference {
  spec: string
  options?: JsonObject
  id?: string
  name?: string
  description?: string
  author?: string
  source?: PluginSource
  version?: string
  commit?: string
  installedAt?: number
  repository?: string
  hasServer?: boolean
  hasTui?: boolean
}

export interface InheritancePolicy {
  globalConfig: boolean
  projectConfig: boolean
  globalServerPlugins: boolean
  projectServerPlugins: boolean
  globalTuiPlugins: boolean
  projectTuiPlugins: boolean
  globalSkills: boolean
  projectSkills: boolean
  mcp: boolean
}

export type IsolationMode = "layered" | "isolated-launch"

export interface ProfileDefinition {
  id: string
  name: string
  description: string
  extends?: string
  createdAt: number
  updatedAt: number
  builtin?: boolean
  temporary?: {
    createdAt: number
    ownerRunId: string
  }
  isolationMode: IsolationMode
  inheritance: InheritancePolicy
  config: JsonObject
  plugins: Record<PluginKind, PluginReference[]>
  environment: Record<string, string>
}

export interface ProfileIndex {
  schemaVersion: 1
  revision: number
  activeProfileId: string
  previousProfileId: string | null
  pendingProfileId: string | null
  profileIds: string[]
  baseServerPlugins: PluginReference[]
  baseTuiPlugins: PluginReference[]
  lastAppliedServerPlugins: PluginReference[] | null
  managerSpec: string
  updatedAt: number
}

export interface EffectiveProfile {
  id: string
  name: string
  description: string
  temporary: boolean
  isolationMode: IsolationMode
  inheritance: InheritancePolicy
  config: JsonObject
  plugins: Record<PluginKind, PluginReference[]>
  environment: Record<string, string>
}

export type ChangeKind = "LIVE" | "INSTANCE_RELOAD" | "GLOBAL_RELOAD" | "PROCESS_RESTART"

export interface ProfileChange {
  kind: ChangeKind
  area: string
  reason: string
}

export interface SwitchPlan {
  from: string
  to: string
  changes: ProfileChange[]
  required: ChangeKind | "NONE"
  confirmationRequired: boolean
  explanation: string[]
}

export interface RuntimeCapabilities {
  version: string
  supportsTuiPluginToggle: boolean
  supportsInstanceDispose: boolean
  supportsGlobalConfigUpdate: boolean
  supportsProjectConfigToggle: boolean
  supportsIsolatedLaunch: boolean
  supportsDesktopExtension: false
}

export type IsolationState = "inherited" | "excluded" | "partial" | "launch-required" | "protected"

export interface IsolationEntry {
  source: "global-config" | "project-config" | "global-home-config" | "managed-config" | "remote-config" | "global-server-plugins" | "project-server-plugins" | "global-tui-plugins" | "project-tui-plugins" | "global-skills" | "project-skills" | "mcp" | "agents-commands" | "sessions-auth"
  requested: "inherit" | "exclude"
  state: IsolationState
  mechanism: string
}

export interface IsolationReport {
  complete: boolean
  mode: IsolationMode
  entries: IsolationEntry[]
}

export interface RuntimeLease {
  runId: string
  pid: number
  updatedAt: number
  temporaryProfileId: string | null
}

export interface ProfileStoreSnapshot {
  index: ProfileIndex
  profiles: ProfileDefinition[]
}
