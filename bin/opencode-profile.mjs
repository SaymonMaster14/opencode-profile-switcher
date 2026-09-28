#!/usr/bin/env node
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const runtime = process.env.BUN_BINARY || "bun"
const entry = path.join(packageRoot, "src", "cli.ts")
const child = spawn(runtime, ["run", entry, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  shell: process.platform === "win32",
})
child.once("error", (error) => {
  console.error(`Could not start the profile helper. Bun is required for isolated launches: ${error.message}`)
  process.exitCode = 1
})
child.once("exit", (code, signal) => {
  if (process.exitCode !== 1) process.exitCode = code ?? (signal ? 1 : 0)
})
