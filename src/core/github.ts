import type { JsonObject, PluginReference } from "./types.ts"

const API = "https://api.github.com"
const MAX_TEXT_BYTES = 1024 * 1024

export interface GitHubPluginSpec {
  owner: string
  repo: string
  ref?: string
  subdirectory?: string
}

export interface DiscoveredGitHubPlugin {
  reference: PluginReference
  serverReference: PluginReference
  tuiReference: PluginReference
  packageName: string
  version?: string
  defaultBranch: string
  commit: string
  readmeSummary: string
  hasServer: boolean
  hasTui: boolean
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

function validSegment(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== ".."
}

export function parseGitHubPluginSpec(spec: string): GitHubPluginSpec {
  const raw = spec.trim()
  let ownerRepo: string
  let ref: string | undefined
  let subdirectory: string | undefined

  if (raw.startsWith("github:")) {
    const tail = raw.slice("github:".length)
    const pathMarker = tail.indexOf("::path:")
    const target = pathMarker === -1 ? tail : tail.slice(0, pathMarker)
    if (pathMarker !== -1) subdirectory = tail.slice(pathMarker + "::path:".length)
    const hash = target.indexOf("#")
    ownerRepo = hash === -1 ? target : target.slice(0, hash)
    ref = hash === -1 ? undefined : decodeURIComponent(target.slice(hash + 1))
  } else if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#.*)?$/.test(raw)) {
    const hash = raw.indexOf("#")
    ownerRepo = hash === -1 ? raw : raw.slice(0, hash)
    ref = hash === -1 ? undefined : decodeURIComponent(raw.slice(hash + 1))
  } else {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new Error("Use a GitHub plugin source such as github:owner/repository#ref")
    }
    if (url.hostname.toLowerCase() !== "github.com") throw new Error("Only github.com plugin sources are supported")
    ownerRepo = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "")
    ref = url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined
  }

  const [owner, repo, ...extra] = ownerRepo.split("/")
  if (!owner || !repo || extra.length || !validSegment(owner) || !validSegment(repo)) {
    throw new Error("GitHub source must name exactly one owner and repository")
  }
  if (subdirectory !== undefined) {
    const normalized = subdirectory.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")
    if (!normalized || normalized.split("/").some((part) => !validSegment(part))) {
      throw new Error("GitHub package subdirectory is invalid")
    }
    subdirectory = normalized
  }
  if (ref !== undefined && (!ref.trim() || ref.length > 256 || /[\r\n\0]/.test(ref))) {
    throw new Error("GitHub ref is invalid")
  }
  return { owner, repo, ...(ref ? { ref } : {}), ...(subdirectory ? { subdirectory } : {}) }
}

async function getJson(fetcher: FetchLike, url: string): Promise<Record<string, unknown>> {
  const response = await fetcher(url, { headers: { accept: "application/vnd.github+json", "user-agent": "opencode-profile-switcher" } })
  if (!response.ok) throw new Error(`GitHub request failed (${response.status}): ${url}`)
  const text = await response.text()
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) throw new Error("GitHub metadata response is too large")
  const value: unknown = JSON.parse(text)
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("GitHub returned an invalid metadata response")
  return value as Record<string, unknown>
}

async function getText(fetcher: FetchLike, url: string): Promise<string | undefined> {
  const response = await fetcher(url, { headers: { "user-agent": "opencode-profile-switcher" } })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`GitHub content request failed (${response.status}): ${url}`)
  const text = await response.text()
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) throw new Error("GitHub content response is too large")
  return text
}

function authorName(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim()
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const name = (value as Record<string, unknown>).name
    if (typeof name === "string" && name.trim()) return name.trim()
  }
}

function readmeSummary(readme: string | undefined): string {
  if (!readme) return ""
  const cleaned = readme
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/^\s*#+\s+.*$/gm, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[[^\]]+\]\(([^)]+)\)/g, "$1")
    .replace(/[*_>#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return cleaned.slice(0, 500)
}

export async function discoverGitHubPlugin(spec: string, fetcher: FetchLike = fetch): Promise<DiscoveredGitHubPlugin> {
  const parsed = parseGitHubPluginSpec(spec)
  const repositoryUrl = `${API}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`
  const repository = await getJson(fetcher, repositoryUrl)
  const defaultBranch = typeof repository.default_branch === "string" ? repository.default_branch : "main"
  const ref = parsed.ref ?? defaultBranch
  const commitInfo = await getJson(fetcher, `${repositoryUrl}/commits/${encodeURIComponent(ref)}`)
  const commitData = commitInfo.sha
  if (typeof commitData !== "string" || !/^[0-9a-f]{40}$/i.test(commitData)) throw new Error("GitHub did not return a full commit SHA")
  const commit = commitData.toLowerCase()
  const contentRoot = parsed.subdirectory ? `${parsed.subdirectory}/` : ""
  const rawBase = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${commit}/${contentRoot}`
  const manifestText = await getText(fetcher, `${rawBase}package.json`)
  if (!manifestText) throw new Error("This GitHub repository has no package.json at the selected path")
  let manifest: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(manifestText)
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object")
    manifest = value as Record<string, unknown>
  } catch (error) {
    throw new Error(`Plugin package.json is invalid: ${(error as Error).message}`)
  }

  const exports = typeof manifest.exports === "object" && manifest.exports !== null
    ? manifest.exports as Record<string, unknown>
    : {}
  const rootEntry = exports["."]
  const hasServer = Object.hasOwn(exports, "./server") || typeof manifest.main === "string" || typeof rootEntry === "string"
  const hasTui = Object.hasOwn(exports, "./tui")
  const packageName = typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : parsed.repo
  const description = typeof manifest.description === "string" ? manifest.description.trim() : ""
  const repoOwner = typeof repository.owner === "object" && repository.owner !== null
    ? (repository.owner as Record<string, unknown>).login
    : undefined
  const repoDescription = typeof repository.description === "string" ? repository.description.trim() : ""
  const readme = await getText(fetcher, `${rawBase}README.md`)
  const author = authorName(manifest.author) ?? (typeof repoOwner === "string" ? repoOwner : parsed.owner)
  const pinnedSpec = `github:${parsed.owner}/${parsed.repo}#${commit}${parsed.subdirectory ? `::path:${parsed.subdirectory}` : ""}`
  const exportOptions = (entry: unknown): JsonObject | undefined => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined
    const config = (entry as Record<string, unknown>).config
    return typeof config === "object" && config !== null && !Array.isArray(config) ? config as JsonObject : undefined
  }
  const common = {
    name: packageName,
    description: description || repoDescription || readmeSummary(readme),
    author,
    source: "github" as const,
    ...(typeof manifest.version === "string" ? { version: manifest.version } : {}),
    commit,
    repository: `https://github.com/${parsed.owner}/${parsed.repo}`,
    hasServer,
    hasTui,
  }
  const serverReference: PluginReference = {
    spec: pinnedSpec,
    ...common,
    ...(exportOptions(exports["./server"] ?? rootEntry) ? { options: exportOptions(exports["./server"] ?? rootEntry) } : {}),
  }
  const tuiReference: PluginReference = {
    spec: pinnedSpec,
    ...common,
    ...(exportOptions(exports["./tui"]) ? { options: exportOptions(exports["./tui"]) } : {}),
  }

  return {
    packageName,
    ...(typeof manifest.version === "string" ? { version: manifest.version } : {}),
    defaultBranch,
    commit,
    readmeSummary: readmeSummary(readme),
    hasServer,
    hasTui,
    reference: serverReference,
    serverReference,
    tuiReference,
  }
}
