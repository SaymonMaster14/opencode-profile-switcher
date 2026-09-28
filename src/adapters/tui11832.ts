import type { TuiPluginApi, TuiPluginStatus } from "@opencode-ai/plugin/tui"
import type { PluginReference } from "../core/types.ts"

export type TuiPluginControl = Pick<TuiPluginApi["plugins"], "list" | "activate" | "deactivate">

export interface TuiReconcileResult {
  activated: string[]
  deactivated: string[]
  missing: string[]
  rollback(): Promise<void>
}

function matches(status: TuiPluginStatus, reference: PluginReference): boolean {
  return (reference.id !== undefined && status.id === reference.id) || status.spec === reference.spec
}

export async function reconcileTuiPlugins(input: {
  control: TuiPluginControl
  desired: PluginReference[]
  managerId: string
  managerSpec: string
}): Promise<TuiReconcileResult> {
  const before = input.control.list().map((status) => ({ ...status }))
  const required = new Set<string>([input.managerId])
  const missing: string[] = []
  for (const reference of input.desired) {
    const status = before.find((item) => matches(item, reference))
    if (!status) missing.push(reference.spec)
    else required.add(status.id)
  }
  const activated: string[] = []
  const deactivated: string[] = []
  const protectedIds = new Set([
    input.managerId,
    ...before.filter((item) => item.source === "internal" || item.spec === input.managerSpec).map((item) => item.id),
  ])

  const rollback = async () => {
    const after = input.control.list()
    for (const status of after) {
      if (protectedIds.has(status.id)) continue
      const wasActive = before.some((item) => item.id === status.id && item.active)
      if (status.active && !wasActive) await input.control.deactivate(status.id)
    }
    for (const status of before) {
      if (protectedIds.has(status.id)) continue
      const now = input.control.list().find((item) => item.id === status.id)
      if (status.active && !now?.active) await input.control.activate(status.id)
    }
  }

  if (missing.length) return { activated, deactivated, missing, rollback }

  try {
    for (const status of before) {
      if (protectedIds.has(status.id) || required.has(status.id) || !status.active) continue
      if (!(await input.control.deactivate(status.id))) throw new Error(`Could not deactivate TUI plugin ${status.id}`)
      deactivated.push(status.id)
    }
    for (const id of required) {
      if (protectedIds.has(id)) continue
      const status = input.control.list().find((item) => item.id === id)
      const wasActive = status?.active === true
      if (!wasActive && !(await input.control.activate(id))) throw new Error(`Could not activate TUI plugin ${id}`)
      if (!wasActive) activated.push(id)
    }
  } catch (error) {
    await rollback().catch(() => undefined)
    throw error
  }
  return { activated, deactivated, missing, rollback }
}
