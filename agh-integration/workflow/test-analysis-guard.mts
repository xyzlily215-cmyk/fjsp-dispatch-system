// Exercises the actual plugin hooks without installing or changing a live daemon.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analysisGuard, MARKER } from '../analysis-guard/index.mjs'
const root = mkdtempSync(join(tmpdir(), 'analysis-guard-test-'))
try {
  writeFileSync(join(root, MARKER), JSON.stringify({ version: 1, mode: 'fjsp-workflow-analysis' }))
  const hooks = new Map<string, Function>()
  const rows: unknown[] = []
  analysisGuard.apply({ extension: () => ({
    registerHook: (name: string, handler: Function) => hooks.set(name, handler),
    on: (name: string, handler: Function) => hooks.set(name, handler),
    events: { append: async (name: string, data: unknown) => rows.push({ name, data }) },
  }) })
  const context = { session: { key: 'analysis', workspaceRoot: root } }
  await hooks.get('session_start')!({}, context)
  assert.equal(rows.length, 1)
  assert.equal(hooks.get('tool_call')!({ name: 'fjsp_publish' }, context).allow, false)
  assert.equal(hooks.get('tool_call')!({ name: 'stop_device' }, context).allow, false)
  assert.equal(hooks.get('tool_call')!({ name: 'shell' }, context).allow, false)
  assert.equal(hooks.get('before_step')!({ step: 2 }, context).block, true)
  assert.equal(hooks.get('before_request')!({}, context).patch.maxTokens, 2048)
  rmSync(join(root, MARKER))
  assert.equal(hooks.get('tool_call')!({}, context).allow, false, '已标记会话删除标识后仍拒绝工具')
  const normal = { session: { key: 'normal', workspaceRoot: root } }
  assert.equal(hooks.get('tool_call')!({}, normal).allow, true, '普通会话不受影响')
  console.log('PASS backend analysis guard: ready attestation, deny all tools including read/device/shell, one step, output cap, session isolation')
} finally { rmSync(root, { recursive: true, force: true }) }
