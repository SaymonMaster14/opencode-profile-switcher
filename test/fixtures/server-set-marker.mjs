export default {
  id: "profile-smoke-server-set-marker",
  server: async () => ({
    config: async (config) => {
      config.username = "SERVER_SET_PLUGIN_ACTIVE"
    },
  }),
}
