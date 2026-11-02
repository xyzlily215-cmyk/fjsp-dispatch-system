// workflow/test-baseline-flow.mts — baseline-flow 行为测试（mock tools + mock agent，不起服务）。
// 运行：cd agh-integration && ./agnes-harness/node_modules/.bin/tsx workflow/test-baseline-flow.mts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { CheckpointStore } from './checkpoint.mts'
import { runWorkflow } from './runner.mts'
import { buildBaselineFlow, validateBaselineWeights, type BaselineFlowInput, type BaselineAgent } from './baseline-flow.mts'
import type { FlowTools } from './flow-common.mts'

let seq = 0
const dirs: string[] = []

function setup(input: BaselineFlowInput = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-test-'))
  dirs.push(dir)
  const store = new CheckpointStore(dir)
  const { checkpoint } = store.create({
    type: 'BASELINE',
    trigger: { source: 'test', dedupeKey: `t-${Date.now()}-${seq++}`, detail: input },
  })
  return { store, workflowId: checkpoint.workflowId }
}

interface MockOpts {
  machines?: number
  orders?: number
  templates?: number
  taskTerminal?: { status: string; resultStatus?: string } // create-baseline 任务终态覆盖
  runningOnce?: boolean // 首次 fjsp_task_status 返回 RUNNING 快照
}

// mock 业务服务：内存维护主数据数量与任务终态
function makeMockTools(opts: MockOpts = {}) {
  const { machines = 3, orders = 5, templates = 2 } = opts
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const state = { taskSeq: 0, runningConsumed: false }
  const tools: FlowTools = {
    async call(name, args = {}) {
      calls.push({ name, args })
      switch (name) {
        case 'fjsp_get_dashboard':
          return {
            ok: true,
            currentPlan: null,
            orderStats: { PENDING: orders, COMPLETED: 0 },
            machines: Array.from({ length: machines }, (_, i) => ({ machineId: `M-0${i + 1}` })),
          }
        case 'fjsp_list_process_templates':
          return { ok: true, templates: Array.from({ length: templates }, (_, i) => ({ templateCode: `TPL-${i}`, operationCount: 2 })) }
        case 'fjsp_create_baseline': {
          const taskId = `tsk-${++state.taskSeq}`
          return { ok: true, task: { taskId, mode: 'BASELINE', status: 'RUNNING' } }
        }
        case 'fjsp_task_status': {
          if (opts.runningOnce && !state.runningConsumed) {
            state.runningConsumed = true
            return { ok: true, task: { taskId: args.taskId, status: 'RUNNING', progress: 0.3 } }
          }
          const terminal = opts.taskTerminal ?? { status: 'SUCCESS', resultStatus: 'FEASIBLE' }
          if (terminal.resultStatus === 'INFEASIBLE') {
            return {
              ok: true,
              task: {
                taskId: args.taskId,
                status: terminal.status,
                resultStatus: 'INFEASIBLE',
                conflicts: [{ type: 'NO_CAPABLE_MACHINE', orderId: 'O007', message: '无可用设备加工该产品族' }],
                kpi: null,
              },
            }
          }
          if (terminal.status === 'FAILED') {
            return { ok: true, task: { taskId: args.taskId, status: 'FAILED', errorMessage: 'algorithm-service 超时', conflicts: [] } }
          }
          return {
            ok: true,
            task: {
              taskId: args.taskId,
              status: terminal.status,
              resultStatus: 'FEASIBLE',
              planVersionId: `pv-base-${args.taskId}`,
              kpi: { cMaxMinutes: 500, weightedTardinessMinutes: 25, nTardy: 2, loadImbalance: 0.15 },
              conflicts: [],
            },
          }
        }
        default:
          throw new Error(`未 mock 的工具：${name}`)
      }
    },
  }
  return { tools, calls, state }
}

async function testHappyPathSuspendsAtHandoff() {
  const { store, workflowId } = setup({ seed: 42, weights: { makespan: 0.5, weightedTardiness: 0.3 } })
  const { tools, calls } = makeMockTools()
  const cp = await runWorkflow(workflowId, buildBaselineFlow(), { store, tools, log: () => {} })

  assert.equal(cp.status, 'WAITING_APPROVAL', '终态应挂起在待人工确认进入评审')
  assert.deepEqual(
    cp.completedSteps.map((s) => s.node),
    ['check-master-data', 'create-baseline', 'poll-task'],
    '节点应按序执行到产出计划版本',
  )
  assert.equal(cp.current?.node, 'await-review-handoff')
  assert.equal(cp.pendingApproval?.tool, 'fjsp_submit_review', '挂起审批句柄 = 人工确认进入评审')
  assert.equal(cp.pendingApproval?.bizObject, 'pv-base-tsk-1')
  assert.equal(cp.refs.taskId, 'tsk-1')
  assert.equal(cp.refs.planVersionId, 'pv-base-tsk-1')

  // 写节点幂等键来自检查点；seed/weights 透传
  const create = calls.find((c) => c.name === 'fjsp_create_baseline')!
  assert.equal(create.args.idempotencyKey, `${workflowId}:create-baseline:1`)
  assert.equal(create.args.seed, 42)
  assert.deepEqual(create.args.weights, { makespan: 0.5, weightedTardiness: 0.3 })
  // 主数据检查是只读前置
  assert.deepEqual(calls[0].name, 'fjsp_get_dashboard')
  assert.deepEqual(calls[1].name, 'fjsp_list_process_templates')
  console.log('ok happy path：主数据就绪 → 基线任务 → 产出计划版本 → 挂起待人工（fjsp_submit_review 句柄）')
}

async function testMasterDataMissingSuspendsNeedsInput() {
  const { store, workflowId } = setup()
  const { tools, calls } = makeMockTools({ templates: 0 })
  const cp = await runWorkflow(workflowId, buildBaselineFlow(), { store, tools, log: () => {} })

  assert.equal(cp.status, 'WAITING_APPROVAL', '主数据不全应挂起')
  assert.equal(cp.current?.node, 'check-master-data')
  assert.equal(cp.pendingApproval, null, 'needs-input 挂起不带审批句柄')
  assert.match(cp.statusReason ?? '', /needs-input/)
  assert.match(cp.statusReason ?? '', /工艺模板/)
  assert.ok(!calls.some((c) => c.name === 'fjsp_create_baseline'), '主数据不全不得创建排程任务')
  console.log('ok 主数据不全（工艺模板=0）→ suspend(needs-input)，不发写操作')
}

async function testInfeasibleSuspendsNeedsHuman() {
  const { store } = setup()
  const { tools, calls } = makeMockTools({ taskTerminal: { status: 'SUCCESS', resultStatus: 'INFEASIBLE' } })
  const agentCalls: string[] = []
  const agent: BaselineAgent = {
    explainConflicts(input) {
      agentCalls.push('explainConflicts')
      assert.equal(input.outcome, 'infeasible')
      return 'mock 解释：无可用设备'
    },
  }
  const cp = await runWorkflow(workflowIdOf(store), buildBaselineFlow(), { store, tools, agent, log: () => {} })

  assert.equal(cp.status, 'WAITING_APPROVAL', 'INFEASIBLE 应挂起转人工')
  assert.equal(cp.current?.node, 'poll-task')
  assert.match(cp.statusReason ?? '', /不可行/)
  assert.match(cp.statusReason ?? '', /无"旧计划"语义|不做 FULL_RESCHEDULE/)
  assert.deepEqual(agentCalls, ['explainConflicts'], '应调用 Agent 解释冲突')
  assert.equal(cp.refs.planVersionId, null, 'INFEASIBLE 不得产出 planVersionId')
  // 关键：不触发任何重试/升级写操作
  assert.equal(calls.filter((c) => c.name === 'fjsp_create_baseline').length, 1, '基线不做 FULL_RESCHEDULE 升级重试')
  console.log('ok INFEASIBLE → 解释冲突后 suspend(needs-human)，不升级重排')
}

async function testTaskFailedSuspendsWithFallbackExplanation() {
  const { store, workflowId } = setup()
  const { tools } = makeMockTools({ taskTerminal: { status: 'FAILED' } })
  const cp = await runWorkflow(workflowId, buildBaselineFlow(), { store, tools, log: () => {} })

  assert.equal(cp.status, 'WAITING_APPROVAL')
  assert.equal(cp.current?.node, 'poll-task')
  assert.match(cp.statusReason ?? '', /失败/)
  assert.match(cp.statusReason ?? '', /algorithm-service 超时/, '未注入 Agent 时落确定性兜底解释')
  console.log('ok 任务 FAILED → 兜底冲突解释 + suspend(needs-human)')
}

async function testRunningSnapshotRetries() {
  const { store, workflowId } = setup()
  const { tools, calls } = makeMockTools({ runningOnce: true })
  const cp = await runWorkflow(workflowId, buildBaselineFlow(), { store, tools, log: () => {} })

  assert.equal(cp.status, 'WAITING_APPROVAL')
  assert.equal(calls.filter((c) => c.name === 'fjsp_task_status').length, 2, 'RUNNING 快照不得当终态，应 retry 再轮询')
  assert.equal(cp.refs.planVersionId, 'pv-base-tsk-1')
  console.log('ok RUNNING 快照（非终态）→ retry 继续轮询')
}

async function testInvalidWeightsTerminate() {
  const { store, workflowId } = setup({ weights: { makespan: -1 } })
  const { tools, calls } = makeMockTools()
  const cp = await runWorkflow(workflowId, buildBaselineFlow(), { store, tools, log: () => {} })

  assert.equal(cp.status, 'TERMINATED', 'weights 非法属不可恢复，应终止')
  assert.match(cp.statusReason ?? '', /weights/)
  assert.ok(!calls.some((c) => c.name === 'fjsp_create_baseline'), '非法 weights 不得发写请求')
  console.log('ok 触发输入 weights 非法 → terminate，不发写操作')
}

function testValidateBaselineWeights() {
  assert.deepEqual(validateBaselineWeights(undefined), [])
  assert.deepEqual(validateBaselineWeights({ makespan: 0.5, weightedTardiness: 0.2 }), [])
  assert.ok(validateBaselineWeights({ deltaPlan: 0.2 }).length > 0, 'deltaPlan 不在 fjsp-tools 可执行键集合内')
  assert.ok(validateBaselineWeights({ makespan: -0.1 }).length > 0, '负权重非法')
  assert.ok(validateBaselineWeights({ makespan: Number.NaN }).length > 0, '非有限数非法')
  assert.ok(validateBaselineWeights('x').length > 0, '非对象非法')
  console.log('ok validateBaselineWeights 键集合/数值校验')
}

function workflowIdOf(store: CheckpointStore): string {
  return store.list()[0].workflowId
}

const tests = [
  testHappyPathSuspendsAtHandoff,
  testMasterDataMissingSuspendsNeedsInput,
  testInfeasibleSuspendsNeedsHuman,
  testTaskFailedSuspendsWithFallbackExplanation,
  testRunningSnapshotRetries,
  testInvalidWeightsTerminate,
  testValidateBaselineWeights,
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
