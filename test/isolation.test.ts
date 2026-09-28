import { afterAll, describe, expect, test } from "bun:test"
import { profileIsolationReport } from "../src/core/isolation.ts"
import { createRawProfile, createProfile, requiresIsolatedLaunch } from "../src/core/profiles.ts"
import { planProfileSwitch } from "../src/core/diff.ts"
import { newProfileIndex } from "../src/core/store.ts"
import { buildIsolatedLaunchPlan } from "../src/adapters/opencode11832Launch.ts"

let passed = 0
afterAll(() => { if (passed) console.log("ISOLATION_MATRIX_TESTS_PASSED") })

const capabilities = {
  version: "1.18.32",
  supportsTuiPluginToggle: true,
  supportsInstanceDispose: true,
  supportsGlobalConfigUpdate: true,
  supportsProjectConfigToggle: true,
  supportsIsolatedLaunch: true,
  supportsDesktopExtension: false as const,
}

describe("profile isolation and change classification", () => {
  test("raw reports the exact upstream sources that still need separate launch isolation", () => {
    const raw = createRawProfile()
    const report = profileIsolationReport({
      id: raw.id,
      name: raw.name,
      description: raw.description,
      temporary: false,
      isolationMode: raw.isolationMode,
      inheritance: raw.inheritance,
      config: raw.config,
      plugins: { server: [], tui: [] },
      environment: {},
    }, false)
    expect(requiresIsolatedLaunch(raw)).toBe(true)
    expect(report.complete).toBe(false)
    expect(report.entries.find((item) => item.source === "global-config")?.state).toBe("launch-required")
    expect(report.entries.find((item) => item.source === "global-server-plugins")?.state).toBe("launch-required")
    expect(report.entries.find((item) => item.source === "project-config")?.state).toBe("excluded")
    expect(report.entries.find((item) => item.source === "remote-config")?.state).toBe("partial")
    const launched = profileIsolationReport({
      id: raw.id, name: raw.name, description: raw.description, temporary: false,
      isolationMode: raw.isolationMode, inheritance: raw.inheritance, config: raw.config,
      plugins: { server: [], tui: [] }, environment: {},
    }, true)
    expect(launched.entries.find((item) => item.source === "global-config")?.state).toBe("excluded")
    expect(launched.entries.find((item) => item.source === "sessions-auth")?.state).toBe("protected")
    const plan = buildIsolatedLaunchPlan({
      profile: {
        id: raw.id, name: raw.name, description: raw.description, temporary: false,
        isolationMode: raw.isolationMode, inheritance: raw.inheritance, config: raw.config,
        plugins: { server: [], tui: [] }, environment: {},
      },
      storeRoot: "C:\\profiles",
      managerSpec: "opencode-profile-switcher",
      env: { USERPROFILE: "C:\\Users\\owner", APPDATA: "C:\\Users\\owner\\AppData\\Roaming" },
      platform: "win32",
    })
    expect(plan.isolated).toBe(true)
    expect(plan.environment.OPENCODE_TEST_HOME).toBe(plan.home)
    expect(plan.environment.APPDATA).toBe(plan.configHome)
    passed += 1
  })

  test("diff distinguishes live TUI toggles, current instance reload, global plugin reload, and process launch", () => {
    const index = newProfileIndex({ managerSpec: "opencode-profile-switcher" })
    const base = {
      id: "base", name: "Base", description: "", temporary: false, isolationMode: "layered" as const,
      inheritance: createProfile({ id: "sample", name: "Sample" }).inheritance,
      config: {}, plugins: { server: [], tui: [] }, environment: {},
    }
    const live = { ...base, id: "live", plugins: { server: [], tui: [{ spec: "tui-plugin" }] } }
    const instance = { ...base, id: "instance", config: { model: "openai/a" } }
    const global = { ...base, id: "global", plugins: { server: [{ spec: "server-plugin" }], tui: [] } }
    expect(planProfileSwitch({ from: base, to: live, capabilities }).required).toBe("LIVE")
    expect(planProfileSwitch({ from: base, to: instance, capabilities }).required).toBe("INSTANCE_RELOAD")
    expect(planProfileSwitch({ from: base, to: global, capabilities }).required).toBe("GLOBAL_RELOAD")
    expect(planProfileSwitch({ from: base, to: { ...base, id: "raw", isolationMode: "isolated-launch", inheritance: createRawProfile().inheritance }, capabilities }).required).toBe("PROCESS_RESTART")
    expect(index.activeProfileId).toBe("base")
    passed += 1
  })

  test("project skill exclusion requires a launch and reports the project config tradeoff", () => {
    const profile = {
      ...createProfile({ id: "no-project-skills", name: "No project skills", inheritance: { projectSkills: false } }),
      temporary: false,
    }
    const effective = {
      id: profile.id,
      name: profile.name,
      description: profile.description,
      temporary: false,
      isolationMode: profile.isolationMode,
      inheritance: profile.inheritance,
      config: profile.config,
      plugins: profile.plugins,
      environment: profile.environment,
    }
    const beforeLaunch = profileIsolationReport(effective)
    expect(beforeLaunch.entries.find((item) => item.source === "project-skills")?.state).toBe("launch-required")
    const afterLaunch = profileIsolationReport(effective, true)
    expect(afterLaunch.entries.find((item) => item.source === "project-skills")?.state).toBe("excluded")
    expect(afterLaunch.entries.find((item) => item.source === "project-config")?.state).toBe("partial")
    expect(afterLaunch.entries.find((item) => item.source === "agents-commands")?.state).toBe("partial")
    expect(afterLaunch.complete).toBe(false)
    passed += 1
  })
})
