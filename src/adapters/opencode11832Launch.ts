import { mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { EffectiveProfile } from "../core/types.ts"
import { requiresIsolatedLaunch } from "../core/profiles.ts"
import { writeProfileFileAtomically } from "../core/store.ts"

export interface IsolatedLaunchPlan {
  profileId: string
  isolated: boolean
  configHome: string
  home: string
  configDir: string
  generatedConfig?: string
  environment: NodeJS.ProcessEnv
}

function originalHome(env: NodeJS.ProcessEnv): string {
  return env.USERPROFILE || env.HOME || os.homedir()
}

function sharedXdg(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, kind: "data" | "cache" | "state"): string {
  const explicit = env[`XDG_${kind.toUpperCase()}_HOME`]
  if (explicit) return explicit
  if (platform === "win32") {
    return env.LOCALAPPDATA || path.join(originalHome(env), "AppData", "Local")
  }
  const home = originalHome(env)
  if (kind === "data") return path.join(home, ".local", "share")
  if (kind === "cache") return path.join(home, ".cache")
  return path.join(home, ".local", "state")
}

function openCodeConfigHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (env.XDG_CONFIG_HOME) return env.XDG_CONFIG_HOME
  if (platform === "win32") return env.APPDATA || path.join(originalHome(env), "AppData", "Roaming")
  return path.join(originalHome(env), ".config")
}

export function resolveOpenCodeConfigDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return path.join(openCodeConfigHome(env, platform), "opencode")
}

export function buildIsolatedLaunchPlan(input: {
  profile: EffectiveProfile
  storeRoot: string
  managerSpec: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}): IsolatedLaunchPlan {
  const env = input.env ?? process.env
  const platform = input.platform ?? process.platform
  const root = path.resolve(input.storeRoot)
  const nextEnv: NodeJS.ProcessEnv = { ...env }
  const isolated = requiresIsolatedLaunch(input.profile)

  if (!isolated) {
    const configHome = openCodeConfigHome(env, platform)
    const configDir = resolveOpenCodeConfigDir(env, platform)
    nextEnv.OPENCODE_PROFILE_STORE_DIR = root
    nextEnv.OPENCODE_PROFILE_ID = input.profile.id
    nextEnv.OPENCODE_PROFILE_LAUNCH = "1"
    if (!input.profile.inheritance.projectConfig || !input.profile.inheritance.projectSkills) nextEnv.OPENCODE_DISABLE_PROJECT_CONFIG = "true"
    if (!input.profile.inheritance.projectSkills) {
      nextEnv.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true"
    }
    Object.assign(nextEnv, input.profile.environment)
    return {
      profileId: input.profile.id,
      isolated: false,
      configHome,
      home: originalHome(env),
      configDir,
      environment: nextEnv,
    }
  }

  const runtime = path.join(root, ".launch", input.profile.id)
  const home = path.join(runtime, "home")
  const configHome = path.join(runtime, "xdg-config")
  const configDir = path.join(configHome, "opencode")
  const generatedConfig = path.join(configDir, "opencode.json")

  Object.assign(nextEnv, input.profile.environment)
  nextEnv.HOME = home
  nextEnv.USERPROFILE = home
  nextEnv.OPENCODE_TEST_HOME = home
  nextEnv.XDG_CONFIG_HOME = configHome
  nextEnv.XDG_DATA_HOME = sharedXdg(env, platform, "data")
  nextEnv.XDG_CACHE_HOME = sharedXdg(env, platform, "cache")
  nextEnv.XDG_STATE_HOME = sharedXdg(env, platform, "state")
  if (platform === "win32") nextEnv.APPDATA = configHome
  nextEnv.OPENCODE_PROFILE_STORE_DIR = root
  nextEnv.OPENCODE_PROFILE_ID = input.profile.id
  nextEnv.OPENCODE_PROFILE_LAUNCH = "1"
  nextEnv.OPENCODE_DISABLE_PROJECT_CONFIG = "true"
  nextEnv.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true"
  delete nextEnv.OPENCODE_CONFIG
  delete nextEnv.OPENCODE_CONFIG_CONTENT
  delete nextEnv.OPENCODE_CONFIG_DIR

  return { profileId: input.profile.id, isolated: true, configHome, home, configDir, generatedConfig, environment: nextEnv }
}

export async function materializeIsolatedLaunch(input: {
  profile: EffectiveProfile
  storeRoot: string
  managerSpec: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}): Promise<IsolatedLaunchPlan> {
  const plan = buildIsolatedLaunchPlan(input)
  if (!plan.isolated) return plan
  const generatedConfig = plan.generatedConfig
  if (!generatedConfig) throw new Error("Isolated launch config path is missing")
  await Promise.all([mkdir(plan.configDir, { recursive: true }), mkdir(plan.home, { recursive: true }), mkdir(path.dirname(generatedConfig), { recursive: true })])
  const serverPlugins = [...new Set([input.managerSpec, ...input.profile.plugins.server.map((item) => item.spec)])]
  const tuiPlugins = [...new Set([input.managerSpec, ...input.profile.plugins.tui.map((item) => item.spec)])]
  const config = { ...input.profile.config, $schema: "https://opencode.ai/config.json", plugin: serverPlugins }
  const tui = { $schema: "https://opencode.ai/tui.json", plugin: tuiPlugins }
  await Promise.all([
    writeProfileFileAtomically(generatedConfig, `${JSON.stringify(config, null, 2)}\n`),
    writeProfileFileAtomically(path.join(plan.configDir, "tui.json"), `${JSON.stringify(tui, null, 2)}\n`),
  ])
  return plan
}
