// Real transport code with an in-memory SDK peer: no daemon/model/network.
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createAghAnalysisTransport, assertAnalysisPackages, GUARD_READY_EVENT, type AnalysisClient, type AnalysisEvent } from './agh-analysis.mts'
import { MARKER, GUARD_ROW } from '../analysis-guard/index.mjs'
const approvedPackages = [{ id: '@fjsp/analysis-guard', actual: 'running' }]
assert.doesNotThrow(() => assertAnalysisPackages(approvedPackages))
assert.throws(() => assertAnalysisPackages([]), /CONTEXT_NOT_ISOLATED/)
assert.throws(() => assertAnalysisPackages([{ id: '@fjsp/analysis-guard', actual: 'disabled' }]), /CONTEXT_NOT_ISOLATED/)
assert.throws(() => assertAnalysisPackages([...approvedPackages, { id: '@agnes/mhs', actual: 'running' }]), /CONTEXT_NOT_ISOLATED/)
assert.throws(() => assertAnalysisPackages([...approvedPackages, { id: '@fjsp/fjsp-tools', actual: 'running' }]), /CONTEXT_NOT_ISOLATED/)
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agh-analysis-test-')))
writeFileSync(join(dir, MARKER), JSON.stringify({ mode: 'fjsp-workflow-analysis', version: 1 }))
function peer(mode: 'ok' | 'missing-guard' | 'wrong-origin' | 'tool' | 'truncated' | 'waiting') {
  const queue: AnalysisEvent[] = []
  let wake = () => {}
  let closed = false
  let promptCount = 0
  let cancelCount = 0
  const source = `plugin/${createHash('sha256').update(GUARD_ROW).digest('hex').slice(0, 16)}`
  const push = (event: AnalysisEvent) => { queue.push(event); wake() }
  const client: AnalysisClient = {
    workspace: { add: async (path) => { assert.equal(path, dir) } },
    session: { new: async ({ sessionKey, cwd }) => {
      assert.equal(cwd, dir)
      assert.ok(sessionKey.startsWith('fjsp-analysis-'))
      return {
        id: 's-test', generation: 1,
        attach: async () => {},
        events(options) {
          assert.equal(options, undefined)
          if (mode !== 'missing-guard') push({ type: GUARD_READY_EVENT, origin: mode === 'wrong-origin' ? 'user' : `ext:${source}`, seq: 1,
            data: { version: 1, workspaceRoot: dir, policy: 'deny-all-tools', maxSteps: 1, maxOutputTokens: 2048 } })
          return { async *[Symbol.asyncIterator]() {
            while (!closed) {
              if (queue.length) yield queue.shift()!
              else await new Promise<void>((resolve) => { wake = resolve })
            }
          } }
        },
        onPermissionRequest(handler) { void handler().then((v) => assert.equal(v.verdict, 'rejected')); return () => {} },
        async prompt(_text, { signal }) {
          promptCount++
          assert.ok(!signal.aborted)
          if (mode === 'tool') push({ type: 'tool/call', seq: 2, data: { name: 'fjsp_publish' } })
          if (mode === 'waiting') return new Promise(() => {})
          push({ type: 'assistant/message', seq: 3, data: { content: [{ type: 'text', text: '{"ok":true}' }] } })
          push({ type: 'turn/end', seq: 4, data: { reason: 'completed' } })
          return { stopReason: mode === 'truncated' ? 'max_tokens' : 'end_turn', reason: 'completed', lastSeq: 4 }
        },
        cancel: async () => { cancelCount++ },
      }
    } },
    async close() { closed = true; wake() },
  }
  return { client, stats: () => ({ promptCount, cancelCount, closed }) }
}
try {
  for (const mode of ['ok', 'missing-guard', 'wrong-origin', 'tool', 'truncated', 'waiting'] as const) {
    const p = peer(mode)
    const transport = createAghAnalysisTransport({ workspace: dir, connect: async () => p.client, guardTimeoutMs: 10 })
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    if (mode === 'waiting') timer = setTimeout(() => controller.abort(), 20)
    try {
      if (mode === 'missing-guard' || mode === 'wrong-origin') {
        await assert.rejects(transport.complete('test', controller.signal), /GUARD_UNAVAILABLE/)
        assert.equal(p.stats().promptCount, 0, '没有后端拦截证明，不发模型请求')
      } else if (mode === 'tool') {
        await assert.rejects(transport.complete('test', controller.signal), /TOOL_ATTEMPT/)
      } else if (mode === 'waiting') {
        await assert.rejects(transport.complete('test', controller.signal), /TIMEOUT/)
        assert.ok(p.stats().cancelCount > 0)
      } else {
        const result = await transport.complete('test', controller.signal)
        assert.equal(result.text, '{"ok":true}')
        assert.equal(result.stopReason, mode === 'truncated' ? 'max_tokens' : 'end_turn')
      }
      assert.ok(p.stats().closed)
    } finally { if (timer) clearTimeout(timer) }
  }
  console.log('PASS AGH transport: isolated sessions, guard proof before prompt, tool-attempt rejection, cancellation and connection cleanup')
} finally { rmSync(dir, { recursive: true, force: true }) }
