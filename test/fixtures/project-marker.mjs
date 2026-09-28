import { writeFile } from "node:fs/promises"

export default {
  id: "profile-smoke-project-marker",
  server: async () => ({
    config: async () => {
      const marker = process.env.OPENCODE_PROFILE_SMOKE_PROJECT_MARKER
      if (marker) await writeFile(marker, "project plugin loaded", "utf8")
    },
  }),
}
