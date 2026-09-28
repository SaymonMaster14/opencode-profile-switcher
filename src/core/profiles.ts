import { mergeJson, uniquePlugins } from "./json.ts"
import {
  BASE_PROFILE_ID,
  RAW_PROFILE_ID,
  type EffectiveProfile,
  type InheritancePolicy,
  type JsonObject,
  type PluginReference,
  type ProfileDefinition,
  type ProfileIndex,
} from "./types.ts"
import { defaultInheritance } from "./validation.ts"

export function createRawProfile(now = Date.now()): ProfileDefinition {
  return {
    id: RAW_PROFILE_ID,
    name: "Raw",
    description: "A clean OpenCode config root. Profiles, sessions, auth, and package caches remain separate or shared as reported before launch.",
    createdAt: now,
    updatedAt: now,
    builtin: true,
    isolationMode: "isolated-launch",
    inheritance: defaultInheritance(false),
    config: {
      tools: { skill: false },
      permission: { skill: "deny" },
      skills: { paths: [], urls: [] },
      mcp: {},
    },
    plugins: { server: [], tui: [] },
    environment: {},
  }
}

export function requiresIsolatedLaunch(profile: Pick<ProfileDefinition, "isolationMode" | "inheritance"> | Pick<EffectiveProfile, "isolationMode" | "inheritance">): boolean {
  return profile.isolationMode === "isolated-launch" ||
    !profile.inheritance.globalConfig ||
    !profile.inheritance.globalServerPlugins ||
    !profile.inheritance.globalSkills
}

export function createProfile(input: {
  id: string
  name: string
  description?: string
  config?: JsonObject
  plugins?: { server?: PluginReference[]; tui?: PluginReference[] }
  inheritance?: Partial<InheritancePolicy>
  isolationMode?: ProfileDefinition["isolationMode"]
  extends?: string
  temporary?: ProfileDefinition["temporary"]
  environment?: Record<string, string>
  now?: number
}): ProfileDefinition {
  const now = input.now ?? Date.now()
  return {
    id: input.id,
    name: input.name.trim(),
    description: input.description ?? "",
    ...(input.extends ? { extends: input.extends } : {}),
    createdAt: now,
    updatedAt: now,
    ...(input.temporary ? { temporary: input.temporary } : {}),
    isolationMode: input.isolationMode ?? "layered",
    inheritance: { ...defaultInheritance(true), ...input.inheritance },
    config: input.config ?? {},
    plugins: { server: input.plugins?.server ?? [], tui: input.plugins?.tui ?? [] },
    environment: input.environment ?? {},
  }
}

export function baseProfile(index: ProfileIndex, managerSpec = index.managerSpec): EffectiveProfile {
  const manager: PluginReference = { spec: managerSpec, id: "opencode-profile-switcher", name: "OpenCode Profile Manager" }
  return {
    id: BASE_PROFILE_ID,
    name: "Base",
    description: "Restore the plugin configuration captured before profile switching.",
    temporary: false,
    isolationMode: "layered",
    inheritance: defaultInheritance(true),
    config: {},
    plugins: {
      server: uniquePlugins([...index.baseServerPlugins, manager]),
      tui: uniquePlugins([...index.baseTuiPlugins, manager]),
    },
    environment: {},
  }
}

export function resolveEffectiveProfile(
  id: string,
  profiles: Map<string, ProfileDefinition>,
  index: ProfileIndex,
  projectTuiPlugins: PluginReference[] = [],
): EffectiveProfile {
  if (id === BASE_PROFILE_ID) return baseProfile(index)
  const leaf = profiles.get(id)
  if (!leaf) throw new Error(`Unknown profile: ${id}`)

  const chain: ProfileDefinition[] = []
  const seen = new Set<string>()
  let current: ProfileDefinition | undefined = leaf
  while (current) {
    if (seen.has(current.id)) throw new Error(`Profile inheritance cycle at ${current.id}`)
    seen.add(current.id)
    chain.unshift(current)
    if (!current.extends || current.extends === BASE_PROFILE_ID) break
    current = profiles.get(current.extends)
    if (!current) throw new Error(`Profile ${chain.at(-1)?.id} extends missing profile ${chain.at(-1)?.extends}`)
  }

  let config: JsonObject = {}
  let server: PluginReference[] = []
  let tui: PluginReference[] = []
  let environment: Record<string, string> = {}
  for (const profile of chain) {
    config = mergeJson(config, profile.config)
    server = uniquePlugins([...server, ...profile.plugins.server])
    tui = uniquePlugins([...tui, ...profile.plugins.tui])
    environment = { ...environment, ...profile.environment }
  }

  const inheritance = leaf.inheritance
  if (inheritance.globalServerPlugins) server = uniquePlugins([...index.baseServerPlugins, ...server])
  if (inheritance.globalTuiPlugins) tui = uniquePlugins([...index.baseTuiPlugins, ...tui])
  if (inheritance.projectTuiPlugins) tui = uniquePlugins([...tui, ...projectTuiPlugins])

  const manager: PluginReference = {
    spec: index.managerSpec,
    id: "opencode-profile-switcher",
    name: "OpenCode Profile Manager",
    source: index.managerSpec.startsWith("github:") ? "github" : undefined,
  }

  return {
    id: leaf.id,
    name: leaf.name,
    description: leaf.description,
    temporary: Boolean(leaf.temporary),
    isolationMode: leaf.isolationMode,
    inheritance,
    config,
    plugins: {
      server: uniquePlugins([...server, manager]),
      tui: uniquePlugins([...tui, manager]),
    },
    environment,
  }
}
