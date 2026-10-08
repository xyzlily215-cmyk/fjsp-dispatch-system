// fjsp-tools: AGH backend plugin exposing the FJSP scheduling business service
// (Spring Boot, default http://localhost:8081/api/v1) as agent tools.
// Self-contained ESM, no external dependencies; tool schemas are hand-tagged
// TypeBox schemas like examples/packages/hot-tool-plugin.
import { readFileSync } from 'node:fs'

const Kind = Symbol.for('TypeBox.Kind')

const S = (extra = {}) => ({ [Kind]: 'String', type: 'string', ...extra })
const N = (extra = {}) => ({ [Kind]: 'Number', type: 'number', ...extra })
const I = (extra = {}) => ({ [Kind]: 'Integer', type: 'integer', ...extra })
const Obj = (properties, required = []) => ({
  [Kind]: 'Object',
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const StrArr = () => ({ [Kind]: 'Array', type: 'array', items: S(), maxItems: 200 })

const WEIGHTS = Obj({
  makespan: N({ description: '最大完工时间权重' }),
  weightedTardiness: N({ description: '加权拖期权重' }),
  loadImbalance: N({ description: '负载不均衡权重' }),
})

const READ = {
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: true,
  replay: 'safe',
  costHint: undefined,
  deferLoading: false,
  requiresApproval: 'never',
}
const WRITE = {
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false,
  isOpenWorld: true,
  replay: 'idempotent',
  costHint: undefined,
  deferLoading: false,
  requiresApproval: 'always',
}
const HIGH_RISK = {
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false,
  isOpenWorld: true,
  replay: 'never',
  costHint: undefined,
  deferLoading: false,
  requiresApproval: 'always',
}
const DESTRUCTIVE = {
  isReadOnly: false,
  isDestructive: true,
  isConcurrencySafe: false,
  isOpenWorld: true,
  replay: 'never',
  costHint: undefined,
  deferLoading: false,
  requiresApproval: 'always',
}

const BASE = (process.env.FJSP_API_BASE || 'http://localhost:8081/api/v1').replace(/\/+$/, '')

// The plugin runs inside the AGH daemon's extension host, so it cannot see the
// driver process's env. The driver drops the session id in this file as a
// fallback when AGH_SESSION_ID is not set in the daemon environment.
const SESSION_ID_FILE = new URL('../.agh-session-id', import.meta.url)

function aghSessionId() {
  if (process.env.AGH_SESSION_ID) return process.env.AGH_SESSION_ID
  try {
    return readFileSync(SESSION_ID_FILE, 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

async function api(method, path, body) {
  const headers = {
    Accept: 'application/json',
    'X-Source': 'agh',
    'X-Operator-Id': process.env.FJSP_OPERATOR || 'agh-agent',
  }
  const sessionId = aghSessionId()
  if (sessionId) headers['X-AGH-Session-Id'] = sessionId
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    headers['Idempotency-Key'] = crypto.randomUUID()
  }
  let res
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    return {
      ok: false,
      error: { code: 'FJSP_UNREACHABLE', message: `无法连接 FJSP 业务服务 ${BASE}，请确认业务服务已启动` },
    }
  }
  let env
  try {
    env = await res.json()
  } catch {
    return { ok: false, error: { code: 'FJSP_BAD_RESPONSE', httpStatus: res.status } }
  }
  if (!res.ok || (env && typeof env.code === 'string' && env.code !== 'OK')) {
    return {
      ok: false,
      error: {
        code: (env && env.code) || `FJSP_HTTP_${res.status}`,
        message: (env && env.message) || '',
        httpStatus: res.status,
        requestId: env && env.requestId,
      },
    }
  }
  return { ok: true, data: env ? env.data : undefined }
}

function result(value) {
  // JSON round-trip strips undefined fields; Host's isToolResult() rejects non-JSON structured values.
  const clean = JSON.parse(JSON.stringify(value))
  return {
    content: [{ type: 'text', text: JSON.stringify(clean) }],
    structured: clean,
    ...(value && value.ok === false ? { isError: true } : {}),
  }
}

const trimKpi = (kpi) =>
  kpi && {
    cMaxMinutes: kpi.cMaxMinutes,
    weightedTardinessMinutes: kpi.weightedTardinessMinutes,
    nTardy: kpi.nTardy,
    loadImbalance: kpi.loadImbalance,
    ...(kpi.deltaPlan ? { deltaPlan: kpi.deltaPlan } : {}),
  }

const trimTask = (t) => ({
  taskId: t.taskId,
  taskCode: t.taskCode,
  mode: t.mode,
  status: t.status,
  progress: t.progress,
  resultStatus: t.resultStatus,
  planVersionId: t.planVersionId,
  createdAt: t.createdAt,
})

const trimVersion = (v) => ({
  id: v.id,
  versionCode: v.versionCode,
  status: v.status,
  candidateType: v.candidateType,
  version: v.version,
  parentId: v.parentId,
  taskId: v.taskId,
  publishedAt: v.publishedAt,
  createdAt: v.createdAt,
  kpi: trimKpi(v.kpi),
})

async function getVersion(id) {
  const r = await api('GET', `/plan-versions/${id}`)
  return r.ok ? r.data : null
}

const tools = [
  {
    name: 'fjsp_get_dashboard',
    description:
      '获取 FJSP 调度系统概览：当前发布计划及 KPI（makespan/加权拖期/负载/扰动率 Delta_plan）、订单统计、设备状态、最近事件与调度任务。',
    parameters: Obj({}),
    meta: READ,
    async execute() {
      const r = await api('GET', '/dashboard')
      if (!r.ok) return result(r)
      const d = r.data || {}
      return result({
        ok: true,
        currentPlan: d.currentPlan
          ? {
              id: d.currentPlan.id,
              versionCode: d.currentPlan.versionCode,
              status: d.currentPlan.status,
              publishedAt: d.currentPlan.publishedAt,
              kpi: trimKpi(d.currentPlan.kpi),
            }
          : null,
        orderStats: d.orderStats,
        machines: (d.machines || []).map((m) => ({
          machineId: m.machineId,
          workCenterId: m.workCenterId,
          status: m.status,
          productFamilies: m.productFamilies,
        })),
        recentEvents: (d.recentEvents || []).slice(0, 8),
        recentTasks: (d.recentTasks || []).slice(0, 8).map(trimTask),
      })
    },
  },
  {
    name: 'fjsp_list_machines',
    description: '列出全部设备（设备号、工作中心、状态、可加工产品族）。',
    parameters: Obj({}),
    meta: READ,
    async execute() {
      const r = await api('GET', '/machines')
      if (!r.ok) return result(r)
      return result({
        ok: true,
        machines: (r.data || []).map((m) => ({
          machineId: m.machineId,
          workCenterId: m.workCenterId,
          status: m.status,
          productFamilies: m.productFamilies,
        })),
      })
    },
  },
  {
    name: 'fjsp_create_baseline',
    description:
      '创建基线排程任务（mode=BASELINE）。可选指定订单子集、目标权重与随机种子。返回调度任务，需用 fjsp_task_status 轮询直到 SUCCESS/FAILED。',
    parameters: Obj({
      orderIds: StrArr(),
      weights: WEIGHTS,
      seed: I({ description: '随机种子 randomSeed' }),
    }),
    meta: WRITE,
    async execute({ orderIds, weights, seed }) {
      const body = { mode: 'BASELINE' }
      if (Array.isArray(orderIds) && orderIds.length > 0) body.orderIds = orderIds
      if (weights) body.objectiveWeights = weights
      if (typeof seed === 'number') body.algorithm = { randomSeed: seed }
      const r = await api('POST', '/schedule-tasks', body)
      if (!r.ok) return result(r)
      return result({ ok: true, task: trimTask(r.data || {}) })
    },
  },
  {
    name: 'fjsp_report_breakdown',
    description:
      '登记设备故障事件。occurredAt 为 ISO 时间（如 2026-09-17T06:00:00Z，注意时区）；若与正在执行的工序冲突，服务会返回 E_EVENT_IN_PROCESS，此时应换一个不冲突的时间重试。成功后用返回的 eventId 调 fjsp_reschedule。',
    parameters: Obj(
      {
        machineId: S({ description: '设备号，如 M-03' }),
        occurredAt: S({ description: '故障发生时间，ISO 8601' }),
        repairDurationMinutes: I({ description: '预计维修时长（分钟）' }),
        note: S(),
      },
      ['machineId', 'occurredAt', 'repairDurationMinutes'],
    ),
    meta: WRITE,
    async execute({ machineId, occurredAt, repairDurationMinutes, note }) {
      const r = await api('POST', '/events/breakdowns', {
        machineId,
        occurredAt,
        repairDurationMinutes,
        source: 'AGH_AGENT',
        ...(note ? { note } : {}),
      })
      if (!r.ok) return result(r)
      const d = r.data || {}
      return result({
        ok: true,
        event: {
          eventId: d.eventId ?? d.id,
          eventCode: d.eventCode,
          eventType: d.eventType,
          machineId: d.machineId,
          occurredAt: d.occurredAt,
          status: d.status,
        },
      })
    },
  },
  {
    name: 'fjsp_insert_order',
    description:
      '登记插单事件（紧急插单/普通新订单）。成功后用返回的 eventId 调 fjsp_reschedule。时间字段为 ISO 8601。',
    parameters: Obj(
      {
        orderCode: S({ description: '订单号，需唯一' }),
        productFamily: S({ description: '产品族，如 轴类A/盘类B/壳体C' }),
        quantity: I(),
        arrivalAt: S({ description: '订单到达时间，ISO 8601' }),
        dueAt: S({ description: '交期，ISO 8601' }),
        priority: I({ description: '优先级，数值越大越紧急' }),
        occurredAt: S({ description: '事件登记时间，ISO 8601' }),
        subType: S({ description: '子类型，默认 URGENT_INSERT' }),
        note: S(),
      },
      ['orderCode', 'productFamily', 'quantity', 'arrivalAt', 'dueAt', 'priority', 'occurredAt'],
    ),
    meta: WRITE,
    async execute({ orderCode, productFamily, quantity, arrivalAt, dueAt, priority, occurredAt, subType, note }) {
      const r = await api('POST', '/events/new-orders', {
        subType: subType || 'URGENT_INSERT',
        orderCode,
        productFamily,
        quantity,
        arrivalAt,
        dueAt,
        priority,
        occurredAt,
        ...(note ? { note } : {}),
      })
      if (!r.ok) return result(r)
      const d = r.data || {}
      return result({
        ok: true,
        event: {
          eventId: d.eventId ?? d.id,
          eventCode: d.eventCode,
          eventType: d.eventType,
          subType: d.subType,
          occurredAt: d.occurredAt,
          status: d.status,
        },
      })
    },
  },
  {
    name: 'fjsp_reschedule',
    description:
      '创建重调度任务。mode=LOCAL_RESCHEDULE（局部，优先，扰动小）或 FULL_RESCHEDULE（完全重排，局部不可行时再用）。需传触发事件 eventId 与被调整的 oldPlanVersionId（通常为当前发布计划）。返回任务后用 fjsp_task_status 轮询。',
    parameters: Obj(
      {
        mode: S({ description: 'LOCAL_RESCHEDULE 或 FULL_RESCHEDULE' }),
        eventId: S({ description: '触发事件 ID' }),
        oldPlanVersionId: S({ description: '被调整的计划版本 ID' }),
        weights: WEIGHTS,
      },
      ['mode', 'eventId', 'oldPlanVersionId'],
    ),
    meta: WRITE,
    async execute({ mode, eventId, oldPlanVersionId, weights }) {
      if (mode !== 'LOCAL_RESCHEDULE' && mode !== 'FULL_RESCHEDULE') {
        return result({
          ok: false,
          error: { code: 'FJSP_INVALID_MODE', message: 'mode 必须是 LOCAL_RESCHEDULE 或 FULL_RESCHEDULE' },
        })
      }
      const body = { mode, eventId, oldPlanVersionId }
      if (weights) body.objectiveWeights = weights
      const r = await api('POST', '/schedule-tasks', body)
      if (!r.ok) return result(r)
      return result({ ok: true, task: trimTask(r.data || {}) })
    },
  },
  {
    name: 'fjsp_task_status',
    description:
      '查询调度任务状态/进度/结果。默认会原地轮询等待任务结束（最长 waitSeconds 秒，每 2 秒查一次），直接返回终态，无需也不能用 sleep/shell 等待。status 为 SUCCESS 时含 resultStatus（FEASIBLE/INFEASIBLE）、KPI、planVersionId 与冲突明细 conflicts；FAILED 时含 errorMessage；超时仍未结束则返回 RUNNING 快照，可再次调用本工具继续等。',
    parameters: Obj(
      {
        taskId: S(),
        waitSeconds: I({ description: '最长等待秒数，默认 60，0 表示只查一次' }),
      },
      ['taskId'],
    ),
    meta: READ,
    async execute({ taskId, waitSeconds }) {
      const waitMs = Math.min(Math.max(waitSeconds ?? 60, 0), 300) * 1000
      const deadline = Date.now() + waitMs
      for (;;) {
        const r = await api('GET', `/schedule-tasks/${encodeURIComponent(taskId)}`)
        if (!r.ok) return result(r)
        const t = r.data || {}
        const done = t.status === 'SUCCESS' || t.status === 'FAILED'
        if (done || Date.now() >= deadline) {
          return result({
            ok: true,
            task: {
              ...trimTask(t),
              resultStatus: t.resultStatus,
              feasibleSolution: t.feasibleSolution,
              candidateGroupId: t.candidateGroupId,
              algorithmVersion: t.algorithmVersion,
              randomSeed: t.randomSeed,
              elapsedMs: t.elapsedMs,
              oldPlanVersionId: t.oldPlanVersionId,
              eventId: t.eventId,
              kpi: trimKpi(t.kpi),
              conflicts: t.conflicts || [],
              errorMessage: t.errorMessage,
            },
          })
        }
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    },
  },
  {
    name: 'fjsp_get_plan',
    description:
      '获取计划版本详情（状态、乐观锁 version、KPI、工序汇总）。不传 planVersionId 时取当前发布计划。需要 version 的写操作（review/publish）前应先调用本工具拿最新 version。',
    parameters: Obj({ planVersionId: S() }),
    meta: READ,
    async execute({ planVersionId }) {
      let id = planVersionId
      if (!id) {
        const d = await api('GET', '/dashboard')
        if (!d.ok) return result(d)
        id = d.data && d.data.currentPlan && d.data.currentPlan.id
        if (!id) return result({ ok: false, error: { code: 'FJSP_NO_PUBLISHED_PLAN', message: '当前没有已发布计划' } })
      }
      const r = await api('GET', `/plan-versions/${encodeURIComponent(id)}`)
      if (!r.ok) return result(r)
      const v = r.data || {}
      // 工序明细已移到独立分页端点（P1-6 索引与分页改造），大 size 一次取回
      const opsResp = await api('GET', `/plan-versions/${encodeURIComponent(id)}/operations?size=5000`)
      const ops = (opsResp.ok && opsResp.data && opsResp.data.items) || []
      const byMachine = {}
      for (const op of ops) byMachine[op.machineId] = (byMachine[op.machineId] || 0) + 1
      return result({
        ok: true,
        plan: {
          ...trimVersion(v),
          reviewComment: v.reviewComment,
          operationsSummary: {
            total: ops.length,
            frozen: ops.filter((o) => o.frozen).length,
            affected: ops.filter((o) => o.affected).length,
            byMachine,
            firstStartAt: ops.length ? ops.map((o) => o.startAt).sort()[0] : null,
            lastEndAt: ops.length ? ops.map((o) => o.endAt).sort().slice(-1)[0] : null,
          },
        },
      })
    },
  },
  {
    name: 'fjsp_compare_plans',
    description:
      '对比候选方案与基线方案：工序变更统计（换机/换序/时间平移数量）、KPI 差值（加权拖期、makespan 等）与发生变化的工序明细（最多 15 条）。用于评估扰动率与拖期改善。',
    parameters: Obj(
      {
        planVersionId: S({ description: '候选（新）方案版本 ID' }),
        baselineVersionId: S({ description: '基线（原）方案版本 ID' }),
      },
      ['planVersionId', 'baselineVersionId'],
    ),
    meta: READ,
    async execute({ planVersionId, baselineVersionId }) {
      const r = await api(
        'GET',
        `/plan-versions/${encodeURIComponent(planVersionId)}/diff?baselineVersionId=${encodeURIComponent(baselineVersionId)}`,
      )
      if (!r.ok) return result(r)
      const d = r.data || {}
      const changed = (d.operations || []).filter(
        (o) => o.machineChanged || o.sequenceChanged || (o.timeShiftMinutes ?? 0) !== 0,
      )
      return result({
        ok: true,
        diff: {
          baselineVersionCode: d.baselineVersionCode,
          candidateVersionCode: d.candidateVersionCode,
          summary: d.summary,
          kpiDiff: d.kpiDiff,
          changedOperations: changed.slice(0, 15).map((o) => ({
            operationId: o.operationId,
            timeShiftMinutes: o.timeShiftMinutes,
            machineChanged: o.machineChanged,
            sequenceChanged: o.sequenceChanged,
            oldMachineId: o.oldMachineId,
            newMachineId: o.newMachineId,
            oldStartAt: o.oldStartAt,
            newStartAt: o.newStartAt,
          })),
          changedOperationsTotal: changed.length,
        },
      })
    },
  },
  {
    name: 'fjsp_submit_review',
    description: '将候选计划版本提交评审（submit-review，DRAFT → REVIEW_PENDING）。必须传乐观锁 version（先用 fjsp_get_plan 获取最新值）。已处于 REVIEW_PENDING/REVIEWED/PUBLISHED 时直接返回当前状态。返回最新状态与乐观锁 version。',
    parameters: Obj(
      {
        planVersionId: S(),
        version: I({ description: '乐观锁版本号，提交前用 fjsp_get_plan 获取' }),
      },
      ['planVersionId', 'version'],
    ),
    meta: WRITE,
    async execute({ planVersionId, version }) {
      const before = await getVersion(planVersionId)
      if (!before) return result({ ok: false, error: { code: 'FJSP_NOT_FOUND', message: '计划版本不存在' } })
      if (before.status === 'DRAFT') {
        const r = await api('POST', `/plan-versions/${encodeURIComponent(planVersionId)}/submit-review`, { version })
        if (!r.ok) return result(r)
      }
      const after = await getVersion(planVersionId)
      return result({ ok: true, plan: trimVersion(after || before) })
    },
  },
  {
    name: 'fjsp_approve_review',
    description:
      '评审候选计划版本（REVIEW_PENDING → REVIEWED/REJECTED）。decision 默认 APPROVE；REJECT 必须填 comment 说明驳回原因。属于高风险人工决策点：Agent 只能发起，必须由人工在审批弹窗中确认后才真正执行。调用前先用 fjsp_get_plan 获取最新乐观锁 version。',
    parameters: Obj(
      {
        planVersionId: S(),
        decision: S({ description: 'APPROVE 或 REJECT，默认 APPROVE' }),
        comment: S({ description: '评审意见；REJECT 时必填' }),
      },
      ['planVersionId'],
    ),
    meta: HIGH_RISK,
    async execute({ planVersionId, decision, comment }) {
      const dec = (decision || 'APPROVE').toUpperCase()
      if (dec !== 'APPROVE' && dec !== 'REJECT') {
        return result({ ok: false, error: { code: 'FJSP_INVALID_DECISION', message: 'decision 必须是 APPROVE 或 REJECT' } })
      }
      if (dec === 'REJECT' && !comment) {
        return result({ ok: false, error: { code: 'FJSP_COMMENT_REQUIRED', message: '驳回必须填写评审意见 comment' } })
      }
      const cur = await getVersion(planVersionId)
      if (!cur) return result({ ok: false, error: { code: 'FJSP_NOT_FOUND', message: '计划版本不存在' } })
      if (cur.status !== 'REVIEW_PENDING') {
        return result({
          ok: false,
          error: { code: 'FJSP_INVALID_STATE', message: `只有 REVIEW_PENDING 状态可评审，当前状态 ${cur.status}，请先调 fjsp_submit_review` },
        })
      }
      const r = await api('POST', `/plan-versions/${encodeURIComponent(planVersionId)}/review`, {
        decision: dec,
        comment: comment || (dec === 'APPROVE' ? '人工评审通过' : ''),
        version: cur.version,
      })
      if (!r.ok) return result({ ...r, step: 'review' })
      const after = await getVersion(planVersionId)
      return result({ ok: true, plan: trimVersion(after || cur) })
    },
  },
  {
    name: 'fjsp_revise_plan',
    description:
      '将被驳回的计划版本退回草稿（revise，REJECTED → DRAFT），以便修改后重新 fjsp_submit_review。必须传乐观锁 version（先用 fjsp_get_plan 获取最新值）。仅 REJECTED 状态可调用。',
    parameters: Obj(
      {
        planVersionId: S(),
        version: I({ description: '乐观锁版本号，调用前用 fjsp_get_plan 获取' }),
      },
      ['planVersionId', 'version'],
    ),
    meta: WRITE,
    async execute({ planVersionId, version }) {
      const cur = await getVersion(planVersionId)
      if (!cur) return result({ ok: false, error: { code: 'FJSP_NOT_FOUND', message: '计划版本不存在' } })
      if (cur.status !== 'REJECTED') {
        return result({
          ok: false,
          error: { code: 'FJSP_INVALID_STATE', message: `只有 REJECTED 状态可退回修改，当前状态 ${cur.status}` },
        })
      }
      const r = await api('POST', `/plan-versions/${encodeURIComponent(planVersionId)}/revise`, { version })
      if (!r.ok) return result({ ...r, step: 'revise' })
      const after = await getVersion(planVersionId)
      return result({ ok: true, plan: trimVersion(after || cur) })
    },
  },
  {
    name: 'fjsp_publish',
    description:
      '发布已评审通过的计划版本（REVIEWED → PUBLISHED），发布后成为车间执行计划，原发布版本转为 SUPERSEDED。本工具只执行发布这一步：不自动提交评审、不自动审批。属于高风险操作：必须由人工在审批弹窗中确认后才真正执行。调用前先用 fjsp_get_plan 获取最新乐观锁 version。',
    parameters: Obj({ planVersionId: S() }, ['planVersionId']),
    meta: HIGH_RISK,
    async execute({ planVersionId }) {
      const cur = await getVersion(planVersionId)
      if (!cur) return result({ ok: false, error: { code: 'FJSP_NOT_FOUND', message: '计划版本不存在' } })
      if (cur.status === 'PUBLISHED') return result({ ok: true, alreadyPublished: true, plan: trimVersion(cur) })
      if (cur.status !== 'REVIEWED') {
        return result({
          ok: false,
          error: {
            code: 'FJSP_INVALID_STATE',
            message: `只有 REVIEWED 状态可发布，当前状态 ${cur.status}。正确流程：fjsp_submit_review → 人工查看方案对比与 KPI → fjsp_approve_review → fjsp_publish`,
          },
        })
      }
      const r = await api('POST', `/plan-versions/${encodeURIComponent(planVersionId)}/publish`, { version: cur.version })
      if (!r.ok) return result({ ...r, step: 'publish' })
      const after = await getVersion(planVersionId)
      const done = after && after.status === 'PUBLISHED'
      return result({
        ok: !!done,
        ...(done ? {} : { error: { code: 'FJSP_PUBLISH_INCOMPLETE', message: `发布未完成，当前状态 ${after && after.status}` } }),
        plan: trimVersion(after || cur),
      })
    },
  },
  {
    name: 'fjsp_reset_demo',
    description: '演示重置：清空全部排程数据并重建演示数据集。仅在演示/联调时使用，会删除现有计划与事件。',
    parameters: Obj({}),
    meta: DESTRUCTIVE,
    async execute() {
      const r = await api('POST', '/demo/reset', {})
      if (!r.ok) return result(r)
      return result({ ok: true, data: r.data ?? '演示数据已重置' })
    },
  },
]

export const fjspTools = {
  inject: ['extension'],
  apply(ctx) {
    const agnes = ctx.extension()
    for (const tool of tools) agnes.registerTool(tool)
    agnes.on('session_start', () => {
      agnes.ctx.log.info(`fjsp-tools ready, FJSP API base: ${BASE}`)
    })
  },
}
