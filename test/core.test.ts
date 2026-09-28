import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { mergeJson, sameJson } from "../src/core/json.ts"
import { createProfile, resolveEffectiveProfile } from "../src/core/profiles.ts"
import { createStoredProfile, ensureStore, profileIndexPath, readStore, updateStoredProfile } from "../src/core/store.ts"
import { normalizeProfileId, parseProfile } from "../src/core/validation.ts"

let passed = 0
afterAll(() => { if (passed) console.log("CORE_PROFILE_TESTS_PASSED") })

describe("profile core", () => {
  test("validates safe ids and rejects plugin injection through the config overlay", () => {
    expect(normalizeProfileId("  Déep Work! ")).toBe("deep-work")
    expect(() => normalizeProfileId("../escape")).toThrow()
    const profile = createProfile({ id: "work", name: "Work", config: { model: "openai/test" } })
    expect(() => parseProfile({ ...profile, config: { plugin: ["unreviewed"] } })).toThrow("Use plugins.server and plugins.tui")
    expect(() => parseProfile({ ...profile, environment: { OPENCODE_DISABLE_EXTERNAL_SKILLS: "false" } })).toThrow("reserved by the profile manager")
    expect(() => parseProfile({ ...profile, environment: { OPENCODE_TEST_HOME: "C:\\Users\\shared" } })).toThrow("reserved by the profile manager")
    passed += 1
  })

  test("ships profile examples that satisfy the persisted profile schema", async () => {
    for (const name of ["clean-room.json", "review-workflow.json"]) {
      const text = await readFile(new URL(`../examples/profiles/${name}`, import.meta.url), "utf8")
      expect(() => parseProfile(JSON.parse(text))).not.toThrow()
    }
    passed += 1
  })

  test("merges objects recursively and replaces arrays", () => {
    const merged = mergeJson({ agent: { build: { model: "a", temperature: 0.2 } }, skills: { paths: ["one"] } }, {
      agent: { build: { model: "b" } },
      skills: { paths: ["two"] },
    })
    expect(merged.agent).toEqual({ build: { model: "b", temperature: 0.2 } })
    expect(merged.skills).toEqual({ paths: ["two"] })
    expect(sameJson({ b: 2, a: 1 }, { a: 1, b: 2 })).toBe(true)
    passed += 1
  })

  test("resolves profile inheritance with manager protection and pinned plugin options", () => {
    const index = {
      schemaVersion: 1 as const,
      revision: 1,
      activeProfileId: "base",
      previousProfileId: null,
      pendingProfileId: null,
      profileIds: ["base", "work"],
      baseServerPlugins: [{ spec: "base-plugin" }],
      baseTuiPlugins: [],
      lastAppliedServerPlugins: null,
      managerSpec: "github:owner/profile-manager#0123456789012345678901234567890123456789",
      updatedAt: Date.now(),
    }
    const base = createProfile({ id: "work-parent", name: "Parent", config: { model: "openai/a", agent: { build: { temperature: 0.2 } } } })
    const child = createProfile({
      id: "work",
      name: "Work",
      extends: "work-parent",
      config: { model: "openai/b" },
      plugins: { server: [{ spec: "github:owner/tool#abcdef0123456789abcdef0123456789abcdef01", options: { strict: true } }], tui: [] },
    })
    const resolved = resolveEffectiveProfile("work", new Map([[base.id, base], [child.id, child]]), index)
    expect(resolved.config).toEqual({ model: "openai/b", agent: { build: { temperature: 0.2 } } })
    expect(resolved.plugins.server.map((item) => item.spec)).toEqual([
      "base-plugin",
      "github:owner/tool#abcdef0123456789abcdef0123456789abcdef01",
      "github:owner/profile-manager#0123456789012345678901234567890123456789",
    ])
    expect(resolved.plugins.server[1]?.options).toEqual({ strict: true })
    passed += 1
  })

  test("store writes profiles atomically, seeds raw, and leaves corrupt state untouched", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-profile-core-"))
    try {
      const first = await ensureStore(root, { managerSpec: "opencode-profile-switcher" })
      expect(first.index.activeProfileId).toBe("base")
      expect(first.profiles.map((item) => item.id)).toEqual(["raw"])
      const work = createProfile({ id: "work", name: "Work", config: { model: "openai/work" } })
      await createStoredProfile(root, work)
      const before = await readStore(root)
      expect(before.profiles.some((item) => item.id === "work")).toBe(true)

      const pathToIndex = profileIndexPath(root)
      await writeFile(pathToIndex, "{broken", "utf8")
      await expect(ensureStore(root, { managerSpec: "opencode-profile-switcher" })).rejects.toThrow("left untouched")
      expect(await readFile(pathToIndex, "utf8")).toBe("{broken")
      passed += 1
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("concurrent creates serialize instead of losing a profile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-profile-lock-"))
    try {
      await ensureStore(root, { managerSpec: "opencode-profile-switcher" })
      await Promise.all([
        createStoredProfile(root, createProfile({ id: "alpha", name: "Alpha" })),
        createStoredProfile(root, createProfile({ id: "beta", name: "Beta" })),
      ])
      const state = await readStore(root)
      expect(state.profiles.map((item) => item.id).sort()).toEqual(["alpha", "beta", "raw"])
      passed += 1
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
