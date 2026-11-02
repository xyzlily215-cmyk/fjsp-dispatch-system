// workflow/test-runner.mts — runner.mts 行为测试（mock 节点，不起任何服务）。
// 运行：cd agh-integration && npx tsx workflow/test-runner.mts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { CheckpointStore } from './checkpoint.mts'
import { runWorkflow, type WorkflowNode, type NodeContext } from './runner.mts'

let seq = 0
const dirs: string[] = []

// 每个用例独立检查点目录 + 唯一 dedupeKey，互不污染
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'runner-test-'))
  dirs.push(dir)
  const store = new CheckpointStore(dir)
  const { checkpoint } = store.create({ type: 'TEST', trigger: { source: 'test', dedupeKey: `t-${Date.now()}-${seq++}` } })
  return { store, workflowId: checkpoint.workflowId }
}

// 记录调用轨迹的 mock 节点工厂：handler 收到 (ctx, calls)
function mockNode(name: string, handler: (ctx: NodeContext, calls: string[]) => unknown, maxAttempts?: number): { node: WorkflowNode; calls: string[] } {
  const calls: string[] = []
  const node: WorkflowNode = {
    name,
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    async run(ctx) {
      calls.push(`${name}#${ctx.checkpoint.current!.attempt}`)
      return handler(ctx, calls) as never
    },
  }
  return { node, calls }
}

async function testSequentialAdvance() {
  const { store, workflowId } = setup()
  const a = mockNode('a', () => ({ action: 'advance', result: { eventId: 'ev-1' } }))
  const b = mockNode('b', () => ({ action: 'advance' }))
  const c = mockNode('c', () => ({ action: 'advance' }))
  const cp = await runWorkflow(workflowId, [a.node, b.node, c.node], { store })
  assert.equal(cp.status, 'COMPLETED')
  assert.equal(cp.current, null)
  assert.deepEqual(cp.completedSteps.map((s) => s.node), ['a', 'b', 'c'])
  assert.deepEqual(a.calls, ['a#1'])
  for (const s of cp.completedSteps) {
    assert.equal(s.attempt, 1)
    assert.equal(s.idempotencyKey, `${workflowId}:${s.node}:1`)
  }
  assert.equal(cp.completedSteps[0].result?.eventId, 'ev-1')
  console.log('ok 顺序推进与检查点字段')
}

async function testRetryKeepsIdempotencyKey() {
  const { store, workflowId } = setup()
  const keys: string[] = []
  const a = mockNode('a', (ctx) => {
    keys.push(ctx.checkpoint.current!.idempotencyKey)
    return ctx.checkpoint.current!.attempt < 3 ? { action: 'retry', reason: '模拟失败' } : { action: 'advance' }
  })
  const cp = await runWorkflow(workflowId, [a.node], { store })
  assert.equal(cp.status, 'COMPLETED')
  assert.deepEqual(a.calls, ['a#1', 'a#2', 'a#3'])
  assert.equal(cp.completedSteps[0].attempt, 3)
  assert.ok(keys.every((k) => k === keys[0]), '重试必须复用同一幂等键')
  console.log('ok retry 路径 attempt 递增且幂等键不变')
}

async function testErrorBranches() {
  // retryable：抛 FJSP_UNREACHABLE，重试后成功
  {
    const { store, workflowId } = setup()
    const a = mockNode('a', (ctx) => {
      if (ctx.checkpoint.current!.attempt === 1) throw Object.assign(new Error('连接失败'), { code: 'FJSP_UNREACHABLE' })
      return { action: 'advance' }
    })
    const cp = await runWorkflow(workflowId, [a.node], { store })
    assert.equal(cp.status, 'COMPLETED')
    assert.equal(cp.completedSteps[0].attempt, 2)
  }
  // needs-human：抛 FJSP_UNAUTHORIZED → 挂起
  {
    const { store, workflowId } = setup()
    const a = mockNode('a', () => { throw Object.assign(new Error('凭据失效'), { code: 'FJSP_UNAUTHORIZED' }) })
    const cp = await runWorkflow(workflowId, [a.node], { store })
    assert.equal(cp.status, 'WAITING_APPROVAL')
    assert.equal(cp.pendingApproval, null)
    assert.match(cp.statusReason ?? '', /凭据失效/)
  }
  // terminal：返回错误 envelope E_INTEGRITY_VIOLATION → 终止
  {
    const { store, workflowId } = setup()
    const a = mockNode('a', () => ({ ok: false, error: { code: 'E_INTEGRITY_VIOLATION', message: '硬约束完整性违反' } }))
    const cp = await runWorkflow(workflowId, [a.node], { store })
    assert.equal(cp.status, 'TERMINATED')
    assert.match(cp.statusReason ?? '', /E_INTEGRITY_VIOLATION/)
  }
  console.log('ok retryable/needs-human/terminal 三分支')
}

async function testMaxAttemptsExceeded() {
  const { store, workflowId } = setup()
  const a = mockNode('a', () => ({ action: 'retry', reason: '一直失败' }), 2)
  const cp = await runWorkflow(workflowId, [a.node], { store })
  assert.equal(cp.status, 'FAILED')
  assert.match(cp.statusReason ?? '', /needs-human|转人工/)
  assert.deepEqual(a.calls, ['a#1', 'a#2']) // 第 3 次 beginStep 后拒绝执行
  console.log('ok 超限转 terminate(FAILED 转人工)')
}

async function testSuspendWithApproval() {
  const { store, workflowId } = setup()
  const a = mockNode('a', () => ({
    action: 'suspend',
    reason: '发布计划需人工审批',
    awaitApproval: { tool: 'fjsp_publish_plan', bizObject: 'pv-1' },
  }))
  const cp = await runWorkflow(workflowId, [a.node], { store })
  assert.equal(cp.status, 'WAITING_APPROVAL')
  assert.ok(cp.pendingApproval, 'pendingApproval 应存在')
  assert.match(cp.pendingApproval!.requestId, /^appr-/)
  assert.equal(cp.pendingApproval!.tool, 'fjsp_publish_plan')
  assert.equal(cp.pendingApproval!.bizObject, 'pv-1')
  assert.ok(new Date(cp.pendingApproval!.expiresAt) > new Date(cp.pendingApproval!.issuedAt))
  console.log('ok suspend 后检查点状态与 pendingApproval 字段')
}

async function testResumeFromMiddle() {
  const { store, workflowId } = setup()
  const a = mockNode('a', () => ({ action: 'advance' }))
  const b = mockNode('b', (ctx) =>
    ctx.checkpoint.current!.attempt === 1
      ? { action: 'suspend', reason: '等审批', awaitApproval: { tool: 'fjsp_publish_plan' } }
      : { action: 'advance' },
  )
  const c = mockNode('c', () => ({ action: 'advance' }))
  const nodes = [a.node, b.node, c.node]

  const cp1 = await runWorkflow(workflowId, nodes, { store })
  assert.equal(cp1.status, 'WAITING_APPROVAL')
  assert.deepEqual(a.calls, ['a#1'])
  assert.deepEqual(c.calls, [], '挂起后不得执行后续节点')

  // 模拟审批裁决后重入：a 跳过、b 复用同键重跑、c 首次执行
  store.clearApproval(workflowId)
  const cp2 = await runWorkflow(workflowId, nodes, { store })
  assert.equal(cp2.status, 'COMPLETED')
  assert.deepEqual(a.calls, ['a#1'], '已完成节点不得重跑')
  assert.deepEqual(b.calls, ['b#1', 'b#2'])
  assert.deepEqual(c.calls, ['c#1'])
  assert.deepEqual(cp2.completedSteps.map((s) => s.node), ['a', 'b', 'c'])
  assert.equal(cp2.completedSteps[1].attempt, 2)
  console.log('ok 从中间节点续跑跳过已完成节点')
}

const tests = [
  testSequentialAdvance,
  testRetryKeepsIdempotencyKey,
  testErrorBranches,
  testMaxAttemptsExceeded,
  testSuspendWithApproval,
  testResumeFromMiddle,
]

let failed = 0
for (const t of tests) {
  try {
    await t()
  } catch (e) {
    failed++
    console.error(`FAIL ${t.name}:`, e)
  }
}
for (const d of dirs) rmSync(d, { recursive: true, force: true })
if (failed) {
  console.error(`${failed}/${tests.length} 个用例失败`)
  process.exit(1)
}
console.log(`全部 ${tests.length} 个用例通过`)
