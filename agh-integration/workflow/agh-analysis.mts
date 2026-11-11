// AGH-backed, isolated, single-turn analysis. No direct provider API calls.
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MARKER, GUARD_VERSION, GUARD_ROW } from '../analysis-guard/index.mjs'
import { createModelAgent, type AnalysisTransport } from './model-agent.mts'

export function createAghDisturbanceAgent(options: Parameters<typeof createAghAnalysisTransport>[0] & {
  timeoutMs?: number; maxInputBytes?: number; maxOutputBytes?: number
}) {
  return createModelAgent(createAghAnalysisTransport(options), options)
}

const SOURCE = `plugin/${createHash('sha256').update(GUARD_ROW).digest('hex').slice(0, 16)}`
export const GUARD_READY_EVENT = `x/${SOURCE}/ready`
export function assertAnalysisPackages(packages: { id: string; actual?: string }[]): void {
  const allowed = new Set(['@fjsp/analysis-guard', '@agnes/document-reader', '@agnes/mcp-helper', '@agnes/plugin-helper', '@agnes/skill-helper'])
  if (packages.some((p) => !allowed.has(p.id))
      || !packages.some((p) => p.id === '@fjsp/analysis-guard' && p.actual === 'running')) {
    throw new Error('CONTEXT_NOT_ISOLATED')
  }
}
export interface AnalysisEvent { type: string; seq: number; origin?: string; data: unknown }
// Narrow structural port implemented by AGH SDK Session; tests provide an in-memory peer.
export interface AnalysisSession {
  id: string; generation: number
  attach(): Promise<unknown>
  events(options?: { cursor: { fromSeq: number; generation: number } }): AsyncIterable<AnalysisEvent>
  onPermissionRequest(handler: () => Promise<{ verdict: 'rejected' }>): () => void
  prompt(text: string, options: { signal: AbortSignal; titleLocale: 'zh-CN' }): Promise<{ stopReason: string; reason: string; lastSeq: number }>
  cancel(): Promise<void>
}
export interface AnalysisClient {
  workspace: { add(path: string): Promise<unknown> }
  session: { new: (options: { cwd: string; sessionKey: string }) => Promise<AnalysisSession> }
  close(): Promise<void>
}
export function createAghAnalysisTransport(options: {
  workspace: string
  ownerFile?: string
  connect?: () => Promise<AnalysisClient>
  guardTimeoutMs?: number
}): AnalysisTransport {
  const guardTimeoutMs = options.guardTimeoutMs ?? 5000
  if (!Number.isSafeInteger(guardTimeoutMs) || guardTimeoutMs <= 0) throw new Error('Invalid guardTimeoutMs')
  const connect = options.connect ?? (async () => {
    const owner = JSON.parse(readFileSync(options.ownerFile ?? join(homedir(), '.agh-fjsp-analysis/data/daemon/owner.json'), 'utf8'))
    if (typeof owner.socketPath !== 'string') throw new Error('MODEL_UNAVAILABLE')
    // AGH source is optional in this repository; absent SDK fails explicitly at invocation time.
    const { createClient } = await import('../agnes-harness/packages/sdk/src/index.node.ts')
    const client = createClient({ transport: { kind: 'unix', path: owner.socketPath }, clientId: 'fjsp-workflow-analysis',
      timeouts: { request: 5000, initialize: 5000 } })
    try {
      const { createPackageAdminClient } = await import('../agnes-harness/packages/sdk/src/package-admin.node.ts')
      const config = await client.config.get()
      const packages = createPackageAdminClient({ call: (method, params) => client.call(method, params as Record<string, unknown>) })
      const installed = await packages.list({ profile: config.profile })
      // Shared local-dev contains live MHS context hooks. Never silently reuse it.
      assertAnalysisPackages(installed.packages)
      return client
    } catch (error) {
      await client.close()
      throw error
    }
  })
  return {
    async complete(prompt, signal) {
      signal.throwIfAborted()
      const cwd = realpathSync(options.workspace)
      const marker = JSON.parse(readFileSync(join(cwd, MARKER), 'utf8'))
      if (marker.version !== GUARD_VERSION || marker.mode !== 'fjsp-workflow-analysis') throw new Error('GUARD_UNAVAILABLE')
      let client: AnalysisClient | undefined
      let session: AnalysisSession | undefined
      let offPermission: (() => void) | undefined
      let collector: Promise<void> | undefined
      let iterator: AsyncIterator<AnalysisEvent> | undefined
      let guardTimer: ReturnType<typeof setTimeout> | undefined
      let completed = false
      let prompted = false
      let rejectStopped: (error: Error) => void = () => {}
      const stopped = new Promise<never>((_, reject) => { rejectStopped = reject })
      // Attach a rejection observer immediately; setup may fail before the races below.
      void stopped.catch(() => {})
      const abort = () => {
        rejectStopped(new Error('TIMEOUT'))
        void session?.cancel().catch(() => {})
        void client?.close().catch(() => {})
      }
      signal.addEventListener('abort', abort, { once: true })
      try {
        client = await connect()
        signal.throwIfAborted()
        await client.workspace.add(cwd)
        signal.throwIfAborted()
        session = await client.session.new({ cwd, sessionKey: `fjsp-analysis-${randomUUID()}` })
        signal.throwIfAborted()
        offPermission = session.onPermissionRequest(async () => ({ verdict: 'rejected' }))
        // Subscribe before attach so the ready event cannot fall between replay and collection.
        let readyResolve: () => void = () => {}
        let endResolve: () => void = () => {}
        const ready = new Promise<void>((resolve) => { readyResolve = resolve })
        const ended = new Promise<void>((resolve) => { endResolve = resolve })
        let guardReady = false
        let answer = ''
        // events() registers its listener synchronously before its first attach.
        // Do not attach separately: replayed session_start/guard rows would be
        // admitted before the collector exists and then deduplicated by the SDK.
        iterator = session.events()[Symbol.asyncIterator]()
        collector = (async () => {
          for (;;) {
            const next = await iterator!.next()
            if (next.done) throw new Error('MODEL_UNAVAILABLE')
            const event = next.value
            const data = event.data as Record<string, unknown> | null
            if (event.type === GUARD_READY_EVENT && event.origin === `ext:${SOURCE}` && data?.version === GUARD_VERSION
                && data?.workspaceRoot === cwd && data?.policy === 'deny-all-tools'
                && data?.maxSteps === 1 && data?.maxOutputTokens === 2048) {
              guardReady = true
              readyResolve()
            }
            if (!prompted) continue
            if (event.type === 'tool/call') throw new Error('TOOL_ATTEMPT')
            if (event.type === 'assistant/message') {
              const content = data?.content
              if (!Array.isArray(content)) throw new Error('INVALID_OUTPUT')
              const text = content.filter((b) => b && b.type === 'text').map((b) => b.text).join('')
              answer += text
              if (Buffer.byteLength(answer) > 16000) throw new Error('OUTPUT_LIMIT')
            }
            if (event.type === 'turn/end') { endResolve(); return }
          }
        })().catch((error) => { rejectStopped(error instanceof Error ? error : new Error('MODEL_UNAVAILABLE')) })
        guardTimer = setTimeout(() => rejectStopped(new Error('GUARD_UNAVAILABLE')), guardTimeoutMs)
        await Promise.race([ready, stopped])
        clearTimeout(guardTimer)
        if (!guardReady) throw new Error('GUARD_UNAVAILABLE')
        signal.throwIfAborted()
        prompted = true
        const result = await Promise.race([session.prompt(prompt, { signal, titleLocale: 'zh-CN' }), stopped])
        await Promise.race([ended, stopped])
        if (result.reason !== 'completed') throw new Error('INCOMPLETE_OUTPUT')
        completed = true
        return { text: answer, sessionId: session.id, stopReason: result.stopReason }
      } finally {
        signal.removeEventListener('abort', abort)
        if (guardTimer) clearTimeout(guardTimer)
        offPermission?.()
        if (prompted && !completed) await session?.cancel().catch(() => {})
        await client?.close().catch(() => {})
        // Closing the dedicated client wakes any event iterator waiting for a row.
        await iterator?.return?.().catch(() => {})
        await collector
      }
    },
  }
}
