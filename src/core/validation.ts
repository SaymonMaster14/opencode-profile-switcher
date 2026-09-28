import {
  BASE_PROFILE_ID,
  type InheritancePolicy,
  type JsonObject,
  type JsonValue,
  type PluginKind,
  type PluginReference,
  type ProfileDefinition,
} from "./types.ts"

const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"])
const MAX_PROFILE_BYTES = 2 * 1024 * 1024

export class ProfileValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProfileValidationError"
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 40) return false
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1))
  if (!isRecord(value)) return false
  return Object.entries(value).every(([key, item]) => !FORBIDDEN_KEYS.has(key) && isJsonValue(item, depth + 1))
}

export function parseJsonObject(value: unknown, field: string): JsonObject {
  if (!isRecord(value) || !isJsonValue(value)) throw new ProfileValidationError(`${field} must be a JSON object`)
  return value as JsonObject
}

export function normalizeProfileId(value: string): string {
  const id = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._ -]/g, "")
    .trim()
    .replace(/[ .]+/g, "-")
    .replace(/-+/g, "-")
  if (!PROFILE_ID.test(id) || id === BASE_PROFILE_ID) {
    throw new ProfileValidationError("Profile id must use 1-64 lowercase letters, numbers, dots, underscores, or hyphens")
  }
  return id
}

function pluginReference(value: unknown, kind: PluginKind): PluginReference {
  const input = typeof value === "string" ? { spec: value } : value
  if (!isRecord(input) || typeof input.spec !== "string") {
    throw new ProfileValidationError(`${kind} plugin entries need a spec string`)
  }
  const spec = input.spec.trim()
  if (!spec || spec.length > 2048 || /[\r\n\0]/.test(spec)) {
    throw new ProfileValidationError(`${kind} plugin spec is empty or invalid`)
  }
  const output: PluginReference = { spec }
  if (input.options !== undefined) output.options = parseJsonObject(input.options, `${kind} plugin options`)
  for (const key of ["id", "name", "description", "author", "version", "commit", "repository"] as const) {
    const field = input[key]
    if (field !== undefined) {
      if (typeof field !== "string" || field.length > 4096) {
        throw new ProfileValidationError(`${kind} plugin ${key} must be a short string`)
      }
      output[key] = field
    }
  }
  if (input.installedAt !== undefined) {
    if (typeof input.installedAt !== "number" || !Number.isFinite(input.installedAt)) {
      throw new ProfileValidationError(`${kind} plugin installedAt must be a timestamp`)
    }
    output.installedAt = input.installedAt
  }
  if (input.source !== undefined) {
    if (!["github", "npm", "file", "unknown"].includes(String(input.source))) {
      throw new ProfileValidationError(`${kind} plugin source is invalid`)
    }
    output.source = input.source as PluginReference["source"]
  }
  for (const key of ["hasServer", "hasTui"] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "boolean") throw new ProfileValidationError(`${kind} plugin ${key} must be boolean`)
      output[key] = input[key] as boolean
    }
  }
  return output
}

function inheritance(value: unknown): InheritancePolicy {
  if (!isRecord(value)) throw new ProfileValidationError("inheritance must be an object")
  const keys: (keyof InheritancePolicy)[] = [
    "globalConfig",
    "projectConfig",
    "globalServerPlugins",
    "projectServerPlugins",
    "globalTuiPlugins",
    "projectTuiPlugins",
    "globalSkills",
    "projectSkills",
    "mcp",
  ]
  const result = {} as InheritancePolicy
  for (const key of keys) {
    if (typeof value[key] !== "boolean") throw new ProfileValidationError(`inheritance.${key} must be boolean`)
    result[key] = value[key] as boolean
  }
  return result
}

export function parseProfile(value: unknown): ProfileDefinition {
  if (!isRecord(value)) throw new ProfileValidationError("Profile must be an object")
  if (typeof value.id !== "string" || !PROFILE_ID.test(value.id) || value.id === BASE_PROFILE_ID) {
    throw new ProfileValidationError("Profile id is invalid")
  }
  if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 100) {
    throw new ProfileValidationError("Profile name must contain 1-100 characters")
  }
  if (typeof value.description !== "string" || value.description.length > 1000) {
    throw new ProfileValidationError("Profile description must be a string of at most 1000 characters")
  }
  if (value.extends !== undefined && (typeof value.extends !== "string" || !PROFILE_ID.test(value.extends))) {
    throw new ProfileValidationError("extends must be a profile id")
  }
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) {
    throw new ProfileValidationError("createdAt must be a timestamp")
  }
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) {
    throw new ProfileValidationError("updatedAt must be a timestamp")
  }
  if (value.isolationMode !== "layered" && value.isolationMode !== "isolated-launch") {
    throw new ProfileValidationError("isolationMode must be layered or isolated-launch")
  }
  if (!isRecord(value.plugins)) throw new ProfileValidationError("plugins must be an object")
  const plugins = {
    server: Array.isArray(value.plugins.server) ? value.plugins.server.map((item) => pluginReference(item, "server")) : [],
    tui: Array.isArray(value.plugins.tui) ? value.plugins.tui.map((item) => pluginReference(item, "tui")) : [],
  }
  if (value.plugins.server !== undefined && !Array.isArray(value.plugins.server)) {
    throw new ProfileValidationError("plugins.server must be an array")
  }
  if (value.plugins.tui !== undefined && !Array.isArray(value.plugins.tui)) {
    throw new ProfileValidationError("plugins.tui must be an array")
  }
  if (!isRecord(value.environment)) throw new ProfileValidationError("environment must be an object")
  const environment: Record<string, string> = {}
  for (const [key, item] of Object.entries(value.environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== "string" || item.length > 8192) {
      throw new ProfileValidationError(`environment.${key} must be a valid variable and string value`)
    }
    if (
      key.startsWith("OPENCODE_PROFILE_") ||
      key.startsWith("XDG_") ||
      ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "OPENCODE_TEST_HOME", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR", "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_DISABLE_EXTERNAL_SKILLS", "OPENCODE_PURE"].includes(key)
    ) {
      throw new ProfileValidationError(`${key} is reserved by the profile manager`)
    }
    environment[key] = item
  }
  let temporary: ProfileDefinition["temporary"]
  if (value.temporary !== undefined) {
    if (!isRecord(value.temporary) || typeof value.temporary.createdAt !== "number" || typeof value.temporary.ownerRunId !== "string") {
      throw new ProfileValidationError("temporary metadata is invalid")
    }
    temporary = { createdAt: value.temporary.createdAt, ownerRunId: value.temporary.ownerRunId }
  }
  if (value.builtin !== undefined && typeof value.builtin !== "boolean") {
    throw new ProfileValidationError("builtin must be boolean")
  }
  const config = parseJsonObject(value.config ?? {}, "config")
  if ("plugin" in config) throw new ProfileValidationError("Use plugins.server and plugins.tui instead of config.plugin")
  return {
    id: value.id,
    name: value.name.trim(),
    description: value.description,
    ...(value.extends !== undefined ? { extends: value.extends } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.builtin === true ? { builtin: true } : {}),
    ...(temporary ? { temporary } : {}),
    isolationMode: value.isolationMode,
    inheritance: inheritance(value.inheritance),
    config,
    plugins,
    environment,
  }
}

export async function parseProfileFile(text: string): Promise<ProfileDefinition> {
  if (Buffer.byteLength(text, "utf8") > MAX_PROFILE_BYTES) throw new ProfileValidationError("Profile file is too large")
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new ProfileValidationError(`Profile JSON is invalid: ${(error as Error).message}`)
  }
  return parseProfile(value)
}

export function defaultInheritance(value = true): InheritancePolicy {
  return {
    globalConfig: value,
    projectConfig: value,
    globalServerPlugins: value,
    projectServerPlugins: value,
    globalTuiPlugins: value,
    projectTuiPlugins: value,
    globalSkills: value,
    projectSkills: value,
    mcp: value,
  }
}
