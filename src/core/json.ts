import type { JsonObject, JsonValue, PluginReference } from "./types.ts"

export function mergeJson(base: JsonObject, overlay: JsonObject): JsonObject {
  const result: JsonObject = structuredClone(base)
  for (const [key, value] of Object.entries(overlay)) {
    const previous = result[key]
    result[key] = isObject(previous) && isObject(value) ? mergeJson(previous, value) : structuredClone(value)
  }
  return result
}

export function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortJson(item)]))
}

export function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right)
}

export function uniquePlugins(items: PluginReference[]): PluginReference[] {
  const seen = new Set<string>()
  const result: PluginReference[] = []
  for (const item of items) {
    const key = item.spec.trim()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

export function pluginSpecs(items: PluginReference[]): string[] {
  return uniquePlugins(items).map((item) => item.spec)
}

export function pluginBindings(items: PluginReference[]): { spec: string; options?: JsonObject }[] {
  return uniquePlugins(items).map((item) => ({ spec: item.spec, ...(item.options ? { options: item.options } : {}) }))
}

export function shortPluginName(plugin: PluginReference): string {
  return plugin.name?.trim() || plugin.id?.trim() || plugin.spec.split("#", 1)[0] || plugin.spec
}
