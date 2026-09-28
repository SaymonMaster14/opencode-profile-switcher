#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { baseProfile, resolveEffectiveProfile } from "./core/profiles.ts"
import { materializeIsolatedLaunch, resolveOpenCodeConfigDir } from "./adapters/opencode11832Launch.ts"
import { profileStoreRoot, readStore } from "./core/store.ts"

function help(): void {
  console.log(`OpenCode Profile Manager

Usage:
  opencode-profile list
  opencode-profile launch <profile-id>

"launch" starts OpenCode with the selected profile. Isolated profiles get a
separate config and home; session data, authentication, and package caches stay shared.`)
}

async function listProfiles(): Promise<void> {
  const configDir = resolveOpenCodeConfigDir()
  const root = profileStoreRoot(configDir)
  const store = await readStore(root)
  const active = process.env.OPENCODE_PROFILE_ID ?? store.index.activeProfileId
  console.log(`Active profile: ${active}`)
  for (const profile of store.profiles) {
    const marker = profile.id === active ? "*" : " "
    const kind = profile.temporary ? "temporary" : profile.isolationMode
    console.log(`${marker} ${profile.id}\t${profile.name}\t${kind}`)
  }
}

async function launchProfile(id: string): Promise<number> {
  const configDir = resolveOpenCodeConfigDir()
  const root = profileStoreRoot(configDir)
  const store = await readStore(root)
  const profile = id === "base"
    ? baseProfile(store.index)
    : resolveEffectiveProfile(id, new Map(store.profiles.map((item) => [item.id, item])), store.index)
  const plan = await materializeIsolatedLaunch({ profile, storeRoot: root, managerSpec: store.index.managerSpec })
  const executable = process.env.OPENCODE_BINARY || "opencode"

  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      cwd: process.cwd(),
      env: plan.environment,
      stdio: "inherit",
      shell: process.platform === "win32",
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
}

async function main(args: string[]): Promise<number> {
  const command = args[0]
  if (command === "list") {
    await listProfiles()
    return 0
  }
  if ((command === "launch" || command === "run") && args[1]) return launchProfile(args[1])
  help()
  return command ? 2 : 0
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  console.error(`opencode-profile: ${(error as Error).message}`)
  process.exitCode = 1
}
