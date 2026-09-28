import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createProfile } from "../src/core/profiles.ts"
import { cleanupAbandonedTemporaries, createStoredProfile, ensureStore, readStore, setActiveProfile, writeRuntimeLease } from "../src/core/store.ts"

let passed = 0
afterAll(() => { if (passed) console.log("EPHEMERAL_PROFILE_TESTS_PASSED") })

describe("temporary profile lifecycle", () => {
  test("crash recovery removes orphaned temporary config and keeps shared caches", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-profile-temp-"))
    const sharedCache = `${root}-cache`
    await Bun.write(path.join(sharedCache), "shared")
    try {
      await ensureStore(root, { managerSpec: "opencode-profile-switcher" })
      const temp = createProfile({
        id: "tmp-crashed",
        name: "Experiment",
        temporary: { createdAt: Date.now(), ownerRunId: "crashed-run" },
      })
      await createStoredProfile(root, temp)
      const abandonedLaunch = path.join(root, ".launch", temp.id, "xdg-config", "opencode", "opencode.json")
      await mkdir(path.dirname(abandonedLaunch), { recursive: true })
      await writeFile(abandonedLaunch, "temporary config", "utf8")
      await setActiveProfile(root, temp.id)
      const removed = await cleanupAbandonedTemporaries(root, "new-run")
      expect(removed).toEqual([temp.id])
      const store = await readStore(root)
      expect(store.index.activeProfileId).toBe("base")
      expect(store.profiles.some((profile) => profile.id === temp.id)).toBe(false)
      await expect(readFile(abandonedLaunch, "utf8")).rejects.toThrow()
      expect(await Bun.file(path.join(sharedCache)).text()).toBe("shared")
      passed += 1
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(sharedCache, { force: true })
    }
  })

  test("a live runtime lease protects its temporary profile from another process", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-profile-live-temp-"))
    try {
      await ensureStore(root, { managerSpec: "opencode-profile-switcher" })
      const temp = createProfile({ id: "tmp-live", name: "Live", temporary: { createdAt: Date.now(), ownerRunId: "live-run" } })
      await createStoredProfile(root, temp)
      await writeRuntimeLease(root, { runId: "live-run", pid: process.pid, updatedAt: Date.now(), temporaryProfileId: temp.id })
      expect(await cleanupAbandonedTemporaries(root, "other-run")).toEqual([])
      expect((await readStore(root)).profiles.some((profile) => profile.id === temp.id)).toBe(true)
      passed += 1
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects runtime lease ids that could escape the lease directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-profile-lease-id-"))
    try {
      await expect(writeRuntimeLease(root, { runId: "../outside", pid: process.pid, updatedAt: Date.now(), temporaryProfileId: null })).rejects.toThrow("Runtime lease id is invalid")
      expect(await Bun.file(path.join(root, "outside.json")).exists()).toBe(false)
      passed += 1
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
