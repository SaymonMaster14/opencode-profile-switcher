import { jsx } from "@opentui/solid/jsx-runtime"
import { writeFile } from "node:fs/promises"

export default {
  id: "profile-smoke-tui-plugin-x",
  tui: async (api) => {
    const marker = process.env.OPENCODE_PROFILE_SMOKE_TUI_MARKER
    if (marker) await writeFile(marker, "active", "utf8")
    api.lifecycle.onDispose(() => marker ? writeFile(marker, "disposed", "utf8") : undefined)
    api.slots.register({
      slots: {
        app_bottom: () => jsx("text", { children: "PLUGIN_X_ACTIVE" }),
      },
    })
  },
}
