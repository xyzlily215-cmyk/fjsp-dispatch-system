// workflow/agent-nodes.mts — Agent 决策/生成节点契约（任务 3.2-partB）。
//
// 契约依据 docs/Agent化架构优化方案.md 3.2/3.5「Agent 节点契约」：
//   策略节点输入 = 事件 + 经验检索结果 + 当前约束，输出 = {mode, weights, rationale}，
//   校验枚举、数值范围及权重规则后才执行；生成节点只引用工具返回的 KPI/对比数据，不承担写操作。
// 枚举与数值约束以业务/算法服务代码为准（见各常量注释），与本文件描述不符时以代码为准。
// Agent 是注入接口；本模块不接真实 LLM，未注入 Agent 时全部走确定性兜底。

// mode 枚举：business-service ScheduleTaskCommandService.MODES = BASELINE / LOCAL_RESCHEDULE / FULL_RESCHEDULE；
// 扰动处置只允许两种重调度模式（BASELINE 是全量基线排程，不属于处置流程）。
export const RESCHEDULE_MODES = ['LOCAL_RESCHEDULE', 'FULL_RESCHEDULE'] as const
export type RescheduleMode = (typeof RESCHEDULE_MODES)[number]

// weights 规则：可执行契约以 fjsp-tools 的 WEIGHTS 参数 schema 为准（fjsp_reschedule 客户端
// 校验，超出直接 FJSP_INVALID_PARAMS、不发请求）——当前只放行 makespan / weightedTardiness /
// loadImbalance 三键。algorithm-service ga.py 的重调度模式另认 deltaPlan / machineChange
// （SeedService 重调度默认权重亦含之），但 fjsp-tools schema 尚不透传，属已登记的工具面缺口；
// 在该缺口修复前，Agent 建议含这两键一律按非法落 fallback，避免到写节点才被拒。
// 数值约束：algorithm-service app/models.py SolveRequest.objectiveWeights —— 键数上限 16、
// 值必须是非负有限数（负权重会让 GA 朝更差方向优化，服务端直接拒绝）。
export const WEIGHT_KEYS = ['makespan', 'weightedTardiness', 'loadImbalance'] as const
export const MAX_WEIGHT_KEYS = 16

// 策略节点输出契约
export interface StrategySuggestion {
  mode: RescheduleMode
  weights: Record<string, number>
  rationale: string
}

// 默认策略（fallback）：LOCAL 优先、扰动小；权重对齐 SeedService 重调度默认（deltaPlan/
// machineChange 由算法侧默认 0.2/0.1 补齐，经 fjsp-tools 可执行的键只有这两个）。
export const DEFAULT_STRATEGY: StrategySuggestion = {
  mode: 'LOCAL_RESCHEDULE',
  weights: { weightedTardiness: 0.4, makespan: 0.3 },
  rationale: '默认策略：局部重调度优先（扰动小），权重取系统默认值（deltaPlan/machineChange 由算法侧默认补齐）',
}

// INFEASIBLE / 任务 FAILED 的处置策略常量：仅允许把 LOCAL_RESCHEDULE 升级为
// FULL_RESCHEDULE 重试一次；再失败一律 suspend(needs-human)，不做第二次自动重排。
export const ALLOW_FULL_RESCHEDULE_ONCE = true

// 决策节点输入（只读）：事件 + 经验检索结果 + 当前约束
export interface StrategyInput {
  event: { eventType: string; [k: string]: unknown }
  experience: unknown // fjsp_experience_query 的 records / recommendation
  constraints?: Record<string, unknown> // 当前约束（冻结窗、在制工序等，预留）
}

// 冲突解释输入（只读）：任务终态 + conflicts 明细
export interface ConflictExplainInput {
  outcome: 'infeasible' | 'failed'
  mode: RescheduleMode
  conflicts?: unknown[]
  errorMessage?: string | null
  event: { eventType: string; [k: string]: unknown }
}

// 生成节点输入：只含只读 KPI/对比数据。接口形状上没有任何 tools/写操作入口——
// 「生成节点不允许携带写操作」由类型契约保证，而不是靠提示词约束。
export interface ReviewMaterialInput {
  event: { eventType: string; [k: string]: unknown }
  strategy: StrategySuggestion
  task: { taskId?: string; resultStatus?: string | null; kpi?: Record<string, unknown> | null }
  baselineKpi?: Record<string, unknown> | null // 被调整计划（当前发布计划）的 KPI
  diff?: unknown // fjsp_compare_plans 的 diff（kpiDiff / 换机换序平移统计）
  conflictExplanation?: string | null // INFEASIBLE 分支留下的冲突解释
}

// Agent 注入接口：三个方法分别对应策略建议、冲突解释、评审材料生成。
export interface DisturbanceAgent {
  suggestStrategy(input: StrategyInput): unknown | Promise<unknown>
  explainConflicts(input: ConflictExplainInput): string | Promise<string>
  buildReviewMaterial(input: ReviewMaterialInput): string | Promise<string>
}

export type StrategyValidation =
  | { ok: true; strategy: StrategySuggestion }
  | { ok: false; strategy: StrategySuggestion; rejectedReasons: string[] } // strategy 为 fallback

// 校验 Agent 策略建议：mode 枚举、weights 键集合/数值范围、rationale 非空。
// 任一不合法 → 返回 fallback（DEFAULT_STRATEGY + 全部拒绝原因），流程按设计继续走默认策略。
export function validateStrategySuggestion(raw: unknown): StrategyValidation {
  const reasons: string[] = []
  const obj = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null
  if (!obj) reasons.push('输出不是对象（期望 {mode, weights, rationale}）')

  let mode: RescheduleMode | null = null
  if (obj) {
    if (typeof obj.mode === 'string' && (RESCHEDULE_MODES as readonly string[]).includes(obj.mode)) {
      mode = obj.mode as RescheduleMode
    } else {
      reasons.push(`mode 非法：${JSON.stringify(obj.mode)}（允许 ${RESCHEDULE_MODES.join(' / ')}）`)
    }
  }

  let weights: Record<string, number> | null = null
  if (obj) {
    if (obj.weights && typeof obj.weights === 'object' && !Array.isArray(obj.weights)) {
      const entries = Object.entries(obj.weights as Record<string, unknown>)
      const w: Record<string, number> = {}
      let bad = false
      if (entries.length > MAX_WEIGHT_KEYS) {
        reasons.push(`weights 键数 ${entries.length} 超过上限 ${MAX_WEIGHT_KEYS}`)
        bad = true
      }
      for (const [k, v] of entries) {
        if (!(WEIGHT_KEYS as readonly string[]).includes(k)) {
          reasons.push(`weights 含未知键 ${k}（允许 ${WEIGHT_KEYS.join(' / ')}）`)
          bad = true
          continue
        }
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
          reasons.push(`weights.${k} 必须是非负有限数，实际 ${JSON.stringify(v)}`)
          bad = true
          continue
        }
        w[k] = v
      }
      if (!bad) weights = w
    } else {
      reasons.push('weights 缺失或不是对象')
    }
  }

  let rationale: string | null = null
  if (obj) {
    if (typeof obj.rationale === 'string' && obj.rationale.trim().length > 0) {
      rationale = obj.rationale.trim()
    } else {
      reasons.push('rationale 必须是非空字符串')
    }
  }

  if (reasons.length === 0 && mode && weights && rationale) return { ok: true, strategy: { mode, weights, rationale } }
  return { ok: false, strategy: { ...DEFAULT_STRATEGY, weights: { ...DEFAULT_STRATEGY.weights } }, rejectedReasons: reasons }
}

// 冲突解释的确定性兜底（未注入 Agent 时使用）：只读 conflicts/errorMessage，不产生任何写操作。
export function defaultExplainConflicts(input: ConflictExplainInput): string {
  const head = input.outcome === 'failed'
    ? `重调度任务执行失败（mode=${input.mode}）${input.errorMessage ? `：${input.errorMessage}` : ''}`
    : `重调度结果不可行 INFEASIBLE（mode=${input.mode}）`
  const items = (input.conflicts ?? []).slice(0, 10).map((c) => {
    if (c && typeof c === 'object') {
      const r = c as Record<string, unknown>
      return `- ${[r.type ?? r.code, r.machineId ?? r.orderId ?? '', r.message ?? r.detail ?? ''].filter(Boolean).join('：')}`
    }
    return `- ${String(c)}`
  })
  return [head, ...(items.length ? ['冲突明细：', ...items] : ['（服务未返回冲突明细）'])].join('\n')
}

// 评审材料的确定性兜底生成（未注入 Agent 或 Agent 输出非法时使用）。
// 纯函数：输入只读 KPI/对比数据，输出文本，无任何写操作。
export function buildReviewMaterial(input: ReviewMaterialInput): string {
  const kpiLine = (label: string, kpi?: Record<string, unknown> | null) =>
    kpi
      ? `- ${label}：makespan=${kpi.cMaxMinutes ?? '-'}，加权拖期=${kpi.weightedTardinessMinutes ?? '-'}，拖期订单数=${kpi.nTardy ?? '-'}，负载不均衡=${kpi.loadImbalance ?? '-'}`
      : `- ${label}：（无数据）`
  const diff = (input.diff && typeof input.diff === 'object' ? input.diff : null) as {
    summary?: unknown
    kpiDiff?: Record<string, unknown>
    changedOperationsTotal?: number
  } | null
  const lines = [
    '# 扰动处置评审材料',
    '',
    `## 事件摘要`,
    `- 类型：${input.event.eventType}`,
    ...Object.entries(input.event)
      .filter(([k]) => k !== 'eventType')
      .map(([k, v]) => `- ${k}：${typeof v === 'object' ? JSON.stringify(v) : String(v)}`),
    '',
    '## 采用策略',
    `- mode：${input.strategy.mode}`,
    `- weights：${JSON.stringify(input.strategy.weights)}`,
    `- rationale：${input.strategy.rationale}`,
    `- 任务：${input.task.taskId ?? '-'}，结果：${input.task.resultStatus ?? '-'}`,
    '',
    '## KPI 对比',
    kpiLine('基线计划', input.baselineKpi),
    kpiLine('候选方案', input.task.kpi),
    ...(diff?.kpiDiff ? [`- 差值：${JSON.stringify(diff.kpiDiff)}`] : []),
    '',
    '## 扰动统计',
    diff ? `- 变更工序数：${diff.changedOperationsTotal ?? '-'}；summary：${JSON.stringify(diff.summary ?? null)}` : '- （无对比数据）',
    '',
    '## 风险提示',
    input.conflictExplanation
      ? `- 本次处置经历过不可行/失败分支，冲突解释：\n${input.conflictExplanation}`
      : '- 无（一次通过，未触发异常分支）',
    '- 评审通过并发布前，请人工复核方案对比与 KPI 差值；发布需独立人工确认。',
  ]
  return lines.join('\n')
}
