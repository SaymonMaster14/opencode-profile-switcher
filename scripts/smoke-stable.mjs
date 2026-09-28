import assert from "node:assert/strict"
import { spawn, spawnSync as nodeSpawnSync } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import net from "node:net"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { createOpencodeClient as createV2Client } from "@opencode-ai/sdk/v2"
import { ensureStore, createStoredProfile, setActiveProfile, profileStoreRoot } from "../src/core/store.ts"
import { createProfile } from "../src/core/profiles.ts"
import { baseProfile, resolveEffectiveProfile } from "../src/core/profiles.ts"
import { materializeIsolatedLaunch, resolveOpenCodeConfigDir } from "../src/adapters/opencode11832Launch.ts"

const GITHUB_INSTALL_REPOSITORY = "uoiszero/opencode-plan-usage"
const GITHUB_INSTALL_COMMIT = "697a0839a9c5d3a89a147a2ae931d940f257be93"
function safeEnv(root, extras = {}) {
  const home = path.join(root, "home")
  const configHome = path.join(root, "xdg-config")
  const dataHome = path.join(root, "xdg-data")
  const cacheHome = path.join(root, "xdg-cache")
  const stateHome = path.join(root, "xdg-state")
  const localHome = path.join(root, "local")
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) delete env[key]
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    OPENCODE_TEST_HOME: home,
    APPDATA: configHome,
    LOCALAPPDATA: localHome,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_CACHE_HOME: cacheHome,
    XDG_STATE_HOME: stateHome,
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_PRUNE: "true",
    ...extras,
  })
  for (const key of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR", "OPENCODE_PROFILE_STORE_DIR", "OPENCODE_PROFILE_ID", "OPENCODE_PROFILE_LAUNCH", "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_DISABLE_EXTERNAL_SKILLS", "OPENCODE_PURE"]) {
    if (!(key in extras)) delete env[key]
  }
  return { env, home, configHome, dataHome, cacheHome, stateHome, localHome }
}

function runSync(binary, args, options = {}) {
  const result = nodeSpawnSync(binary, args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
    ...options,
  })
  if (result.error) throw result.error
  return result
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Could not reserve a local port")
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

async function waitForConfig(client, directory, child) {
  const deadline = Date.now() + 30_000
  let lastError = "server is starting"
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`OpenCode server exited early (${child.exitCode}): ${lastError}`)
    try {
      const result = await client.config.get({ query: { directory } })
      if (result.data) return result.data
      lastError = String(result.error ?? "config endpoint returned no data")
    } catch (error) {
      lastError = (error instanceof Error ? error.message : String(error)).slice(0, 300)
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`OpenCode server did not become ready: ${lastError}`)
}

async function withServer(binary, projectDirectory, env, run) {
  const port = await freePort()
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: projectDirectory,
    env,
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  })
  const baseUrl = `http://127.0.0.1:${port}`
  const client = createOpencodeClient({ baseUrl, directory: projectDirectory })
  try {
    await waitForConfig(client, projectDirectory, child)
    return await run({ client, baseUrl, child })
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM")
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ])
      if (child.exitCode === null && process.platform === "win32" && child.pid) {
        const taskkill = path.join(env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe")
        nodeSpawnSync(taskkill, ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
      }
    }
  }
}

function pluginSpec(value) {
  if (typeof value === "string") return value
  if (Array.isArray(value) && typeof value[0] === "string") return value[0]
  return undefined
}

function initializeTestRepository(directory, env) {
  const result = runSync("git", ["init", "--quiet"], { cwd: directory, env })
  assert.equal(result.status, 0, `Could not make the isolated smoke project a Git worktree: ${String(result.stderr).slice(-500)}`)
}

async function testGitHubInstall(binary, root) {
  const repo = GITHUB_INSTALL_REPOSITORY
  const raw = `https://raw.githubusercontent.com/${repo}/${GITHUB_INSTALL_COMMIT}/package.json`
  const response = await fetch(raw, { headers: { "user-agent": "opencode-profile-switcher-smoke" } })
  assert.equal(response.status, 200, "Pinned stable-compatible test plugin is reachable")
  const manifest = await response.json()
  const scripts = manifest.scripts ?? {}
  const lifecycle = ["preinstall", "install", "postinstall", "prepare"].filter((key) => key in scripts)
  assert.deepEqual(lifecycle, [], "The installer fixture must not run package lifecycle scripts")
  assert.ok(manifest.exports?.["./server"] && manifest.exports?.["./tui"], "The test plugin must expose separate server and TUI targets")
  assert.deepEqual(manifest.dependencies ?? {}, {}, "The installer fixture should not need a dependency lifecycle")

  const paths = safeEnv(root)
  await Promise.all([paths.home, paths.configHome, paths.dataHome, paths.cacheHome, paths.stateHome, paths.localHome].map((dir) => mkdir(dir, { recursive: true })))
  initializeTestRepository(root, paths.env)
  const binaryPath = binary
  const spec = `github:${repo}#${GITHUB_INSTALL_COMMIT}`
  const result = runSync(binaryPath, ["plugin", spec, "--global", "--print-logs"], { cwd: root, env: paths.env })
  assert.equal(result.status, 0, `Stable plugin installer rejected a pinned GitHub spec:\n${String(result.stdout).slice(-1200)}\n${String(result.stderr).slice(-2200)}`)
  const configDir = resolveOpenCodeConfigDir(paths.env)
  const files = await Promise.all(["opencode.json", "opencode.jsonc"].map(async (name) => {
    try { return [name, JSON.parse(await readFile(path.join(configDir, name), "utf8"))] } catch { return [name, undefined] }
  }))
  const globalConfig = files.find(([, value]) => value)?.[1]
  const tuiConfig = JSON.parse(await readFile(path.join(configDir, "tui.json"), "utf8"))
  assert.ok(globalConfig?.plugin?.some((item) => pluginSpec(item) === spec), "GitHub spec was not recorded in global server config")
  assert.ok(tuiConfig.plugin?.some((item) => pluginSpec(item) === spec), "GitHub spec was not recorded in global TUI config")
}

async function testServerProfileAndInstanceDispose(binary, root) {
  const paths = safeEnv(root)
  const project = path.join(root, "project")
  const globalConfigDir = path.join(paths.configHome, "opencode")
  const profileRoot = path.join(globalConfigDir, "profiles")
  const homePluginDir = path.join(paths.home, ".opencode", "plugins")
  const projectMarker = path.join(root, "project-hook.marker")
  const globalPluginMarker = path.join(root, "global-plugin.marker")
  const homePluginMarker = path.join(root, "home-plugin.marker")
  await Promise.all([project, globalConfigDir, path.join(globalConfigDir, "plugins"), path.join(globalConfigDir, "skills", "global-smoke"), homePluginDir, paths.home, paths.dataHome, paths.cacheHome, paths.stateHome, paths.localHome].map((dir) => mkdir(dir, { recursive: true })))
  initializeTestRepository(project, paths.env)

  const managerSpec = pathToFileURL(path.resolve("src/server.ts")).href
  const globalLocalPlugin = path.resolve(globalConfigDir, "plugins", "global-marker.js")
  const homeLocalPlugin = path.join(homePluginDir, "home-marker.js")
  await writeFile(globalLocalPlugin, `export default { id: "profile-smoke-global-marker", server: async () => ({ config: async () => { const marker = process.env.OPENCODE_PROFILE_SMOKE_GLOBAL_MARKER; if (marker) await (await import("node:fs/promises")).writeFile(marker, "global plugin loaded") } }) }\n`)
  await writeFile(homeLocalPlugin, `export default { id: "profile-smoke-home-marker", server: async () => ({ config: async () => { const marker = process.env.OPENCODE_PROFILE_SMOKE_HOME_MARKER; if (marker) await (await import("node:fs/promises")).writeFile(marker, process.env.OPENCODE_TEST_HOME ?? "home override missing") } }) }\n`)
  await writeFile(path.join(globalConfigDir, "skills", "global-smoke", "SKILL.md"), "---\nname: global-smoke-skill\ndescription: smoke skill\n---\nThis skill proves the global skill source is visible.\n")
  await mkdir(path.join(project, ".agents", "skills", "project-smoke"), { recursive: true })
  await writeFile(path.join(project, ".agents", "skills", "project-smoke", "SKILL.md"), "---\nname: project-smoke-skill\ndescription: smoke skill\n---\nThis skill proves project source visibility.\n")

  const store = await ensureStore(profileRoot, { managerSpec, baseServerPlugins: [{ spec: managerSpec }], baseTuiPlugins: [] })
  if (!store.profiles.some((profile) => profile.id === "smoke")) {
    await createStoredProfile(profileRoot, createProfile({
      id: "smoke",
      name: "Stable smoke",
      description: "Temporary isolated integration profile",
      config: { model: "openai/profile-smoke", username: "PROFILE_HOOK_MARKER" },
    }))
  }
  await setActiveProfile(profileRoot, "smoke")

  await writeFile(path.join(globalConfigDir, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    username: "GLOBAL_CONFIG_MARKER",
    model: "openai/global-smoke",
    mcp: { globalSmoke: { type: "remote", url: "http://127.0.0.1:1/mcp", enabled: false } },
    plugin: [managerSpec],
  }, null, 2))
  await writeFile(path.join(project, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    username: "PROJECT_CONFIG_MARKER",
    small_model: "openai/project-small",
    mcp: { projectSmoke: { type: "remote", url: "http://127.0.0.1:1/project-mcp", enabled: false } },
    plugin: [pathToFileURL(path.resolve("test/fixtures/project-marker.mjs")).href],
  }, null, 2))
  paths.env.OPENCODE_PROFILE_STORE_DIR = profileRoot
  paths.env.OPENCODE_PROFILE_SMOKE_PROJECT_MARKER = projectMarker
  paths.env.OPENCODE_PROFILE_SMOKE_GLOBAL_MARKER = globalPluginMarker
  paths.env.OPENCODE_PROFILE_SMOKE_HOME_MARKER = homePluginMarker
  delete paths.env.OPENCODE_DISABLE_PROJECT_CONFIG

  await withServer(binary, project, paths.env, async ({ client, baseUrl }) => {
    const config = await client.config.get({ query: { directory: project } })
    assert.equal(config.error, undefined, "Stable server config endpoint returned an error")
    assert.equal(config.data?.model, "openai/profile-smoke", "Server config hook did not apply the active profile")
    assert.equal(config.data?.username, "PROFILE_HOOK_MARKER", "Profile config hook did not execute")
    assert.equal(config.data?.small_model, "openai/project-small", "Project config was not loaded before the profile overlay")
    assert.ok(config.data?.mcp && "globalSmoke" in config.data.mcp && "projectSmoke" in config.data.mcp, "Global and project MCP sources were not visible")
    assert.equal(await readFile(projectMarker, "utf8"), "project plugin loaded")
    assert.equal(await readFile(globalPluginMarker, "utf8"), "global plugin loaded")
    assert.equal(await readFile(homePluginMarker, "utf8"), paths.home, "OpenCode did not use the isolated global home override")

    const created = await client.session.create({ query: { directory: project }, body: { title: "Profile manager smoke" } })
    assert.equal(created.error, undefined, "Could not create a session in the isolated smoke environment")
    const sessionId = created.data?.id
    assert.ok(sessionId, "Session create returned no id")
    const dispose = await client.instance.dispose({ query: { directory: project } })
    assert.equal(dispose.error, undefined, "instance.dispose failed")
    assert.equal(dispose.data, true, "instance.dispose did not confirm disposal")
    const after = await client.config.get({ query: { directory: project } })
    assert.equal(after.data?.model, "openai/profile-smoke", "Profile config hook did not run after instance.dispose")
    const sessions = await client.session.list({ query: { directory: project } })
    assert.ok(sessions.data?.some((session) => session.id === sessionId), "Instance disposal removed session history")

    const v2 = createV2Client({ baseUrl, directory: project })
    const extraServerPlugin = pathToFileURL(path.resolve("test/fixtures/server-set-marker.mjs")).href
    const globalUpdate = await v2.global.config.update({ config: { plugin: [managerSpec, extraServerPlugin] } })
    assert.equal(globalUpdate.error, undefined, "Global server plugin config update failed")
    const globalDispose = await v2.global.dispose()
    assert.equal(globalDispose.error, undefined, "Global instance disposal failed after plugin update")
    const afterGlobalReload = await client.config.get({ query: { directory: project } })
    assert.equal(afterGlobalReload.data?.username, "SERVER_SET_PLUGIN_ACTIVE", "Global server plugin was not loaded after config update")
    const sessionsAfterGlobalReload = await client.session.list({ query: { directory: project } })
    assert.ok(sessionsAfterGlobalReload.data?.some((session) => session.id === sessionId), "Global reload removed session history")

    const restore = await v2.global.config.update({ config: { plugin: [managerSpec] } })
    assert.equal(restore.error, undefined, "Could not restore the temporary server plugin list")
    await v2.global.dispose()
    const restoredConfig = await client.config.get({ query: { directory: project } })
    assert.equal(restoredConfig.data?.username, "PROFILE_HOOK_MARKER", "Temporary server plugin config was not removed after global reload")
  })

  const disabledRoot = path.join(root, "project-config-disabled")
  const disabled = safeEnv(disabledRoot, {
    OPENCODE_PROFILE_STORE_DIR: profileRoot,
    OPENCODE_PROFILE_SMOKE_PROJECT_MARKER: path.join(disabledRoot, "project-hook.marker"),
    OPENCODE_PROFILE_SMOKE_GLOBAL_MARKER: path.join(disabledRoot, "global-plugin.marker"),
    OPENCODE_PROFILE_SMOKE_HOME_MARKER: path.join(disabledRoot, "home-plugin.marker"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  })
  await Promise.all([disabledRoot, disabled.home, disabled.configHome, disabled.dataHome, disabled.cacheHome, disabled.stateHome, disabled.localHome].map((dir) => mkdir(dir, { recursive: true })))
  // Reuse the isolated global config and skills, but start the project from a separate root with its project config flag enabled.
  const disabledProject = path.join(disabledRoot, "project")
  await mkdir(disabledProject, { recursive: true })
  initializeTestRepository(disabledProject, disabled.env)
  await mkdir(path.join(disabled.configHome, "opencode", "plugins"), { recursive: true })
  await writeFile(path.join(disabled.configHome, "opencode", "opencode.json"), await readFile(path.join(globalConfigDir, "opencode.json"), "utf8"))
  await writeFile(path.join(disabled.configHome, "opencode", "plugins", "global-marker.js"), await readFile(globalLocalPlugin, "utf8"))
  await mkdir(path.join(disabled.home, ".opencode", "plugins"), { recursive: true })
  await writeFile(path.join(disabled.home, ".opencode", "plugins", "home-marker.js"), await readFile(homeLocalPlugin, "utf8"))
  await writeFile(path.join(disabledProject, "opencode.json"), await readFile(path.join(project, "opencode.json"), "utf8"))
  await withServer(binary, disabledProject, disabled.env, async ({ client }) => {
    const config = await client.config.get({ query: { directory: disabledProject } })
    assert.equal(config.data?.model, "openai/profile-smoke", "Disabling project config skipped the profile config hook")
    assert.equal(config.data?.username, "PROFILE_HOOK_MARKER", "Project config or project plugin leaked into the disabled profile")
    assert.equal("projectSmoke" in (config.data?.mcp ?? {}), false, "Project MCP leaked into a no-project-config instance")
    assert.equal("globalSmoke" in (config.data?.mcp ?? {}), true, "Global MCP config was unexpectedly lost")
    assert.equal(await readFile(disabled.env.OPENCODE_PROFILE_SMOKE_GLOBAL_MARKER, "utf8"), "global plugin loaded")
    assert.equal(await readFile(disabled.env.OPENCODE_PROFILE_SMOKE_HOME_MARKER, "utf8"), disabled.home, "The project-config-disabled profile did not retain its selected global home")
    await assert.rejects(readFile(disabled.env.OPENCODE_PROFILE_SMOKE_PROJECT_MARKER, "utf8"))
  })

  const raw = store.profiles.find((profile) => profile.id === "raw")
  assert.ok(raw, "The built-in raw profile is missing")
  const rawEffective = resolveEffectiveProfile("raw", new Map(store.profiles.map((profile) => [profile.id, profile])), store.index)
  const launch = await materializeIsolatedLaunch({ profile: rawEffective, storeRoot: profileRoot, managerSpec, env: paths.env })
  const rawRoot = path.join(root, "raw-run")
  const rawEnv = { ...paths.env, ...launch.environment, OPENCODE_PROFILE_SMOKE_PROJECT_MARKER: path.join(rawRoot, "project-hook.marker"), OPENCODE_PROFILE_SMOKE_GLOBAL_MARKER: path.join(rawRoot, "global-plugin.marker"), OPENCODE_PROFILE_SMOKE_HOME_MARKER: path.join(rawRoot, "home-plugin.marker") }
  const rawProject = path.join(rawRoot, "project")
  await mkdir(rawProject, { recursive: true })
  initializeTestRepository(rawProject, rawEnv)
  await writeFile(path.join(rawProject, "opencode.json"), await readFile(path.join(project, "opencode.json"), "utf8"))
  await withServer(binary, rawProject, rawEnv, async ({ client, baseUrl }) => {
    const config = await client.config.get({ query: { directory: rawProject } })
    assert.equal(config.error, undefined)
    assert.equal(config.data?.username === "GLOBAL_CONFIG_MARKER" || config.data?.username === "PROJECT_CONFIG_MARKER", false, "Global or project config leaked into isolated raw")
    assert.equal(Object.keys(config.data?.mcp ?? {}).length, 0, "MCP configuration leaked into isolated raw")
    const v2 = createV2Client({ baseUrl, directory: rawProject })
    const skills = await v2.v2.skill.list({ location: { directory: rawProject } })
    const names = skills.data?.data?.map((skill) => skill.name) ?? []
    assert.equal(names.includes("global-smoke-skill"), false, "Global skill leaked into isolated raw")
    assert.equal(names.includes("project-smoke-skill"), false, "Project skill leaked into isolated raw")
    await assert.rejects(readFile(rawEnv.OPENCODE_PROFILE_SMOKE_GLOBAL_MARKER, "utf8"))
    await assert.rejects(readFile(rawEnv.OPENCODE_PROFILE_SMOKE_HOME_MARKER, "utf8"))
    await assert.rejects(readFile(rawEnv.OPENCODE_PROFILE_SMOKE_PROJECT_MARKER, "utf8"))
  })
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-profile-stable-smoke-"))
  let binary
  try {
    const baseEnv = safeEnv(path.join(temp, "installer"))
    await Promise.all([baseEnv.home, baseEnv.configHome, baseEnv.dataHome, baseEnv.cacheHome, baseEnv.stateHome, baseEnv.localHome].map((dir) => mkdir(dir, { recursive: true })))
    binary = await findOpenCodeBinary(baseEnv.env)
    const version = runSync(binary, ["--version"], { timeout: 30_000 })
    assert.equal(version.status, 0, `Could not run OpenCode: ${String(version.stderr).slice(-400)}`)
    assert.match(String(version.stdout), /1\.18\.32/, `Expected OpenCode 1.18.32, got ${String(version.stdout).trim()}`)
    await testGitHubInstall(binary, path.join(temp, "github-install"))
    await testServerProfileAndInstanceDispose(binary, path.join(temp, "server"))
    console.log("STABLE_11832_SMOKE_PASSED")
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

async function findOpenCodeBinary(env) {
  if (env.OPENCODE_BINARY) return env.OPENCODE_BINARY
  const folders = new Set([...(env.PATH ?? "").split(path.delimiter), ...(process.env.PATH ?? "").split(path.delimiter)].filter(Boolean))
  if (process.platform === "win32") folders.add(path.join(os.homedir(), "AppData", "Roaming", "npm"))
  for (const folder of folders) {
    const direct = path.join(folder, process.platform === "win32" ? "opencode.exe" : "opencode")
    try { await access(direct); return direct } catch {}
    if (process.platform === "win32") {
      const npmShim = path.join(folder, "opencode.cmd")
      try { await access(npmShim) } catch { continue }
      const npmExe = path.join(folder, "node_modules", "opencode-ai", "bin", "opencode.exe")
      try { await access(npmExe); return npmExe } catch {}
    }
  }
  throw new Error("Could not locate the installed OpenCode binary")
}

await main().catch((error) => {
  console.error(`Stable smoke failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 1200)}`)
  process.exitCode = 1
})
