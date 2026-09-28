import type { Config, Plugin, PluginModule } from "@opencode-ai/plugin"
import path from "node:path"
import { mergeJson } from "./core/json.ts"
import { resolveOpenCodeConfigDir } from "./adapters/opencode11832Launch.ts"
import { ProfileStoreError, profileDir, profileStoreRoot, readStore } from "./core/store.ts"
import { resolveEffectiveProfile } from "./core/profiles.ts"
import { MANAGER_PLUGIN_ID, type JsonObject } from "./core/types.ts"

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function applyProfileConfig(config: Config, profile: ReturnType<typeof resolveEffectiveProfile>, directory?: string): void {
  const current = config as unknown as JsonObject
  const overlay = profile.config
  const next = mergeJson(current, overlay)

  if (!profile.inheritance.mcp) {
    const inherited = object(current.mcp)
    const profileMcp = object(overlay.mcp)
    const mcp: Record<string, unknown> = {}
    for (const name of Object.keys(inherited)) {
      const owned = profileMcp[name]
      if (owned && typeof owned === "object" && !Array.isArray(owned)) mcp[name] = owned
      else mcp[name] = { enabled: false }
    }
    for (const [name, value] of Object.entries(profileMcp)) mcp[name] = value
    next.mcp = mcp as JsonObject[string]
  }

  if (!profile.inheritance.globalSkills || !profile.inheritance.projectSkills) {
    const skills = object(next.skills)
    const profileSkills = object(overlay.skills)
    const profilePaths = Array.isArray(profileSkills.paths) ? profileSkills.paths : []
    const profileUrls = Array.isArray(profileSkills.urls) ? profileSkills.urls : []
    next.skills = {
      ...skills,
      paths: profile.inheritance.globalSkills && Array.isArray(skills.paths) ? skills.paths : profilePaths,
      urls: profile.inheritance.globalSkills && Array.isArray(skills.urls) ? skills.urls : profileUrls,
    }
    next.tools = { ...object(next.tools), skill: false }
    next.permission = { ...object(next.permission), skill: "deny" }
  }

  if (directory) {
    const skills = object(next.skills)
    if (Array.isArray(skills.paths)) {
      next.skills = {
        ...skills,
        paths: skills.paths.map((item) => typeof item === "string" && !path.isAbsolute(item) && !item.startsWith("~/") ? path.resolve(directory, item) : item),
      }
    }
  }

  Object.assign(config, next)
}

const server: Plugin = async () => {
  let root: string | undefined = process.env.OPENCODE_PROFILE_STORE_DIR
  if (!root) {
    try {
      const configDir = process.env.OPENCODE_CONFIG_DIR || resolveOpenCodeConfigDir()
      root = profileStoreRoot(configDir)
    } catch {
      // OpenCode remains usable if the manager's metadata folder cannot be resolved.
    }
  }

  return {
    config: async (config) => {
      const storeRoot = process.env.OPENCODE_PROFILE_STORE_DIR || root
      if (!storeRoot) return
      try {
        const store = await readStore(storeRoot)
        const selected = process.env.OPENCODE_PROFILE_LAUNCH === "1"
          ? process.env.OPENCODE_PROFILE_ID || store.index.activeProfileId
          : store.index.activeProfileId
        if (selected === "base") return
        const profiles = new Map(store.profiles.map((profile) => [profile.id, profile]))
        const profile = resolveEffectiveProfile(selected, profiles, store.index)
        if (profile.isolationMode === "isolated-launch" && process.env.OPENCODE_PROFILE_LAUNCH !== "1") return
        applyProfileConfig(config, profile, profileDir(storeRoot, profile.id))
      } catch (error) {
        if (error instanceof ProfileStoreError && error.message === "Profile store has not been initialized") return
        // A malformed store must not corrupt the config passed to OpenCode.
        console.error(`[${MANAGER_PLUGIN_ID}] Profile config was not applied: ${(error as Error).message}`)
      }
    },
  }
}

const plugin: PluginModule = { id: MANAGER_PLUGIN_ID, server }
export default plugin
export { server }
