import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { applyProfileConfig } from "../src/server.ts"
import { createProfile, resolveEffectiveProfile } from "../src/core/profiles.ts"
import { defaultInheritance } from "../src/core/validation.ts"

let passed = 0
afterAll(() => { if (passed) console.log("SERVER_PROFILE_TESTS_PASSED") })

describe("stable server config hook", () => {
  test("replaces config fields and disables inherited MCP and skill access", () => {
    const profile = createProfile({
      id: "raw",
      name: "Raw",
      inheritance: { ...defaultInheritance(false), globalConfig: true, globalSkills: false, projectSkills: false, mcp: false },
      config: {
        model: "openai/profile-model",
        mcp: { profileDocs: { type: "remote", url: "https://docs.example", enabled: true } },
        skills: { paths: ["skills"], urls: [] },
      },
    })
    const effective = resolveEffectiveProfile("raw", new Map([["raw", profile]]), {
      schemaVersion: 1,
      revision: 1,
      activeProfileId: "raw",
      previousProfileId: null,
      pendingProfileId: null,
      profileIds: ["raw"],
      baseServerPlugins: [],
      baseTuiPlugins: [],
      lastAppliedServerPlugins: null,
      managerSpec: "opencode-profile-switcher",
      updatedAt: Date.now(),
    })
    const config: any = {
      model: "old-model",
      mcp: { inheritedDocs: { type: "remote", url: "https://old.example", enabled: true } },
      skills: { paths: ["global-skills"], urls: ["https://skills.example"] },
      tools: { skill: true },
      permission: { skill: "allow" },
    }
    applyProfileConfig(config, effective, "C:\\profiles\\raw")
    expect(config.model).toBe("openai/profile-model")
    expect(config.mcp.inheritedDocs.enabled).toBe(false)
    expect(config.mcp.profileDocs.enabled).toBe(true)
    expect(config.tools.skill).toBe(false)
    expect(config.permission.skill).toBe("deny")
    expect(config.skills.paths).toEqual([path.resolve("C:\\profiles\\raw", "skills")])
    expect(config.skills.urls).toEqual([])
    passed += 1
  })
})
