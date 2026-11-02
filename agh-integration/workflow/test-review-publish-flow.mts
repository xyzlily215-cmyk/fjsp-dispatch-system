// workflow/test-review-publish-flow.mts — review-publish-flow 行为测试（mock tools + mock agent，不起服务）。
// 运行：cd agh-integration && ./agnes-harness/node_modules/.bin/tsx workflow/test-review-publish-flow.mts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { CheckpointStore } from './checkpoint.mts'
import { runWorkflow } from './runner.mts'
import {
  buildReviewPublishFlow,
  settleReviewPublishOutcome,
  REVIEW_DECISION_ROLES,
  PUBLISH_CONFIRM_ROLES,
  type ReviewPublishInput,
} from './review-publish-flow.mts'
import { makeExperienceFeedbackHook, type FlowTools } from './flow-common.mts'
import type { ReviewPublishAgent } from './agent-nodes.mts'

let seq = 0
const dirs: string[] = []

function setup(input: ReviewPublishInput = { planVersionId: 'pv-new' }) {
  const dir = mkdtempSync(join(tmpdir(), 'review-test-'))
  dirs.push(dir)
  const store = new CheckpointStore(dir)
  const { checkpoint } = store.create({
    type: 'REVIEW_PUBLISH',
    trigger: { source: 'test', dedupeKey: `t-${Date.now()}-${seq++}`, detail: input },
  })
  return { store, workflowId: checkpoint.workflowId }
}

// mock 业务服务：内存维护计划版本状态机（DRAFT → REVIEW_PENDING → REVIEWED/REJECTED → …）
function makeMockTools() {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const state = {
    plan: { id: 'pv-new', versionCode: 'V-NEW', status: 'DRAFT', version: 1, kpi: { cMaxMinutes: 470, weightedTardinessMinutes: 18, nTardy: 1, loadImbalance: 0.1 } } as Record<string, unknown>,
  }
  const tools: FlowTools = {
    async call(name, args = {}) {
      calls.push({ name, args })
      switch (name) {
        case 'fjsp_get_plan': {
          if (args.planVersionId === 'pv-old') {
            return { ok: true, plan: { id: 'pv-old', versionCode: 'V-OLD', status: 'PUBLISHED', version: 9, kpi: { cMaxMinutes: 480, weightedTardinessMinutes: 30, nTardy: 1, loadImbalance: 0.12 } } }
          }
          return { ok: true, plan: { ...state.plan } }
        }
        case 'fjsp_get_dashboard':
          return { ok: true, currentPlan: { id: 'pv-old', versionCode: 'V-OLD', kpi: { cMaxMinutes: 480 } }, orderStats: {}, machines: [{ machineId: 'M-01' }] }
        case 'fjsp_compare_plans':
          return { ok: true, diff: { summary: { changed: 2 }, kpiDiff: { weightedTardinessMinutes: -12 }, changedOperations: [], changedOperationsTotal: 2 } }
        case 'fjsp_submit_review':
          assert.equal(state.plan.status, 'DRAFT', 'submit_review 只能从 DRAFT 发起（mock 守卫）')
          state.plan = { ...state.plan, status: 'REVIEW_PENDING', version: (state.plan.version as number) + 1 }
          return { ok: true, plan: { ...state.plan } }
        case 'fjsp_revise_plan':
          assert.equal(state.plan.status, 'REJECTED', 'revise 只能从 REJECTED 发起（mock 守卫）')
          state.plan = { ...state.plan, status: 'DRAFT', version: (state.plan.version as number) + 1 }
          return { ok: true, plan: { ...state.plan } }
        case 'fjsp_publish':
          assert.equal(state.plan.status, 'REVIEWED', 'publish 只能从 REVIEWED 发起（mock 守卫）')
          state.plan = { ...state.plan, status: 'PUBLISHED', version: (state.plan.version as number) + 1 }
          return { ok: true, plan: { ...state.plan }, ganttUrl: 'http://localhost:5173/#/resource-gantt?planVersion=pv-new' }
        case 'fjsp_experience_feedback':
          return { ok: true, feedback: { experienceId: args.experienceId, outcome: args.outcome }, total: 3 }
        default:
          throw new Error(`未 mock 的工具：${name}`)
      }
    },
  }
  return { tools, calls, state }
}

function makeMockAgent() {
  const agent: ReviewPublishAgent = {
    buildPlanReviewMaterial(input) {
      assert.ok(input.planVersionId && input.plan, '生成节点输入必须含计划版本')
      assert.ok(!('tools' in input), '生成节点输入不得携带写操作入口')
      return '评审材料文本（mock agent）'
    },
  }
  return agent
}

async function runToReviewSuspend(store: CheckpointStore, workflowId: string, tools: FlowTools) {
  const cp = await runWorkflow(workflowId, buildReviewPublishFlow(), { store, tools, agent: makeMockAgent(), log: () => {} })
  assert.equal(cp.status, 'WAITING_APPROVAL', '应挂起在人工评审决策点')
  assert.equal(cp.current?.node, 'await-review')
  assert.equal(cp.pendingApproval?.tool, 'fjsp_approve_review')
  assert.deepEqual(cp.pendingApproval?.requiredRoles, REVIEW_DECISION_ROLES, '评审决策点角色 = REVIEWER 级')
  return cp
}

async function testApproveThenPublishConfirmPublishes() {
  const { store, workflowId } = setup()
  const { tools, calls, state } = makeMockTools()
  await runToReviewSuspend(store, workflowId, tools)

  // 第一个独立人工决策点：评审通过
  state.plan.status = 'REVIEWED' // 模拟人工经审批执行 fjsp_approve_review(APPROVE) 后的业务现态
  let cp = await settleReviewPublishOutcome(store, workflowId, { store, tools, log: () => {} }, 'approved')
  assert.equal(cp.status, 'WAITING_APPROVAL', '评审通过后不得直接发布，应挂起等独立发布确认')
  assert.equal(cp.current?.node, 'await-publish-confirm')
  assert.equal(cp.pendingApproval?.tool, 'fjsp_publish')
  assert.deepEqual(cp.pendingApproval?.requiredRoles, PUBLISH_CONFIRM_ROLES, '发布确认点角色 = PRODUCTION_MANAGER 级')
  assert.ok(!calls.some((c) => c.name === 'fjsp_publish'), '未经独立确认不得调 fjsp_publish')

  // 第二个独立人工决策点：确认发布
  cp = await settleReviewPublishOutcome(store, workflowId, { store, tools, log: () => {} }, 'approved')
  assert.equal(cp.status, 'COMPLETED', '确认发布后流程应完成')
  const pub = calls.find((c) => c.name === 'fjsp_publish')!
  assert.equal(pub.args.idempotencyKey, `${workflowId}:publish:1`, '发布节点幂等键 = 检查点步骤键')
  assert.equal(state.plan.status, 'PUBLISHED')
  assert.deepEqual(
    cp.completedSteps.map((s) => s.node),
    ['load-plan', 'compare-plans', 'review-material', 'submit-review', 'await-review', 'await-publish-confirm', 'publish'],
  )
  console.log('ok 评审通过 + 人工独立确认发布 → 发布，两个决策点角色与幂等键正确')
}

async function testApproveButNoPublishConfirmDoesNotPublish() {
  const { store, workflowId } = setup()
  const { tools, calls, state } = makeMockTools()
  await runToReviewSuspend(store, workflowId, tools)

  state.plan.status = 'REVIEWED'
  const cp1 = await settleReviewPublishOutcome(store, workflowId, { store, tools, log: () => {} }, 'approved')
  assert.equal(cp1.current?.node, 'await-publish-confirm')

  // 发布确认被拒绝 = 不发布，显式终止
  const cp2 = await settleReviewPublishOutcome(store, workflowId, { store, tools, log: () => {} }, 'rejected')
  assert.equal(cp2.status, 'TERMINATED')
  assert.match(cp2.statusReason ?? '', /不执行后续发布动作|不发布/)
  assert.ok(!calls.some((c) => c.name === 'fjsp_publish'), '发布确认被拒绝不得调 fjsp_publish')
  assert.equal(state.plan.status, 'REVIEWED', '计划保持 REVIEWED，不发布')
  console.log('ok 评审通过但未确认发布 → 不发布（显式终止）')
}

async function testRejectFeedbackReviseOnceThenTerminate() {
  const { store, workflowId } = setup({ planVersionId: 'pv-new', experienceIds: ['exp-1', 'exp-2'] })
  const { tools, calls, state } = makeMockTools()
  await runToReviewSuspend(store, workflowId, tools)

  // 第一次评审拒绝：反馈 + 返修 + 重新提交 + 重新挂起
  state.plan.status = 'REJECTED'
  const cp1 = await settleReviewPublishOutcome(store, workflowId, { store, tools, log: () => {} }, 'rejected')
  assert.equal(cp1.status, 'WAITING_APPROVAL', '首次拒绝应走返修回路并重新挂起')
  assert.equal(cp1.current?.node, 'await-review')
  const feedback1 = calls.filter((c) => c.name === 'fjsp_experience_feedback')
  assert.equal(feedback1.length, 2, '对本次处置检索到的 2 条经验各追加一条 rejected 反馈')
  assert.ok(feedback1.every((c) => c.args.outcome === 'rejected'))
  assert.deepEqual(feedback1.map((c) => c.args.experienceId), ['exp-1', 'exp-2'])
  // 返修与重新提交的幂等键 = 各自步骤键
  assert.equal(calls.find((c) => c.name === 'fjsp_revise_plan')!.args.idempotencyKey, `${workflowId}:revise-after-reject:1`)
  assert.equal(calls.filter((c) => c.name === 'fjsp_submit_review').length, 2, '初始提交 + 返修后重新提交')
  assert.equal(state.plan.status, 'REVIEW_PENDING', '返修后应重新提交评审')
  const fbStep = cp1.completedSteps.find((s) => s.node === 'experience-feedback')!
  assert.deepEqual(fbStep.result, { outcome: 'rejected', sent: 2, total: 2 })

  // 第二次评审拒绝：已达返修上限，显式终止
  state.plan.status = 'REJECTED'
  const cp2 = await settleReviewPublishOutcome(store, workflowId, { store, tools, log: () => {} }, 'rejected')
  assert.equal(cp2.status, 'TERMINATED')
  assert.match(cp2.statusReason ?? '', /返修 1 次达上限/)
  assert.equal(calls.filter((c) => c.name === 'fjsp_revise_plan').length, 1, '返修限 1 次，不得第二次 revise')
  assert.ok(!calls.some((c) => c.name === 'fjsp_publish'))
  console.log('ok 评审拒绝 → 反馈 + 返修一次 + 重新挂起；再次拒绝 → 显式终止')
}

async function testRejectWithoutExperienceSkipsFeedback() {
  const { store, workflowId } = setup() // 触发输入无 experienceIds
  const { tools, calls, state } = makeMockTools()
  await runToReviewSuspend(store, workflowId, tools)

  state.plan.status = 'REJECTED'
  const cp = await settleReviewPublishOutcome(store, workflowId, { store, tools, log: () => {} }, 'rejected')
  assert.equal(cp.status, 'WAITING_APPROVAL', '首次拒绝仍走返修回路')
  assert.ok(!calls.some((c) => c.name === 'fjsp_experience_feedback'), '无经验检索记录不得调 feedback')
  const fbStep = cp.completedSteps.find((s) => s.node === 'experience-feedback')!
  assert.equal((fbStep.result as { skipped?: boolean }).skipped, true, '反馈步骤显式标记跳过')
  console.log('ok 无经验检索记录 → 反馈步骤显式跳过，不调用 fjsp_experience_feedback')
}

async function testPublishConfirmRejectDoesNotFeedback() {
  // onRejected 通用钩子（disturbance-flow 同款接线）：只对评审决策点生效
  const { store, workflowId } = setup({ planVersionId: 'pv-new', experienceIds: ['exp-1'] })
  const { tools, calls, state } = makeMockTools()
  const deps = { store, tools, log: () => {}, onRejected: makeExperienceFeedbackHook({ tools, log: () => {} }) }
  await runToReviewSuspend(store, workflowId, tools)

  state.plan.status = 'REVIEWED'
  await settleReviewPublishOutcome(store, workflowId, deps, 'approved')
  const cp = await settleReviewPublishOutcome(store, workflowId, deps, 'rejected') // 拒绝的是发布确认点
  assert.equal(cp.status, 'TERMINATED')
  assert.ok(!calls.some((c) => c.name === 'fjsp_experience_feedback'), '发布确认点拒绝不触发经验反馈')
  console.log('ok 发布确认点拒绝 → 通用钩子按 tool 过滤，不追加反馈')
}

async function testRejectWithHookFeedsBackForDisturbanceStyleWiring() {
  // 通用钩子路径：disturbance-flow 复用 settleApprovalOutcome + onRejected 接线（5.1 遗留）
  const { store, workflowId } = setup({ planVersionId: 'pv-new', experienceIds: ['exp-9'] })
  const { tools, calls, state } = makeMockTools()
  const deps = { store, tools, log: () => {}, onRejected: makeExperienceFeedbackHook({ tools, log: () => {} }) }
  await runToReviewSuspend(store, workflowId, tools)

  state.plan.status = 'REJECTED'
  const cp = await settleReviewPublishOutcome(store, workflowId, deps, 'rejected')
  // review-publish 专属分支接管拒绝（返修回路），通用钩子不再重复反馈：反馈由专属分支的经验反馈步骤产出
  assert.equal(cp.status, 'WAITING_APPROVAL')
  const feedback = calls.filter((c) => c.name === 'fjsp_experience_feedback')
  assert.equal(feedback.length, 1, '拒绝路径恰好一次反馈（专属分支产出，钩子不重复）')
  assert.equal(feedback[0].args.experienceId, 'exp-9')
  console.log('ok 评审拒绝 + onRejected 钩子：反馈由流程专属分支产出一次，不重复')
}

const tests = [
  testApproveThenPublishConfirmPublishes,
  testApproveButNoPublishConfirmDoesNotPublish,
  testRejectFeedbackReviseOnceThenTerminate,
  testRejectWithoutExperienceSkipsFeedback,
  testPublishConfirmRejectDoesNotFeedback,
  testRejectWithHookFeedsBackForDisturbanceStyleWiring,
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
