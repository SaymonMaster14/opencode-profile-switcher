import { afterAll, describe, expect, test } from "bun:test"
import { buildProfilePickerOptions, pluginMetadataDescription } from "../src/core/picker.ts"
import { createProfile } from "../src/core/profiles.ts"
import { defaultInheritance } from "../src/core/validation.ts"
import { reconcileTuiPlugins } from "../src/adapters/tui11832.ts"
import { profileIsolationReport } from "../src/core/isolation.ts"
import { baseProfile } from "../src/core/profiles.ts"
import type { TuiPluginStatus } from "@opencode-ai/plugin/tui"
import type { TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createStoredProfile, ensureStore, readStore } from "../src/core/store.ts"
import { tui } from "../src/tui.ts"
import { pluginConfigMatches } from "../src/adapters/opencode11832.ts"

let passed = 0
afterAll(() => { if (passed) console.log("TUI_PROFILE_TESTS_PASSED") })

describe("stable TUI profile controls", () => {
  test("selector describes active, temporary, plugin, skill, MCP and restart state", () => {
    const index = {
      schemaVersion: 1 as const, revision: 1, activeProfileId: "base", previousProfileId: null, pendingProfileId: null,
      profileIds: ["work"], baseServerPlugins: [], baseTuiPlugins: [], lastAppliedServerPlugins: null,
      managerSpec: "opencode-profile-switcher", updatedAt: 0,
    }
    const work = createProfile({
      id: "work", name: "Work", description: "client setup",
      config: { skills: { paths: ["./skills"], urls: [] }, mcp: { docs: { type: "remote", url: "https://example.test" } } },
      plugins: { server: [{ spec: "server-plugin", name: "Server plugin" }], tui: [{ spec: "tui-plugin", name: "TUI plugin" }] },
    })
    const base = baseProfile(index)
    const options = buildProfilePickerOptions({
      profiles: [base, { ...base, id: work.id, name: work.name, description: work.description, plugins: work.plugins, config: work.config, inheritance: { ...defaultInheritance(false), ...work.inheritance }, temporary: true }],
      activeId: "work",
      isolation: (profile) => profileIsolationReport(profile),
      restart: (profile) => profile.id === "work" ? { kind: "INSTANCE_RELOAD", area: "config", reason: "server overlay" } : undefined,
      hasPrevious: true,
    })
    const workOption = options.find((option) => option.value.kind === "profile" && option.value.id === "work")
    expect(workOption?.title).toContain("✓ Work [temporary]")
    expect(workOption?.description).toContain("Server plugin")
    expect(workOption?.description).toContain("TUI plugin")
    expect(workOption?.description).toContain("skills inherited")
    expect(workOption?.description).toContain("1 profile MCP")
    expect(workOption?.description).toContain("instance reload")
    expect(options.some((option) => option.value.kind === "action" && option.value.id === "temporary")).toBe(true)
    expect(options.some((option) => option.value.kind === "action" && option.value.id === "plugins")).toBe(true)
    passed += 1
  })

  test("plugin inspector text includes author, purpose, origin, revision, and runtime state", () => {
    const summary = pluginMetadataDescription({
      plugin: {
        spec: "github:author/repo#0123456789012345678901234567890123456789",
        name: "Review helper",
        description: "Reviews a code change.",
        author: "Ada",
        source: "github",
        commit: "0123456789012345678901234567890123456789",
        repository: "https://github.com/author/repo",
      },
      kind: "tui",
      installed: true,
      active: false,
    })
    expect(summary).toContain("Reviews a code change.")
    expect(summary).toContain("Creator: Ada")
    expect(summary).toContain("Origin: github")
    expect(summary).toContain("commit 0123456789012345678901234567890123456789")
    expect(summary).toContain("Installed: yes")
    expect(summary).toContain("inactive in TUI runtime")
    passed += 1
  })

  test("live reconciliation toggles only the target TUI set and can roll back", async () => {
    const statuses: TuiPluginStatus[] = [
      { id: "opencode-profile-switcher", source: "npm", spec: "manager", target: "manager", enabled: true, active: true },
      { id: "internal:home-footer", source: "internal", spec: "internal:home-footer", target: "internal:home-footer", enabled: true, active: true },
      { id: "old", source: "npm", spec: "old-package", target: "old", enabled: true, active: true },
      { id: "new", source: "npm", spec: "new-package", target: "new", enabled: true, active: false },
    ]
    const control = {
      list: () => statuses,
      activate: async (id: string) => { const row = statuses.find((item) => item.id === id); if (!row) return false; row.active = true; row.enabled = true; return true },
      deactivate: async (id: string) => { const row = statuses.find((item) => item.id === id); if (!row) return false; row.active = false; row.enabled = false; return true },
    }
    const result = await reconcileTuiPlugins({
      control,
      managerId: "opencode-profile-switcher",
      managerSpec: "manager",
      desired: [{ spec: "new-package", id: "new" }],
    })
    expect(result.deactivated).toEqual(["old"])
    expect(result.activated).toEqual(["new"])
    expect(statuses.find((item) => item.id === "opencode-profile-switcher")?.active).toBe(true)
    expect(statuses.find((item) => item.id === "internal:home-footer")?.active).toBe(true)
    await result.rollback()
    expect(statuses.find((item) => item.id === "old")?.active).toBe(true)
    expect(statuses.find((item) => item.id === "new")?.active).toBe(false)
    expect(statuses.find((item) => item.id === "internal:home-footer")?.active).toBe(true)
    passed += 1
  })

  test("registers /profile and creates then switches to a profile through the TUI dialogs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-profile-tui-plugin-"))
    const environmentKeys = ["OPENCODE_PROFILE_STORE_DIR", "OPENCODE_PROFILE_ID", "OPENCODE_PROFILE_LAUNCH", "OPENCODE_DISABLE_PROJECT_CONFIG"]
    const savedEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]))
    for (const key of environmentKeys) delete process.env[key]
    process.env.OPENCODE_PROFILE_STORE_DIR = root
    let commandLayer: any
    let currentDialog: any
    let cleanup: (() => void) | undefined
    const toastMessages: string[] = []
    let serverPlugins: unknown[] = ["manager"]
    let failNextServerUpdate = false
    let disposedInstances = 0
    const statuses: TuiPluginStatus[] = [
      { id: "opencode-profile-switcher", source: "npm", spec: "manager", target: "manager", enabled: true, active: true },
    ]
    const api = {
      app: { version: "1.18.32" },
      state: { path: { config: root }, mcp: () => [] },
      client: {
        global: {
          config: {
            get: async () => ({ data: { plugin: serverPlugins } }),
            update: async ({ config }: { config: { plugin?: unknown[] } }) => {
              if (config.plugin) {
                serverPlugins = config.plugin
                if (failNextServerUpdate && config.plugin.some((entry) => typeof entry === "string" && entry === "server-package")) {
                  failNextServerUpdate = false
                  return { error: "simulated config writeback failure" }
                }
              }
              return { data: { plugin: serverPlugins } }
            },
          },
          dispose: async () => { disposedInstances += 1; return { data: true } },
        },
        instance: { dispose: async () => ({ data: true }) },
        path: { get: async () => ({ data: { config: root } }) },
      },
      plugins: {
        list: () => statuses,
        activate: async (id: string) => { const item = statuses.find((status) => status.id === id); if (item) item.active = true; return Boolean(item) },
        deactivate: async (id: string) => { const item = statuses.find((status) => status.id === id); if (item) item.active = false; return Boolean(item) },
        add: async () => true,
        install: async () => ({ ok: true, dir: root, tui: false }),
      },
      ui: {
        DialogSelect: (props: unknown) => props,
        DialogPrompt: (props: unknown) => props,
        DialogConfirm: (props: unknown) => props,
        dialog: { replace: (render: () => unknown) => { currentDialog = render() }, clear: () => { currentDialog = undefined } },
        toast: (message: { message: string }) => { toastMessages.push(message.message) },
      },
      keymap: { registerLayer: (layer: unknown) => { commandLayer = layer; return () => undefined } },
      slots: { register: () => "profile-slot" },
      lifecycle: { onDispose: (callback: () => void) => { cleanup = callback; return () => undefined } },
    } as unknown as TuiPluginApi
    const waitFor = async (predicate: () => boolean | Promise<boolean>) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await predicate()) return
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error(`Timed out waiting for the TUI action${toastMessages.length ? `: ${toastMessages.join(" | ")}` : ""}`)
    }

    try {
      await ensureStore(root, { managerSpec: "manager", baseServerPlugins: [{ spec: "manager" }], baseTuiPlugins: [{ spec: "manager" }] })
      await createStoredProfile(root, createProfile({
        id: "combined",
        name: "Combined",
        plugins: { server: [{ spec: "server-package" }], tui: [{ spec: "tui-package" }] },
      }))
      await createStoredProfile(root, createProfile({
        id: "failure",
        name: "Failure recovery",
        plugins: { server: [{ spec: "server-package", installedAt: Date.now() }] },
      }))
      await tui(api, undefined, { spec: "manager" } as TuiPluginMeta)
      const command = commandLayer.commands.find((item: { slashName?: string }) => item.slashName === "profile")
      expect(command).toBeDefined()
      command.run()
      await new Promise((resolve) => setTimeout(resolve, 10))
      const picker = currentDialog as { options: Array<{ value: { kind: string; id: string }; description?: string; onSelect?: (option: unknown) => void }>; onSelect?: (option: unknown) => void }
      const combined = picker.options.find((item) => item.value.kind === "profile" && item.value.id === "combined")
      expect(combined?.description).toContain("switch: global reload")
      const create = picker.options.find((item) => item.value.kind === "action" && item.value.id === "create")
      expect(create).toBeDefined()
      await picker.onSelect?.(create)
      ;(currentDialog as { onConfirm: (value: string) => void }).onConfirm("Work")
      ;(currentDialog as { onConfirm: (value: string) => void }).onConfirm("Work profile")
      await waitFor(async () => (await readStore(root)).profiles.some((profile) => profile.id === "work"))
      await waitFor(() => Boolean(currentDialog?.options))
      const createdPicker = currentDialog as { options: Array<{ value: { kind: string; id: string } }>; onSelect?: (option: unknown) => void }
      const work = createdPicker.options.find((item) => item.value.kind === "profile" && item.value.id === "work")
      expect(work).toBeDefined()
      const baseline = (await readStore(root)).index.baseServerPlugins
      expect(baseline.map((item) => item.spec)).toEqual(["manager"])
      expect((await readStore(root)).index.lastAppliedServerPlugins).toBeNull()
      expect(pluginConfigMatches(serverPlugins, baseline)).toBe(true)
    expect(pluginConfigMatches(baseline, baseline)).toBe(true)
    expect(pluginConfigMatches([{ spec: "plugin", options: { enabled: true } }], [{ spec: "plugin", options: { enabled: true } }])).toBe(true)
    expect(pluginConfigMatches([{ spec: "plugin", options: { enabled: false } }], [{ spec: "plugin", options: { enabled: true } }])).toBe(false)
      await createdPicker.onSelect?.(work)
      await waitFor(async () => (await readStore(root)).index.activeProfileId === "work")
      expect((await readStore(root)).index.activeProfileId).toBe("work")

      command.run()
      await waitFor(() => Boolean(currentDialog?.options))
      const activePicker = currentDialog as { options: Array<{ value: { kind: string; id: string } }>; onSelect?: (option: unknown) => void }
      const failure = activePicker.options.find((item) => item.value.kind === "profile" && item.value.id === "failure")
      expect(failure).toBeDefined()
      failNextServerUpdate = true
      await activePicker.onSelect?.(failure)
      await waitFor(() => Boolean(currentDialog?.onConfirm))
      ;(currentDialog as { onConfirm: () => void }).onConfirm()
      await waitFor(() => toastMessages.some((message) => message.includes("switch rolled back")))
      expect(serverPlugins).toEqual(["manager"])
      expect((await readStore(root)).index.activeProfileId).toBe("work")
      expect(disposedInstances).toBe(1)
      passed += 1
    } finally {
      cleanup?.()
      for (const key of environmentKeys) {
        const value = savedEnvironment[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(root, { recursive: true, force: true })
    }
  })
})
