// Install as a trusted AGH plugin before enabling workflow model nodes.
// No model request is permitted by the adapter until this guard's ready event is observed.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const MARKER = '.fjsp-analysis-workspace.json'
export const GUARD_VERSION = 1
export const GUARD_ROW = 'ext:fjsp/analysis-guard'

export const analysisGuard = {
  inject: ['extension'],
  apply(ctx) {
    const agnes = ctx.extension()
    const protectedSessions = new Set()
    const marked = (hookCtx) => {
      if (protectedSessions.has(hookCtx.session.key)) return true
      try {
        const marker = JSON.parse(readFileSync(join(hookCtx.session.workspaceRoot, MARKER), 'utf8'))
        return marker.mode === 'fjsp-workflow-analysis' && marker.version === GUARD_VERSION
      } catch { return false }
    }
    // Register directives before the ready observer. If registration is refused,
    // apply throws and no ready event can attest to a partially installed guard.
    agnes.registerHook('tool_call', (_payload, hookCtx) => marked(hookCtx)
      ? { allow: false, reason: 'FJSP analysis-only session: all tools are forbidden' }
      : { allow: true })
    agnes.registerHook('before_step', (payload, hookCtx) => marked(hookCtx) && payload.step > 1
      ? { block: true, reason: 'FJSP analysis-only session permits one model step' } : {})
    agnes.registerHook('before_request', (_payload, hookCtx) => marked(hookCtx)
      ? { patch: { maxTokens: 2048 } } : {})
    agnes.on('session_start', async (_payload, hookCtx) => {
      if (!marked(hookCtx)) return
      protectedSessions.add(hookCtx.session.key)
      await agnes.events.append('ready', {
        version: GUARD_VERSION, workspaceRoot: hookCtx.session.workspaceRoot,
        policy: 'deny-all-tools', maxSteps: 1, maxOutputTokens: 2048,
      })
    })
    agnes.on('shutdown', () => { protectedSessions.clear() })
  },
}
