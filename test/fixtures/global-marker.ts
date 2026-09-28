import { writeFile } from "node:fs/promises"
import type { Plugin } from "@opencode-ai/plugin"

const server: Plugin = async () => ({
  config: async () => {
    const marker = process.env.OPENCODE_PROFILE_SMOKE_GLOBAL_MARKER
    if (marker) await writeFile(marker, "global plugin loaded", "utf8")
  },
})

export default { id: "profile-smoke-global-marker", server }
