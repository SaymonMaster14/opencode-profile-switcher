import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { stableJson } from "../core/json.ts"
import type { JsonObject, PluginReference } from "../core/types.ts"

export type StableClient = TuiPluginApi["client"]

export interface OpenCodeConfig {
  [key: string]: unknown
  plugin?: (string | [string, Record<string, unknown>])[]
}

function dataOrThrow<T>(result: { data?: T; error?: unknown }, operation: string): T {
  if (result.error) throw new Error(`${operation} failed: ${String(result.error)}`)
  if (result.data === undefined) throw new Error(`${operation} returned no data`)
  return result.data
}

export async function readGlobalConfig(client: StableClient): Promise<OpenCodeConfig> {
  return dataOrThrow(await client.global.config.get(), "Reading global OpenCode config") as OpenCodeConfig
}

export async function updateGlobalConfig(client: StableClient, patch: OpenCodeConfig): Promise<OpenCodeConfig> {
  return dataOrThrow(await client.global.config.update({ config: patch as never }), "Updating global OpenCode config") as OpenCodeConfig
}

export async function disposeCurrentInstance(client: StableClient): Promise<void> {
  dataOrThrow(await client.instance.dispose(), "Disposing the current OpenCode instance")
}

export async function disposeAllInstances(client: StableClient): Promise<void> {
  dataOrThrow(await client.global.dispose(), "Disposing OpenCode instances")
}

export async function getPaths(client: { path: { get: () => Promise<{ data?: unknown; error?: unknown }> } }): Promise<Record<string, string>> {
  return dataOrThrow(await client.path.get(), "Reading OpenCode paths") as Record<string, string>
}

export function pluginReferences(value: unknown): PluginReference[] {
  if (!Array.isArray(value)) return []
  const result: PluginReference[] = []
  for (const item of value) {
    if (typeof item === "string") {
      if (item.trim()) result.push({ spec: item.trim() })
      continue
    }
    if (Array.isArray(item) && typeof item[0] === "string") {
      const options = item[1] && typeof item[1] === "object" && !Array.isArray(item[1]) ? item[1] as JsonObject : undefined
      result.push({ spec: item[0], ...(options ? { options } : {}) })
      continue
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const reference = item as { spec?: unknown; options?: unknown }
      if (typeof reference.spec !== "string" || !reference.spec.trim()) continue
      const options = reference.options && typeof reference.options === "object" && !Array.isArray(reference.options)
        ? reference.options as JsonObject
        : undefined
      result.push({ spec: reference.spec.trim(), ...(options ? { options } : {}) })
    }
  }
  return result
}

export function pluginConfigValue(plugins: PluginReference[]): (string | [string, Record<string, unknown>])[] {
  return plugins.map((plugin) => plugin.options ? [plugin.spec, plugin.options] : plugin.spec)
}

export function pluginConfigMatches(value: unknown, expected: PluginReference[]): boolean {
  const actual = pluginReferences(value).map((item) => ({ spec: item.spec, options: item.options ?? {} }))
  const next = expected.map((item) => ({ spec: item.spec, options: item.options ?? {} }))
  return stableJson(actual) === stableJson(next)
}

export async function setGlobalServerPlugins(client: StableClient, plugins: PluginReference[]): Promise<void> {
  const current = await readGlobalConfig(client)
  if (pluginConfigMatches(current.plugin, plugins)) return
  await updateGlobalConfig(client, { plugin: pluginConfigValue(plugins) })
  const readback = await readGlobalConfig(client)
  if (!pluginConfigMatches(readback.plugin, plugins)) throw new Error("OpenCode did not retain the requested server plugin set")
}
