import { afterAll, describe, expect, test } from "bun:test"
import { discoverGitHubPlugin, parseGitHubPluginSpec } from "../src/core/github.ts"

let passed = 0
afterAll(() => { if (passed) console.log("PROFILE_PLUGIN_TESTS_PASSED") })

describe("GitHub plugin discovery", () => {
  test("accepts safe owner/repository refs and rejects non-GitHub URLs and traversal", () => {
    expect(parseGitHubPluginSpec("owner/repo#feature/branch")).toEqual({ owner: "owner", repo: "repo", ref: "feature/branch" })
    expect(parseGitHubPluginSpec("github:owner/repo#v1.0.0::path:packages/plugin")).toEqual({
      owner: "owner", repo: "repo", ref: "v1.0.0", subdirectory: "packages/plugin",
    })
    expect(() => parseGitHubPluginSpec("https://evil.example/owner/repo")).toThrow("Only github.com")
    expect(() => parseGitHubPluginSpec("github:owner/repo#main::path:../../escape")).toThrow("subdirectory")
    passed += 1
  })

  test("reads metadata only, resolves branch to commit, and pins the profile spec", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567"
    const requested: string[] = []
    const responses: Record<string, unknown> = {
      "https://api.github.com/repos/author/repo": { description: "A useful plugin", default_branch: "main", owner: { login: "author" } },
      "https://api.github.com/repos/author/repo/commits/main": { sha },
    }
    const fetcher = async (input: string | URL) => {
      const url = String(input)
      requested.push(url)
      const body = url.includes("package.json")
        ? JSON.stringify({
            name: "opencode-useful-plugin",
            version: "1.2.0",
            description: "Plugin manifest description",
            author: { name: "A. Maintainer" },
            exports: { "./server": { import: "./server.ts", config: { strict: true } }, "./tui": "./tui.ts" },
          })
        : url.includes("README.md")
          ? "# Useful plugin\n\nAdds a focused workflow for this project.\n\n```ts\n// not downloaded or executed\n```"
          : JSON.stringify(responses[url])
      return new Response(body, { status: 200, headers: { "content-type": url.includes("api.github.com") ? "application/json" : "text/plain" } })
    }
    const plugin = await discoverGitHubPlugin("github:author/repo#main", fetcher)
    expect(plugin.commit).toBe(sha)
    expect(plugin.reference.spec).toBe(`github:author/repo#${sha}`)
    expect(plugin.reference.author).toBe("A. Maintainer")
    expect(plugin.reference.description).toBe("Plugin manifest description")
    expect(plugin.serverReference.options).toEqual({ strict: true })
    expect(plugin.hasServer).toBe(true)
    expect(plugin.hasTui).toBe(true)
    expect(requested.some((url) => url.endsWith("server.ts") || url.endsWith("tui.ts"))).toBe(false)
    expect(plugin.readmeSummary).toContain("Adds a focused workflow")
    passed += 1
  })
})
