import { randomUUID } from "node:crypto"
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import { BASE_PROFILE_ID, RAW_PROFILE_ID, type PluginReference, type ProfileDefinition, type ProfileIndex, type ProfileStoreSnapshot } from "./types.ts"
import { createRawProfile } from "./profiles.ts"
import { parseProfile, ProfileValidationError } from "./validation.ts"

const INDEX_FILE = "index.json"
const PROFILE_FILE = "profile.json"
const LOCK_FILE = ".profile-manager.lock"
const LOCK_WAIT_MS = 5000
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export class ProfileStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ProfileStoreError"
  }
}

export function profileStoreRoot(configDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const requested = env.OPENCODE_PROFILE_STORE_DIR
  return path.resolve(requested && requested.trim() ? requested : path.join(configDir, "profiles"))
}

export function profileDir(root: string, id: string): string {
  return path.join(root, id)
}

export function profileManifestPath(root: string, id: string): string {
  return path.join(profileDir(root, id), PROFILE_FILE)
}

export function profileIndexPath(root: string): string {
  return path.join(root, INDEX_FILE)
}

async function removeOwnedDirectory(directory: string): Promise<void> {
  const details = await lstat(directory).catch(() => undefined)
  if (!details) return
  if (details.isDirectory() && !details.isSymbolicLink()) {
    await rm(directory, { recursive: true, force: true })
    return
  }
  await rm(directory, { force: true })
}

export function newProfileIndex(input: {
  managerSpec: string
  baseServerPlugins?: PluginReference[]
  baseTuiPlugins?: PluginReference[]
  now?: number
}): ProfileIndex {
  const now = input.now ?? Date.now()
  return {
    schemaVersion: 1,
    revision: 1,
    activeProfileId: "base",
    previousProfileId: null,
    pendingProfileId: null,
    profileIds: [],
    baseServerPlugins: input.baseServerPlugins ?? [],
    baseTuiPlugins: input.baseTuiPlugins ?? [],
    lastAppliedServerPlugins: null,
    managerSpec: input.managerSpec,
    updatedAt: now,
  }
}

function parseIndex(value: unknown): ProfileIndex {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ProfileStoreError("Profile index is not an object")
  const item = value as Record<string, unknown>
  if (item.schemaVersion !== 1) throw new ProfileStoreError(`Unsupported profile index version: ${String(item.schemaVersion)}`)
  if (!Number.isInteger(item.revision) || typeof item.revision !== "number") throw new ProfileStoreError("Profile index revision is invalid")
  if (typeof item.activeProfileId !== "string" || !Array.isArray(item.profileIds)) throw new ProfileStoreError("Profile index fields are invalid")
  if (!Array.isArray(item.baseServerPlugins) || !Array.isArray(item.baseTuiPlugins)) throw new ProfileStoreError("Profile index plugin baselines are invalid")
  if (typeof item.managerSpec !== "string" || !item.managerSpec.trim()) throw new ProfileStoreError("Profile manager source is missing")
  const profileIds = item.profileIds.map((id) => {
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new ProfileStoreError("Profile index contains an invalid id")
    return id
  })
  if (new Set(profileIds).size !== profileIds.length) throw new ProfileStoreError("Profile index contains duplicate ids")
  const readReferences = (raw: unknown, field: string): PluginReference[] => {
    if (!Array.isArray(raw)) throw new ProfileStoreError(`${field} must be an array`)
    return raw.map((entry) => {
      const ref = typeof entry === "string" ? { spec: entry } : entry
      if (typeof ref !== "object" || ref === null || Array.isArray(ref) || typeof (ref as { spec?: unknown }).spec !== "string") {
        throw new ProfileStoreError(`${field} contains an invalid plugin reference`)
      }
      const spec = (ref as { spec: string }).spec.trim()
      if (!spec || spec.length > 2048 || /[\r\n\0]/.test(spec)) throw new ProfileStoreError(`${field} contains an invalid plugin spec`)
      return { ...(ref as PluginReference), spec }
    })
  }
  return {
    schemaVersion: 1,
    revision: item.revision,
    activeProfileId: item.activeProfileId,
    previousProfileId: typeof item.previousProfileId === "string" ? item.previousProfileId : null,
    pendingProfileId: typeof item.pendingProfileId === "string" ? item.pendingProfileId : null,
    profileIds,
    baseServerPlugins: readReferences(item.baseServerPlugins, "baseServerPlugins"),
    baseTuiPlugins: readReferences(item.baseTuiPlugins, "baseTuiPlugins"),
    lastAppliedServerPlugins: item.lastAppliedServerPlugins === null || item.lastAppliedServerPlugins === undefined
      ? null
      : readReferences(item.lastAppliedServerPlugins, "lastAppliedServerPlugins"),
    managerSpec: item.managerSpec,
    updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now(),
  }
}

async function readIndexUnlocked(root: string): Promise<ProfileIndex | undefined> {
  try {
    const text = await readFile(profileIndexPath(root), "utf8")
    return parseIndex(JSON.parse(text))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    if (error instanceof ProfileStoreError) throw error
    throw new ProfileStoreError("Profile index is unreadable; it was left untouched", { cause: error })
  }
}

async function writeAtomic(file: string, contents: string): Promise<void> {
  const directory = path.dirname(file)
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`)
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(contents, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export { writeAtomic as writeProfileFileAtomically }

async function writeIndexUnlocked(root: string, index: ProfileIndex): Promise<ProfileIndex> {
  const next = { ...index, revision: index.revision + 1, updatedAt: Date.now() }
  await writeAtomic(profileIndexPath(root), `${JSON.stringify(next, null, 2)}\n`)
  return next
}

function profileConfigProjection(profile: ProfileDefinition, directory: string): string {
  const config = structuredClone(profile.config) as Record<string, unknown>
  delete config.plugin
  if (config.skills && typeof config.skills === "object" && !Array.isArray(config.skills)) {
    const skills = config.skills as Record<string, unknown>
    if (Array.isArray(skills.paths)) {
      skills.paths = skills.paths.map((item) => typeof item === "string" && !path.isAbsolute(item) && !item.startsWith("~/") ? path.resolve(directory, item) : item)
    }
  }
  return `${JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }, null, 2)}\n`
}

async function writeProfileFiles(root: string, profile: ProfileDefinition): Promise<void> {
  const directory = profileDir(root, profile.id)
  await mkdir(directory, { recursive: true })
  await writeAtomic(profileManifestPath(root, profile.id), `${JSON.stringify(profile, null, 2)}\n`)
  await writeAtomic(path.join(directory, "opencode.json"), profileConfigProjection(profile, directory))
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function acquireLock(root: string): Promise<() => Promise<void>> {
  const file = path.join(root, LOCK_FILE)
  const started = Date.now()
  const token = randomUUID()
  while (Date.now() - started < LOCK_WAIT_MS) {
    try {
      const handle = await open(file, "wx", 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), "utf8")
        await handle.sync()
      } catch (error) {
        await handle.close().catch(() => undefined)
        await rm(file, { force: true }).catch(() => undefined)
        throw error
      }
      return async () => {
        await handle.close().catch(() => undefined)
        try {
          const contents = JSON.parse(await readFile(file, "utf8")) as { token?: string }
          if (contents.token === token) await rm(file, { force: true })
        } catch {
          // The lock may already have been removed after a process failure.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      try {
        const contents = JSON.parse(await readFile(file, "utf8")) as { pid?: number; createdAt?: number }
        const old = typeof contents.createdAt === "number" && Date.now() - contents.createdAt > 30_000
        if (old && !processIsAlive(Number(contents.pid))) {
          await rm(file, { force: true })
          continue
        }
      } catch {
        const details = await stat(file).catch(() => undefined)
        if (details && Date.now() - details.mtimeMs > 30_000) {
          await rm(file, { force: true }).catch(() => undefined)
          continue
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 35))
    }
  }
  throw new ProfileStoreError("Profile store is busy; no state was changed")
}

async function withLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const release = await acquireLock(root)
  try {
    return await action()
  } finally {
    await release()
  }
}

export async function ensureStore(root: string, initial: {
  managerSpec: string
  baseServerPlugins?: PluginReference[]
  baseTuiPlugins?: PluginReference[]
}): Promise<ProfileStoreSnapshot> {
  await mkdir(root, { recursive: true })
  return withLock(root, async () => {
    let index = await readIndexUnlocked(root)
    if (!index) {
      index = newProfileIndex(initial)
      const raw = createRawProfile()
      await mkdir(profileDir(root, raw.id), { recursive: true })
      await writeProfileFiles(root, raw)
      index.profileIds = [raw.id]
      index = await writeIndexUnlocked(root, index)
    } else if (initial.managerSpec && index.managerSpec !== initial.managerSpec) {
      index = await writeIndexUnlocked(root, { ...index, managerSpec: initial.managerSpec })
    }
    if (!index.profileIds.includes(RAW_PROFILE_ID)) {
      const raw = createRawProfile()
      await mkdir(profileDir(root, raw.id), { recursive: true })
      await writeProfileFiles(root, raw)
      index = await writeIndexUnlocked(root, { ...index, profileIds: [...index.profileIds, raw.id] })
    }
    return readSnapshotUnlocked(root, index)
  })
}

async function readProfileUnlocked(root: string, id: string): Promise<ProfileDefinition> {
  try {
    const text = await readFile(profileManifestPath(root, id), "utf8")
    return parseProfile(JSON.parse(text))
  } catch (error) {
    if (error instanceof ProfileValidationError) throw new ProfileStoreError(`Profile ${id} is invalid: ${error.message}`, { cause: error })
    throw new ProfileStoreError(`Profile ${id} could not be read`, { cause: error })
  }
}

async function readSnapshotUnlocked(root: string, index: ProfileIndex): Promise<ProfileStoreSnapshot> {
  const profiles: ProfileDefinition[] = []
  for (const id of index.profileIds) profiles.push(await readProfileUnlocked(root, id))
  if (index.activeProfileId !== BASE_PROFILE_ID && !profiles.some((profile) => profile.id === index.activeProfileId)) {
    throw new ProfileStoreError(`Active profile ${index.activeProfileId} is missing; index was left untouched`)
  }
  return { index, profiles }
}

export async function readStore(root: string): Promise<ProfileStoreSnapshot> {
  const index = await readIndexUnlocked(root)
  if (!index) throw new ProfileStoreError("Profile store has not been initialized")
  return readSnapshotUnlocked(root, index)
}

export async function createStoredProfile(root: string, profile: ProfileDefinition): Promise<ProfileStoreSnapshot> {
  return withLock(root, async () => {
    const index = await readIndexUnlocked(root)
    if (!index) throw new ProfileStoreError("Profile store has not been initialized")
    if (index.profileIds.includes(profile.id) || profile.id === "base") throw new ProfileStoreError(`Profile ${profile.id} already exists`)
    const folder = profileDir(root, profile.id)
    await mkdir(folder, { recursive: false })
    try {
      await writeProfileFiles(root, profile)
      const next = await writeIndexUnlocked(root, { ...index, profileIds: [...index.profileIds, profile.id] })
      return readSnapshotUnlocked(root, next)
    } catch (error) {
      await rm(folder, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  })
}

export async function updateStoredProfile(root: string, profile: ProfileDefinition): Promise<ProfileStoreSnapshot> {
  return withLock(root, async () => {
    const index = await readIndexUnlocked(root)
    if (!index?.profileIds.includes(profile.id)) throw new ProfileStoreError(`Unknown profile ${profile.id}`)
    const current = await readProfileUnlocked(root, profile.id)
    if (current.builtin) throw new ProfileStoreError("Built-in profiles cannot be edited")
    const validated = parseProfile(profile)
    try {
      await writeProfileFiles(root, validated)
    } catch (error) {
      await writeProfileFiles(root, current).catch(() => undefined)
      throw error
    }
    const next = await writeIndexUnlocked(root, index)
    return readSnapshotUnlocked(root, next)
  })
}

export async function removeStoredProfile(root: string, id: string): Promise<ProfileStoreSnapshot> {
  return withLock(root, async () => {
    const index = await readIndexUnlocked(root)
    if (!index?.profileIds.includes(id)) throw new ProfileStoreError(`Unknown profile ${id}`)
    if (id === RAW_PROFILE_ID) throw new ProfileStoreError("Built-in raw profile cannot be removed")
    if (id === index.activeProfileId || id === index.pendingProfileId) throw new ProfileStoreError("Switch away from this profile before deleting it")
    const profile = await readProfileUnlocked(root, id)
    if (profile.builtin) throw new ProfileStoreError("Built-in profiles cannot be removed")
    const folder = profileDir(root, id)
    const details = await stat(folder)
    if (!details.isDirectory()) throw new ProfileStoreError("Profile path is not a directory")
    const trash = path.join(root, `.deleted-${id}-${randomUUID()}`)
    await rename(folder, trash)
    let next: ProfileIndex
    try {
      next = await writeIndexUnlocked(root, { ...index, profileIds: index.profileIds.filter((profileId) => profileId !== id) })
    } catch (error) {
      await rename(trash, folder).catch(() => undefined)
      throw error
    }
    await rm(trash, { recursive: true, force: false })
    await removeOwnedDirectory(path.join(root, ".launch", id))
    return readSnapshotUnlocked(root, next)
  })
}

export async function setActiveProfile(root: string, id: string): Promise<ProfileStoreSnapshot> {
  return withLock(root, async () => {
    const index = await readIndexUnlocked(root)
    if (!index) throw new ProfileStoreError("Profile store has not been initialized")
    if (id !== "base" && !index.profileIds.includes(id)) throw new ProfileStoreError(`Unknown profile ${id}`)
    const next = await writeIndexUnlocked(root, {
      ...index,
      previousProfileId: index.activeProfileId === id ? index.previousProfileId : index.activeProfileId,
      activeProfileId: id,
      pendingProfileId: null,
    })
    return readSnapshotUnlocked(root, next)
  })
}

export async function setPendingProfile(root: string, id: string): Promise<ProfileStoreSnapshot> {
  return withLock(root, async () => {
    const index = await readIndexUnlocked(root)
    if (!index) throw new ProfileStoreError("Profile store has not been initialized")
    if (!index.profileIds.includes(id)) throw new ProfileStoreError(`Unknown profile ${id}`)
    const next = await writeIndexUnlocked(root, { ...index, pendingProfileId: id })
    return readSnapshotUnlocked(root, next)
  })
}

export async function setManagerSpec(root: string, spec: string): Promise<ProfileStoreSnapshot> {
  return withLock(root, async () => {
    const index = await readIndexUnlocked(root)
    if (!index) throw new ProfileStoreError("Profile store has not been initialized")
    const next = await writeIndexUnlocked(root, { ...index, managerSpec: spec })
    return readSnapshotUnlocked(root, next)
  })
}

export async function updateStoreIndex(
  root: string,
  update: (index: ProfileIndex) => ProfileIndex,
): Promise<ProfileStoreSnapshot> {
  return withLock(root, async () => {
    const index = await readIndexUnlocked(root)
    if (!index) throw new ProfileStoreError("Profile store has not been initialized")
    const next = await writeIndexUnlocked(root, update(index))
    return readSnapshotUnlocked(root, next)
  })
}

export async function writeRuntimeLease(root: string, lease: import("./types.ts").RuntimeLease): Promise<void> {
  if (!RUN_ID_PATTERN.test(lease.runId)) throw new ProfileStoreError("Runtime lease id is invalid")
  const directory = path.join(root, ".runtime")
  await import("node:fs/promises").then(({ mkdir }) => mkdir(directory, { recursive: true }))
  await writeAtomic(path.join(directory, `${lease.runId}.json`), `${JSON.stringify(lease)}\n`)
}

export async function clearRuntimeLease(root: string, runId: string): Promise<void> {
  if (!RUN_ID_PATTERN.test(runId)) throw new ProfileStoreError("Runtime lease id is invalid")
  await rm(path.join(root, ".runtime", `${runId}.json`), { force: true })
}

export async function cleanupAbandonedTemporaries(root: string, currentRunId: string): Promise<string[]> {
  await mkdir(path.join(root, ".runtime"), { recursive: true })
  return withLock(root, async () => {
    const index = await readIndexUnlocked(root)
    if (!index) return []
    const liveRuns = new Set<string>([currentRunId])
    const liveTemporaryProfiles = new Set<string>()
    const runtimeDir = path.join(root, ".runtime")
    for (const file of await readdir(runtimeDir).catch(() => [] as string[])) {
      if (!file.endsWith(".json")) continue
      const leasePath = path.join(runtimeDir, file)
      try {
        const value = JSON.parse(await readFile(leasePath, "utf8")) as Partial<import("./types.ts").RuntimeLease>
        if (typeof value.runId !== "string" || typeof value.pid !== "number") {
          await rm(leasePath, { force: true })
          continue
        }
        if (!processIsAlive(value.pid)) {
          await rm(leasePath, { force: true })
          continue
        }
        liveRuns.add(value.runId)
        if (typeof value.temporaryProfileId === "string") liveTemporaryProfiles.add(value.temporaryProfileId)
      } catch {
        await rm(leasePath, { force: true }).catch(() => undefined)
      }
    }

    const abandoned: string[] = []
    for (const id of index.profileIds) {
      const profile = await readProfileUnlocked(root, id)
      if (!profile.temporary || liveRuns.has(profile.temporary.ownerRunId) || liveTemporaryProfiles.has(id)) continue
      abandoned.push(id)
    }
    if (abandoned.length === 0) return abandoned

    const abandonedSet = new Set(abandoned)
    const next = await writeIndexUnlocked(root, {
      ...index,
      profileIds: index.profileIds.filter((id) => !abandonedSet.has(id)),
      activeProfileId: abandonedSet.has(index.activeProfileId) ? (index.previousProfileId && !abandonedSet.has(index.previousProfileId) ? index.previousProfileId : BASE_PROFILE_ID) : index.activeProfileId,
      previousProfileId: index.previousProfileId && !abandonedSet.has(index.previousProfileId) ? index.previousProfileId : null,
      pendingProfileId: index.pendingProfileId && !abandonedSet.has(index.pendingProfileId) ? index.pendingProfileId : null,
    })
    void next
    for (const id of abandoned) {
      await removeOwnedDirectory(profileDir(root, id))
      await removeOwnedDirectory(path.join(root, ".launch", id))
    }
    return abandoned
  })
}
