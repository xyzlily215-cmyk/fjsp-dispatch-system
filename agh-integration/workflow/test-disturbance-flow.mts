// workflow/test-disturbance-flow.mts — disturbance-flow + agent-nodes 行为测试（mock tools + mock agent，不起服务）。
// 运行：cd agh-integration && npx tsx workflow/test-disturbance-flow.mts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { CheckpointStore } from './checkpoint.mts'
import { runWorkflow } from './runner.mts'
import { recover } from './recovery.mts'
import { buildDisturbanceFlow, type FlowTools, type DisturbanceEventInput } from './disturbance-flow.mts'
import { validateStrategySuggestion, DEFAULT_STRATEGY, type DisturbanceAgent } from './agent-nodes.mts'

let seq = 0
const dirs: string[] = []

const BREAKDOWN_EVENT: DisturbanceEventInput = {
  eventType: 'BREAKDOWN',
  machineId: 'M-03',
  occurredAt: '2026-11-02T06:00:00Z',
  repairDurationMinutes: 120,
  note: '主轴过热停机',
}

// 每个用例独立检查点目录 + 唯一 dedupeKey，互不污染
function setup(event: DisturbanceEventInput = BREAKDOWN_EVENT) {
  const dir = mkdtempSync(join(tmpdir(), 'flow-test-'))
  dirs.push(dir)
  const store = new CheckpointStore(dir)
  const { checkpoint } = store.create({
    type: 'DISTURBANCE',
    trigger: { source: 'test', dedupeKey: `t-${Date.now()}-${seq++}`, detail: event },
  })
  return { store, workflowId: checkpoint.workflowId }
}

interface MockOpts {
  eventInProcess?: boolean // register-event 返回 E_EVENT_IN_PROCESS
  localInfeasible?: boolean // LOCAL_RESCHEDULE 任务结果 INFEASIBLE
  fullStillInfeasible?: boolean // FULL_RESCHEDULE 重试仍 INFEASIBLE
  staleOnce?: boolean // submit-review 首次返回 E_VERSION_STALE
  crashOnPollOnce?: boolean // 首次 fjsp_task_status 抛错模拟崩溃
}

// mock 业务服务：内存维护事件/任务/计划版本现态，同时充当 recovery 的业务现态来源
function makeMockTools(opts: MockOpts = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const state = {
    planVersion: 3,
    taskSeq: 0,
    tasks: new Map<string, { mode: string; idempotencyKey?: string }>(),
    recentEvents: [] as { eventId: string }[],
    crashed: false,
    staleLeft: opts.staleOnce ? 1 : 0,
  }
  const tools: FlowTools = {
    async call(name, args = {}) {
      calls.push({ name, args })
      switch (name) {
        case 'fjsp_get_dashboard':
          return {
            ok: true,
            currentPlan: { id: 'pv-old', kpi: { cMaxMinutes: 480, weightedTardinessMinutes: 30, nTardy: 1, loadImbalance: 0.12 } },
            recentEvents: state.recentEvents,
          }
        case 'fjsp_report_breakdown': {
          if (opts.eventInProcess) return { ok: false, error: { code: 'E_EVENT_IN_PROCESS', message: '事件发生时间与在制工序冲突' } }
          const eventId = `ev-${state.recentEvents.length + 1}`
          state.recentEvents.push({ eventId })
          return { ok: true, event: { eventId, eventCode: 'EV-001', eventType: 'BREAKDOWN', machineId: args.machineId, occurredAt: args.occurredAt, status: 'OPEN' } }
        }
        case 'fjsp_experience_query':
          return { ok: true, records: [], recommendation: null }
        case 'fjsp_reschedule': {
          const taskId = `tsk-${++state.taskSeq}`
          state.tasks.set(taskId, { mode: args.mode as string, idempotencyKey: args.idempotencyKey as string })
          return { ok: true, task: { taskId, mode: args.mode, status: 'RUNNING' } }
        }
        case 'fjsp_task_status': {
          if (opts.crashOnPollOnce && !state.crashed) {
            state.crashed = true
            throw new Error('模拟进程崩溃（响应未返回，副作用未知）')
          }
          const t = state.tasks.get(args.taskId as string)!
          const infeasible =
            (t.mode === 'LOCAL_RESCHEDULE' && opts.localInfeasible) || (t.mode === 'FULL_RESCHEDULE' && opts.fullStillInfeasible)
          if (infeasible) {
            return {
              ok: true,
              task: {
                taskId: args.taskId,
                status: 'SUCCESS',
                resultStatus: 'INFEASIBLE',
                conflicts: [{ type: 'MACHINE_DOWN', machineId: 'M-03', message: '维修窗内不可用' }],
                kpi: null,
              },
            }
          }
          const planVersionId = `pv-new-${args.taskId}`
          return {
            ok: true,
            task: {
              taskId: args.taskId,
              status: 'SUCCESS',
              resultStatus: 'FEASIBLE',
              planVersionId,
              kpi: { cMaxMinutes: 470, weightedTardinessMinutes: 18, nTardy: 1, loadImbalance: 0.1, deltaPlan: 0.04 },
              conflicts: [],
            },
          }
        }
        case 'fjsp_get_plan':
          return { ok: true, plan: { id: args.planVersionId, version: state.planVersion, status: 'DRAFT', kpi: {} } }
        case 'fjsp_compare_plans':
          return { ok: true, diff: { summary: { changed: 3 }, kpiDiff: { weightedTardinessMinutes: -12 }, changedOperations: [], changedOperationsTotal: 3 } }
        case 'fjsp_submit_review': {
          if (state.staleLeft > 0) {
            state.staleLeft--
            return { ok: false, error: { code: 'E_VERSION_STALE', message: '乐观锁 version 过期' } }
          }
          state.planVersion++
          return { ok: true, plan: { id: args.planVersionId, status: 'REVIEW_PENDING', version: state.planVersion } }
        }
        default:
          throw new Error(`未 mock 的工具：${name}`)
      }
    },
  }
  return { tools, calls, state }
}

function makeMockAgent(suggestion: unknown = null) {
  const agentCalls: string[] = []
  const agent: DisturbanceAgent = {
    suggestStrategy(input) {
      agentCalls.push('suggestStrategy')
      assert.ok(input.event && 'experience' in input, '策略节点输入必须含事件与经验检索结果')
      return (
        suggestion ?? {
          mode: 'LOCAL_RESCHEDULE',
          weights: { weightedTardiness: 0.5, makespan: 0.3, deltaPlan: 0.1, machineChange: 0.1 },
          rationale: '历史同类故障 LOCAL 处置拖期最优',
        }
      )
    },
    explainConflicts(input) {
      agentCalls.push('explainConflicts')
      return `mock 解释：${input.outcome}（mode=${input.mode}）`
    },
    buildReviewMaterial(input) {
      agentCalls.push('buildReviewMaterial')
      assert.ok(!('tools' in input), '生成节点输入不得携带写操作入口')
      return '评审材料文本（mock agent）'
    },
  }
  return { agent, agentCalls }
}

const FLOW_ORDER = [
  'receive-event',
  'register-event',
  'query-experience',
  'suggest-strategy',
  'validate-strategy',
  'create-reschedule',
  'poll-task',
  'full-retry',
  'compare-plans',
  'review-material',
  'submit-review',
  'await-decision',
]

async function testHappyPath() {
  const { store, workflowId } = setup()
  const { tools, calls } = makeMockTools()
  const { agent, agentCalls } = makeMockAgent()
  const cp = await runWorkflow(workflowId, buildDisturbanceFlow(), { store, tools, agent, log: () => {} })

  assert.equal(cp.status, 'WAITING_APPROVAL', '终态应挂起在提交评审之后')
  assert.deepEqual(cp.completedSteps.map((s) => s.node), FLOW_ORDER.slice(0, -1), '节点应按序执行')
  assert.equal(cp.current?.node, 'await-decision', '挂起发生在待人工决策节点')
  assert.ok(cp.pendingApproval, '应有审批句柄')
  assert.equal(cp.pendingApproval!.tool, 'fjsp_approve_review')
  assert.equal(cp.pendingApproval!.bizObject, 'pv-new-tsk-1')
  assert.deepEqual(cp.refs, { eventId: 'ev-1', taskId: 'tsk-1', planVersionId: 'pv-new-tsk-1' })

  // 写节点幂等键必须来自检查点（wfId:node:seq）
  const keyOf = (node: string) => `${workflowId}:${node}:1`
  const writeKeys = Object.fromEntries(
    (['fjsp_report_breakdown', 'fjsp_reschedule', 'fjsp_submit_review'] as const).map((n) => [
      n,
      calls.filter((c) => c.name === n).map((c) => c.args.idempotencyKey),
    ]),
  )
  assert.deepEqual(writeKeys.fjsp_report_breakdown, [keyOf('register-event')])
  assert.deepEqual(writeKeys.fjsp_reschedule, [keyOf('create-reschedule')])
  assert.deepEqual(writeKeys.fjsp_submit_review, [keyOf('submit-review')])

  // 重调度入参来自经校验的 Agent 建议；对比基准为当前发布计划
  const resched = calls.find((c) => c.name === 'fjsp_reschedule')!
  assert.equal(resched.args.mode, 'LOCAL_RESCHEDULE')
  assert.equal(resched.args.eventId, 'ev-1')
  assert.equal(resched.args.oldPlanVersionId, 'pv-old')
  const cmp = calls.find((c) => c.name === 'fjsp_compare_plans')!
  assert.equal(cmp.args.planVersionId, 'pv-new-tsk-1')
  assert.equal(cmp.args.baselineVersionId, 'pv-old')

  assert.deepEqual(agentCalls, ['suggestStrategy', 'buildReviewMaterial'], '只在策略与材料节点调 Agent')
  const material = cp.completedSteps.find((s) => s.node === 'review-material')!.result!.material
  assert.equal(material, '评审材料文本（mock agent）')
  console.log('ok happy path：节点顺序、幂等键来源、终态挂起、refs')
}

async function testInfeasibleFullRetryOnce() {
  const { store, workflowId } = setup()
  const { tools, calls } = makeMockTools({ localInfeasible: true })
  const { agent, agentCalls } = makeMockAgent()
  const cp = await runWorkflow(workflowId, buildDisturbanceFlow(), { store, tools, agent, log: () => {} })

  assert.equal(cp.status, 'WAITING_APPROVAL', 'FULL 重试可行后流程应走到评审挂起')
  const reschedCalls = calls.filter((c) => c.name === 'fjsp_reschedule')
  assert.deepEqual(reschedCalls.map((c) => c.args.mode), ['LOCAL_RESCHEDULE', 'FULL_RESCHEDULE'], 'INFEASIBLE 后升级 FULL 重试一次')
  assert.equal(reschedCalls[1].args.idempotencyKey, `${workflowId}:full-retry:1`, '重试写的幂等键来自 full-retry 步骤')
  assert.ok(agentCalls.includes('explainConflicts'), '重试前必须先解释冲突')
  const retryStep = cp.completedSteps.find((s) => s.node === 'full-retry')!
  assert.equal(retryStep.result!.retriedFrom, 'infeasible')
  assert.equal(cp.refs.taskId, 'tsk-2')
  assert.equal(cp.refs.planVersionId, 'pv-new-tsk-2')
  console.log('ok INFEASIBLE → 解释冲突 → FULL_RESCHEDULE 重试一次 → 继续')
}

async function testFullRetryStillInfeasibleSuspends() {
  const { store, workflowId } = setup()
  const { tools, calls } = makeMockTools({ localInfeasible: true, fullStillInfeasible: true })
  const { agent } = makeMockAgent()
  const cp = await runWorkflow(workflowId, buildDisturbanceFlow(), { store, tools, agent, log: () => {} })

  assert.equal(cp.status, 'WAITING_APPROVAL')
  assert.equal(cp.pendingApproval, null, 'needs-human 挂起不带审批句柄')
  assert.match(cp.statusReason ?? '', /转人工/)
  assert.equal(calls.filter((c) => c.name === 'fjsp_reschedule').length, 2, '只允许一次升级重试')
  assert.equal(calls.filter((c) => c.name === 'fjsp_compare_plans').length, 0, '挂起后不得执行后续节点')
  console.log('ok FULL 重试仍 INFEASIBLE → suspend(needs-human)')
}

async function testEventInProcessSuspendsWithoutMovingTime() {
  const { store, workflowId } = setup()
  const { tools, calls } = makeMockTools({ eventInProcess: true })
  const { agent } = makeMockAgent()
  const cp = await runWorkflow(workflowId, buildDisturbanceFlow(), { store, tools, agent, log: () => {} })

  assert.equal(cp.status, 'WAITING_APPROVAL')
  assert.equal(cp.pendingApproval, null)
  assert.match(cp.statusReason ?? '', /E_EVENT_IN_PROCESS/)
  const report = calls.filter((c) => c.name === 'fjsp_report_breakdown')
  assert.equal(report.length, 1, '不得盲目重试相同参数')
  assert.equal(report[0].args.occurredAt, BREAKDOWN_EVENT.occurredAt, '严禁自动移动真实事件时间')
  assert.equal(calls.filter((c) => c.name === 'fjsp_reschedule').length, 0)
  console.log('ok E_EVENT_IN_PROCESS → needs-human 且事件时间未被改')
}

async function testVersionStaleRereadAndRetry() {
  const { store, workflowId } = setup()
  const { tools, calls } = makeMockTools({ staleOnce: true })
  const { agent } = makeMockAgent()
  const cp = await runWorkflow(workflowId, buildDisturbanceFlow(), { store, tools, agent, log: () => {} })

  assert.equal(cp.status, 'WAITING_APPROVAL')
  const submits = calls.filter((c) => c.name === 'fjsp_submit_review')
  assert.equal(submits.length, 2, 'E_VERSION_STALE 后应重试一次')
  assert.ok(submits.every((c) => c.args.idempotencyKey === `${workflowId}:submit-review:1`), '重试复用同一幂等键')
  assert.equal(calls.filter((c) => c.name === 'fjsp_get_plan').length, 2, '每次重试前重读业务现态（最新 version）')
  const step = cp.completedSteps.find((s) => s.node === 'submit-review')!
  assert.equal(step.attempt, 2)
  console.log('ok E_VERSION_STALE → 重读 version 后限次重试')
}

function testValidateStrategySuggestion() {
  // 合法输入原样通过
  const good = validateStrategySuggestion({ mode: 'FULL_RESCHEDULE', weights: { makespan: 0.5, deltaPlan: 0.5 }, rationale: '扰动面大' })
  assert.ok(good.ok)
  assert.equal(good.strategy.mode, 'FULL_RESCHEDULE')

  // 错 mode / 越界 weights / 空 rationale → fallback（默认策略 + 拒绝原因）
  const bad = validateStrategySuggestion({ mode: 'GLOBAL', weights: { makespan: -1, unknownKey: 0.5 }, rationale: '  ' })
  assert.ok(!bad.ok)
  assert.equal(bad.strategy.mode, DEFAULT_STRATEGY.mode)
  assert.deepEqual(bad.strategy.weights, DEFAULT_STRATEGY.weights)
  assert.ok(bad.rejectedReasons.length >= 3)
  assert.ok(bad.rejectedReasons.some((r) => r.includes('mode')))
  assert.ok(bad.rejectedReasons.some((r) => r.includes('weights.makespan')))
  assert.ok(bad.rejectedReasons.some((r) => r.includes('unknownKey')))
  assert.ok(bad.rejectedReasons.some((r) => r.includes('rationale')))

  // 非对象 / weights 缺失 / 键数超限 → fallback
  assert.ok(!validateStrategySuggestion(null).ok)
  assert.ok(!validateStrategySuggestion({ mode: 'LOCAL_RESCHEDULE', rationale: 'x' }).ok)
  const tooMany = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`makespan`, i]).map(([, ], i) => [`k${i}`, 0.1]))
  assert.ok(!validateStrategySuggestion({ mode: 'LOCAL_RESCHEDULE', weights: tooMany, rationale: 'x' }).ok)

  // NaN / Infinity 同样拒绝
  assert.ok(!validateStrategySuggestion({ mode: 'LOCAL_RESCHEDULE', weights: { makespan: Number.NaN }, rationale: 'x' }).ok)
  console.log('ok validateStrategySuggestion：合法通过、非法落 fallback')
}

async function testInvalidAgentOutputFallsBack() {
  const { store, workflowId } = setup()
  const { tools, calls } = makeMockTools()
  const { agent } = makeMockAgent({ mode: 'X', weights: { makespan: -5 }, rationale: '' })
  const cp = await runWorkflow(workflowId, buildDisturbanceFlow(), { store, tools, agent, log: () => {} })

  assert.equal(cp.status, 'WAITING_APPROVAL', '非法建议落 fallback 后流程继续')
  const step = cp.completedSteps.find((s) => s.node === 'validate-strategy')!
  assert.ok(Array.isArray(step.result!.fallbackReasons) && (step.result!.fallbackReasons as string[]).length >= 3)
  const resched = calls.find((c) => c.name === 'fjsp_reschedule')!
  assert.equal(resched.args.mode, 'LOCAL_RESCHEDULE', 'fallback 走默认策略 LOCAL 优先')
  assert.deepEqual(resched.args.weights, DEFAULT_STRATEGY.weights)
  console.log('ok Agent 非法输出 → fallback 默认策略，流程继续')
}

async function testCrashAndRecoveryResume() {
  const { store, workflowId } = setup()
  const { tools, calls, state } = makeMockTools({ crashOnPollOnce: true })
  const { agent } = makeMockAgent()
  const nodes = buildDisturbanceFlow()
  const log = () => {}

  // 第一次运行：poll-task 抛出无错误码异常（模拟崩溃）→ needs-human 挂起，步骤停留在 intent
  const cp1 = await runWorkflow(workflowId, buildDisturbanceFlow(), { store, tools, agent, log })
  assert.equal(cp1.status, 'WAITING_APPROVAL')
  assert.equal(cp1.pendingApproval, null)
  assert.equal(cp1.current?.node, 'poll-task')
  assert.equal(cp1.current?.phase, 'intent', '崩溃留下的未了结意图')

  // 恢复：读业务现态（mock）核对已完成步骤 + 当前步骤副作用，决策重做
  const decision = await recover(store, workflowId, {
    readDashboard: async () => ({ ok: true, currentPlan: { id: 'pv-old' }, recentEvents: state.recentEvents }),
    readTask: async (taskId) => ({ ok: true, task: { taskId, status: 'RUNNING' } }),
    verifyStep: () => 'not-done', // poll-task 是只读节点，无副作用，重做安全
  })
  assert.equal(decision.action, 'resume')
  if (decision.action === 'resume') {
    assert.equal(decision.skipExecute, false)
    assert.equal(decision.idempotencyKey, `${workflowId}:poll-task:1`, '重做复用原幂等键')
  }

  // 恢复决策放行（等价审批裁决清除挂起）后续跑：poll-task 重跑成功，流程走完
  store.clearApproval(workflowId)
  const cp2 = await runWorkflow(workflowId, nodes, { store, tools, agent, log })
  assert.equal(cp2.status, 'WAITING_APPROVAL')
  assert.equal(calls.filter((c) => c.name === 'fjsp_reschedule').length, 1, '恢复不得重复执行写操作')
  assert.equal(calls.filter((c) => c.name === 'fjsp_report_breakdown').length, 1)
  const pollStep = cp2.completedSteps.find((s) => s.node === 'poll-task')!
  assert.equal(pollStep.attempt, 2)
  assert.equal(pollStep.idempotencyKey, `${workflowId}:poll-task:1`)
  assert.equal(cp2.refs.planVersionId, 'pv-new-tsk-1')
  console.log('ok 中间崩溃 + recovery 核对现态 → 复用原幂等键续跑')
}

async function testInvalidTriggerTerminates() {
  const { store, workflowId } = setup({ eventType: 'BREAKDOWN', machineId: 'M-03' } as DisturbanceEventInput)
  const { tools } = makeMockTools()
  const cp = await runWorkflow(workflowId, buildDisturbanceFlow(), { store, tools, agent: makeMockAgent().agent, log: () => {} })
  assert.equal(cp.status, 'TERMINATED', '触发输入缺必填字段属不可恢复，应终止')
  assert.match(cp.statusReason ?? '', /缺少必填字段/)
  console.log('ok 触发输入不完整 → terminate（不可恢复）')
}

const tests = [
  testHappyPath,
  testInfeasibleFullRetryOnce,
  testFullRetryStillInfeasibleSuspends,
  testEventInProcessSuspendsWithoutMovingTime,
  testVersionStaleRereadAndRetry,
  testValidateStrategySuggestion,
  testInvalidAgentOutputFallsBack,
  testCrashAndRecoveryResume,
  testInvalidTriggerTerminates,
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
