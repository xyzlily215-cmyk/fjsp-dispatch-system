// fjsp-tools: AGH backend plugin exposing the FJSP scheduling business service
// (Spring Boot, default http://localhost:8081/api/v1) as agent tools.
// Self-contained ESM, no external dependencies; tool schemas are hand-tagged
// TypeBox schemas like examples/packages/hot-tool-plugin.
import { appendFileSync, readFileSync } from 'node:fs'
import { readDisturbanceContext } from './disturbance-context.mjs'
import { BASELINE_WEIGHT_DEFAULTS, RESCHEDULE_WEIGHT_DEFAULTS } from './objective-weights.mjs'

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

// 幂等键（任务 2.B 步骤级复用）：HTTP 写工具的可选入参。同一工作流步骤的重试必须
// 复用同一字符串，业务服务按 Idempotency-Key 请求头做同键同体回放、换键同体 409
// （E_DUPLICATE）。不传则每次调用自动生成新键（兼容 AGH 现有会话；注意换键重发
// 不触发服务端幂等）。服务端仅要求非空（IdempotencyService.requireKey），
// 这里约束 1-120 字符。不从业务参数推导默认键，避免误去重不同语义的调用。
const IDEMPOTENCY_KEY = S({
  description: '幂等键：同一工作流步骤的重试必须复用同一字符串；不传则本次调用自动生成新键（重试将被视为新调用）',
  minLength: 1,
  maxLength: 120,
})

// ---- 入参运行时校验（任务 2.1）：schema 即本文件手写的 TypeBox 形态子集，
// 校验器与之适配（类型/必填/枚举/数值范围/字符串格式/数组上限/禁止未定义字段），
// 不引新依赖。校验在 execute 执行前完成，失败时不发任何 HTTP 请求。
function validateValue(schema, value, path, issues) {
  if (!schema || !schema.type) return
  if (value === undefined) return // 缺省由 object 的 required 检查兜底
  const t = schema.type
  if (value === null) {
    issues.push({ path, message: `应为 ${t}，收到 null` })
    return
  }
  switch (t) {
    case 'string': {
      if (typeof value !== 'string') {
        issues.push({ path, message: `应为字符串，收到 ${typeof value}` })
        return
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) issues.push({ path, message: `长度不得小于 ${schema.minLength}` })
      if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push({ path, message: `长度不得大于 ${schema.maxLength}` })
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) issues.push({ path, message: `不匹配格式 ${schema.pattern}` })
      break
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push({ path, message: `应为数值，收到 ${typeof value}` })
        return
      }
      if (t === 'integer' && !Number.isInteger(value)) issues.push({ path, message: '应为整数' })
      if (schema.minimum !== undefined && value < schema.minimum) issues.push({ path, message: `不得小于 ${schema.minimum}` })
      if (schema.maximum !== undefined && value > schema.maximum) issues.push({ path, message: `不得大于 ${schema.maximum}` })
      break
    }
    case 'boolean':
      if (typeof value !== 'boolean') issues.push({ path, message: `应为布尔值，收到 ${typeof value}` })
      break
    case 'array': {
      if (!Array.isArray(value)) {
        issues.push({ path, message: `应为数组，收到 ${typeof value}` })
        return
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push({ path, message: `元素数不得多于 ${schema.maxItems}` })
      if (schema.minItems !== undefined && value.length < schema.minItems) issues.push({ path, message: `元素数不得少于 ${schema.minItems}` })
      if (schema.items) value.forEach((item, i) => validateValue(schema.items, item, `${path}[${i}]`, issues))
      break
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        issues.push({ path, message: `应为对象，收到 ${Array.isArray(value) ? 'array' : typeof value}` })
        return
      }
      const props = schema.properties || {}
      for (const req of schema.required || []) {
        if (value[req] === undefined) issues.push({ path: path ? `${path}.${req}` : req, message: '缺少必填字段' })
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in props)) issues.push({ path: path ? `${path}.${key}` : key, message: '未定义的字段' })
        }
      }
      for (const [key, propSchema] of Object.entries(props)) {
        if (value[key] !== undefined) validateValue(propSchema, value[key], path ? `${path}.${key}` : key, issues)
      }
      break
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    issues.push({ path, message: `取值须为 ${schema.enum.join(' / ')}` })
  }
}

function validateParams(schema, args) {
  if (args === undefined || args === null) args = {} // 省略参数规整为 {}，必填字段照常拦截
  if (typeof args !== 'object' || Array.isArray(args)) return [{ path: '(root)', message: '参数必须是对象' }]
  const issues = []
  validateValue(schema, args, '', issues)
  return issues
}

const OBJECTIVE_LABELS = { makespan: '最大完工时间', weightedTardiness: '加权拖期', loadImbalance: '负载不均衡', deltaPlan: '计划扰动', machineChange: '换机数量' }
const weightSchema = (defaults) => Obj(Object.fromEntries(Object.entries(defaults).map(([key, value]) => [
  key, N({ description: `${OBJECTIVE_LABELS[key]}权重，默认 ${value}；缺失补默认，不归一化`, minimum: 0 }),
])))
const BASELINE_WEIGHTS = weightSchema(BASELINE_WEIGHT_DEFAULTS)
const RESCHEDULE_WEIGHTS = weightSchema(RESCHEDULE_WEIGHT_DEFAULTS)
const FREEZE_WINDOW = I({ description: '冻结窗口（分钟，0-1440）；预览与实际求解必须一致', minimum: 0, maximum: 1440 })

const KPI_DIFF = Obj({
  weightedTardinessMinutes: N({ description: '加权拖期差值（新-旧，越小越好，可为负）' }),
  cMaxMinutes: N({ description: '最大完工时间差值' }),
  deltaPlan: N({ description: '扰动率 Delta_plan 差值' }),
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
const WEB_BASE = (process.env.FJSP_WEB_BASE || 'http://localhost:5173').replace(/\/+$/, '')

const ganttUrl = (planVersionId) => `${WEB_BASE}/#/resource-gantt?planVersion=${encodeURIComponent(planVersionId)}`

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

// ---- RSI 经验库（对应官方案例的递归自我改进闭环）：每次扰动处置把
// 事件类型 / 重调度模式 / 权重 / KPI 结果沉淀到本地 JSONL；处置前查询同类事件的
// 历史表现，让策略随经验改进。文件仅追加，一行一条 JSON。
// 注意：插件从安装快照运行（import.meta.url 指向快照目录，重装即换路径），
// 经验库必须落在稳定位置：FJSP_EXPERIENCE_FILE 覆盖，默认 ~/.agh/fjsp-experience.jsonl。
import { homedir } from 'node:os'
import { join } from 'node:path'

const EXPERIENCE_FILE = process.env.FJSP_EXPERIENCE_FILE || join(homedir(), '.agh', 'fjsp-experience.jsonl')

function readExperience() {
  let text
  try {
    text = readFileSync(EXPERIENCE_FILE, 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

// ---- 认证：业务服务要求 JWT（P0 改造后所有接口需登录） ----
// 优先级：FJSP_AUTH_TOKEN 直连 > FJSP_AUTH_USER/FJSP_AUTH_PASSWORD 登录。
// 未配置时用演示账号（admin/Fj@123456，与 scripts/demo-common.sh 一致）。
let cachedToken = process.env.FJSP_AUTH_TOKEN || null
let loginInFlight = null

async function login() {
  const username = process.env.FJSP_AUTH_USER || 'admin'
  const password = process.env.FJSP_AUTH_PASSWORD || 'Fj@123456'
  try {
    const res = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const env = await res.json()
    if (!res.ok || !env || env.code !== 'OK' || !env.data || !env.data.token) {
      return null
    }
    cachedToken = env.data.token
    return cachedToken
  } catch {
    return null
  }
}

async function ensureToken() {
  if (cachedToken) return cachedToken
  if (!loginInFlight) {
    loginInFlight = login().finally(() => { loginInFlight = null })
  }
  return loginInFlight
}

async function api(method, path, body, idempotencyKey) {
  return apiWithRetry(method, path, body, true, idempotencyKey)
}

async function apiWithRetry(method, path, body, allowReauth, idempotencyKey) {
  const headers = {
    Accept: 'application/json',
    'X-Source': 'agh',
  }
  const token = await ensureToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  const sessionId = aghSessionId()
  if (sessionId) headers['X-AGH-Session-Id'] = sessionId
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    // 调用方传入的幂等键原样使用（步骤级重试复用同键）；未传时自动生成（兼容现状）
    headers['Idempotency-Key'] = idempotencyKey || crypto.randomUUID()
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
  // token 过期/失效：重新登录后重试一次
  if (res.status === 401 && allowReauth && !process.env.FJSP_AUTH_TOKEN) {
    cachedToken = null
    const renewed = await ensureToken()
    if (renewed) return apiWithRetry(method, path, body, false, idempotencyKey)
  }
  let env
  try {
    env = await res.json()
  } catch {
    return {
      ok: false,
      error: { code: 'FJSP_BAD_RESPONSE', message: `业务服务返回了无法解析的响应（HTTP ${res.status}）`, httpStatus: res.status },
    }
  }
  if (res.status === 401) {
    return {
      ok: false,
      error: { code: 'FJSP_UNAUTHORIZED', message: '业务服务认证失败；启用验证码后请先网页登录并设置 FJSP_AUTH_TOKEN，令牌过期后需重新登录更新', httpStatus: 401 },
    }
  }
  if (!res.ok || (env && typeof env.code === 'string' && env.code !== 'OK')) {
    return {
      ok: false,
      error: {
        code: (env && env.code) || `FJSP_HTTP_${res.status}`,
        message: (env && env.message) || `业务服务返回 HTTP ${res.status}`,
        httpStatus: res.status,
        requestId: env && env.requestId,
      },
    }
  }
  return { ok: true, data: env ? env.data : undefined }
}

// ---- 错误分类（任务 2.3）：错误码 → 四类（retryable / needs-input / needs-human / terminal）
// + 可否重试 + 恢复动作。两个点名语义：E_EVENT_IN_PROCESS 只能核实/更换事件时间后重试，
// 严禁自动移动真实事件时间；FJSP_INVALID_STATE 不可盲目重试，须先读业务现态
// （reads-before-retry）。未知错误码走 ERROR_CLASS_DEFAULT 兜底（fail-safe：不自动重试）。
const ERROR_CLASSES = {
  // —— 工具侧入参/流程错误 ——
  FJSP_INVALID_PARAMS: { category: 'needs-input', retryable: true, recovery: '按 details.issues 修正参数后重试（校验失败时未发出任何业务请求）' },
  FJSP_INVALID_MODE: { category: 'needs-input', retryable: true, recovery: 'mode 取 LOCAL_RESCHEDULE 或 FULL_RESCHEDULE 后重试' },
  FJSP_INVALID_DECISION: { category: 'needs-input', retryable: true, recovery: 'decision 取 APPROVE 或 REJECT 后重试' },
  FJSP_COMMENT_REQUIRED: { category: 'needs-input', retryable: true, recovery: 'REJECT 必须填 comment，补充后重试' },
  FJSP_INVALID_ORDER_REF: { category: 'needs-input', retryable: true, recovery: '核实订单号或内部 id 后重试' },
  FJSP_INVALID_EVENT_TYPE: { category: 'needs-input', retryable: true, recovery: 'eventType 取 BREAKDOWN 或 NEW_ORDER 后重试' },
  FJSP_NOT_FOUND: { category: 'needs-input', retryable: false, recovery: '对象不存在：先核实 planVersionId 等 ID，不要重试相同参数' },
  FJSP_NO_PUBLISHED_PLAN: { category: 'needs-input', retryable: false, recovery: '当前无已发布计划：先完成基线排程与发布流程再调用' },
  FJSP_INVALID_STATE: { category: 'needs-input', retryable: false, recovery: '状态机不允许该步骤：先用 fjsp_get_plan 读业务现态（reads-before-retry），补齐漏掉的步骤后再试，不能盲目重试' },
  FJSP_PUBLISH_INCOMPLETE: { category: 'needs-human', retryable: false, recovery: '发布结果不确定：人工核查计划版本真实状态后再决定下一步' },
  FJSP_EXPERIENCE_WRITE_FAILED: { category: 'needs-human', retryable: false, recovery: '本地经验库写入失败：检查 FJSP_EXPERIENCE_FILE 路径与权限' },
  // —— 通道/基础设施错误 ——
  FJSP_UNREACHABLE: { category: 'retryable', retryable: true, recovery: '确认业务服务已启动、FJSP_API_BASE 正确后重试' },
  FJSP_BAD_RESPONSE: { category: 'retryable', retryable: true, recovery: '服务返回非 JSON（多为网关瞬断）：可稍后重试一次，反复出现转人工' },
  FJSP_UNAUTHORIZED: { category: 'needs-human', retryable: false, recovery: '凭据失效：人工更新 FJSP_AUTH_TOKEN 或 FJSP_AUTH_USER/FJSP_AUTH_PASSWORD 后重试' },
  APPROVAL_CHANNEL_REQUIRED: { category: 'needs-human', retryable: false, recovery: 'MCP 直连不支持人工审批：改走 Web 副驾或 AGH 会话审批，不要带 _confirm 重试' },
  // —— business-service 业务错误码（原样透传后的分类） ——
  E_EVENT_IN_PROCESS: { category: 'needs-input', retryable: true, recovery: '事件发生时间与在制工序冲突：核实真实事件时间，改用不冲突的时间重试；严禁自动移动真实事件时间' },
  E_VALIDATION: { category: 'needs-input', retryable: false, recovery: '业务校验失败：按 message 修正参数，不要原样重试' },
  E_DUPLICATE: { category: 'needs-input', retryable: false, recovery: '重复/幂等冲突：先核实是否已提交成功，不要重试相同参数' },
  E_NOT_FOUND: { category: 'needs-input', retryable: false, recovery: '业务对象不存在：核实 ID 后重试' },
  E_VERSION_STALE: { category: 'retryable', retryable: true, recovery: '乐观锁冲突：先用 fjsp_get_plan 重新读取最新 version 后重试（reads-before-retry）' },
  E_STATE_CONFLICT: { category: 'needs-input', retryable: false, recovery: '业务状态冲突：先读业务现态再决定下一步，不能盲目重试' },
  E_PLAN_STALE: { category: 'retryable', retryable: true, recovery: '计划已被并发修改：刷新现态后重试' },
  E_INFEASIBLE: { category: 'needs-input', retryable: false, recovery: '方案不可行：读 conflicts 明细，调整参数或改 FULL_RESCHEDULE 后重试' },
  E_INTEGRITY_VIOLATION: { category: 'terminal', retryable: false, recovery: '硬约束完整性违反：结果不可信，停止流程并转人工核查' },
  E_ROLLBACK_CONFLICT: { category: 'needs-human', retryable: false, recovery: '回滚与在制/冻结窗内工序冲突：转人工处置' },
  E_UNAUTHORIZED: { category: 'needs-human', retryable: false, recovery: '未认证或凭据失效：人工更新凭据' },
  E_LOGIN_LOCKED: { category: 'needs-human', retryable: false, recovery: '账号临时锁定：等解锁或由人工处理' },
  E_FORBIDDEN: { category: 'needs-human', retryable: false, recovery: '当前角色无权执行：转人工或换有权限的角色' },
  E_INTERNAL: { category: 'retryable', retryable: true, recovery: '服务内部错误：可稍后重试一次，反复出现转人工' },
}
const ERROR_CLASS_DEFAULT = { category: 'needs-human', retryable: false, recovery: '未识别的错误码：停止自动重试，把 code 与 message 原样转人工核查' }
// FJSP_HTTP_5xx（无业务 code 的服务端 5xx 兜底码）按「结果未知」处理（任务 2.B）：
// 请求可能已到达服务端，写工具必须先查业务终态再决定重试（recovery 由 execute 包装层
// 按工具逐条补终态查询方式）；只读工具可稍后重试一次。
const ERROR_CLASS_HTTP_5XX = { category: 'retryable', retryable: true, recovery: '服务端 5xx 错误，本次请求结果未知：读操作可稍后重试一次；写操作必须先按工具指引查询业务终态，确认未生效后用同一 idempotencyKey 重试' }
// 结果未知类错误（超时/连接中断/响应不可解析/服务端 5xx 与内部错误）：写工具的
// recovery 由 execute 包装层改写为该工具的具体终态查询指引。
const UNKNOWN_RESULT_CODES = new Set(['FJSP_UNREACHABLE', 'FJSP_BAD_RESPONSE', 'E_INTERNAL'])
function isUnknownResultCode(code) {
  return UNKNOWN_RESULT_CODES.has(code) || /^FJSP_HTTP_5\d\d$/.test(code)
}
function classifyError(code) {
  if (typeof code === 'string' && /^FJSP_HTTP_5\d\d$/.test(code)) return ERROR_CLASS_HTTP_5XX
  return ERROR_CLASSES[code] || ERROR_CLASS_DEFAULT
}

function result(value) {
  // 出参 envelope（任务 2.2）：成功 { ok:true, ...业务字段 }；失败统一
  // { ok:false, error:{ code, message, category, retryable, recovery, httpStatus?, requestId?, details? } }。
  // 错误分类在此统一补齐（单个错误已显式给出的字段优先），业务错误码在 code 字段原样透传；
  // details 为 requestId/idempotencyKey（任务 2.B 步骤级幂等键复用）等扩展位。
  if (value && value.ok === false && value.error && typeof value.error.code === 'string') {
    const cls = classifyError(value.error.code)
    value = { ...value, error: { category: cls.category, retryable: cls.retryable, recovery: cls.recovery, ...value.error } }
  }
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
    name: 'fjsp_list_process_templates',
    description: '列出全部工艺模板（模板编码、产品族、版本、状态、工序数）。基线排程前的主数据就绪检查用。',
    parameters: Obj({}),
    meta: READ,
    async execute() {
      const r = await api('GET', '/process-templates')
      if (!r.ok) return result(r)
      return result({
        ok: true,
        templates: (r.data || []).map((t) => ({
          templateId: t.templateId,
          templateCode: t.templateCode,
          productFamily: t.productFamily,
          templateVersion: t.templateVersion,
          status: t.status,
          operationCount: Array.isArray(t.operations) ? t.operations.length : 0,
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
      weights: BASELINE_WEIGHTS,
      seed: I({ description: '随机种子 randomSeed' }),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    meta: WRITE,
    terminalQuery: '用 fjsp_get_dashboard 的 recentTasks 找到本次 BASELINE 任务拿 taskId，再 fjsp_task_status(taskId) 查终态',
    async execute({ orderIds, weights, seed, idempotencyKey }) {
      const body = { mode: 'BASELINE' }
      if (Array.isArray(orderIds) && orderIds.length > 0) body.orderIds = orderIds
      if (weights) body.objectiveWeights = weights
      if (typeof seed === 'number') body.algorithm = { randomSeed: seed }
      const r = await api('POST', '/schedule-tasks', body, idempotencyKey)
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
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      ['machineId', 'occurredAt', 'repairDurationMinutes'],
    ),
    meta: WRITE,
    terminalQuery: '用 fjsp_get_dashboard 的 recentEvents 核实该故障事件是否已登记（同机台同时间的 BREAKDOWN）',
    async execute({ machineId, occurredAt, repairDurationMinutes, note, idempotencyKey }) {
      const r = await api('POST', '/events/breakdowns', {
        machineId,
        occurredAt,
        repairDurationMinutes,
        source: 'AGH_AGENT',
        ...(note ? { note } : {}),
      }, idempotencyKey)
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
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      ['orderCode', 'productFamily', 'quantity', 'arrivalAt', 'dueAt', 'priority', 'occurredAt'],
    ),
    meta: WRITE,
    terminalQuery: '用 fjsp_get_dashboard 的 recentEvents 核实该插单事件是否已登记（按 orderCode 核对）',
    async execute({ orderCode, productFamily, quantity, arrivalAt, dueAt, priority, occurredAt, subType, note, idempotencyKey }) {
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
      }, idempotencyKey)
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
    name: 'fjsp_get_disturbance_context',
    description: '读取已登记扰动的决策上下文：固定原计划 KPI、影响预览/锁定计数、受影响订单及相对事件时间的交期压力。只读，不创建任务；modeEstimates 只是估算，不能替代求解验证。',
    parameters: Obj({
      eventId: S({ minLength: 1, description: '已登记事件 ID 或编号' }),
      planVersionId: S({ minLength: 1, description: '固定的原计划 ID 或编号，不隐式切换到最新版本' }),
      freezeWindowMinutes: FREEZE_WINDOW,
    }, ['eventId', 'planVersionId']),
    meta: READ,
    async execute(args) {
      return result(await readDisturbanceContext(api, args))
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
        weights: RESCHEDULE_WEIGHTS,
        freezeWindowMinutes: FREEZE_WINDOW,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      ['mode', 'eventId', 'oldPlanVersionId'],
    ),
    meta: WRITE,
    terminalQuery: '若已拿到 taskId 用 fjsp_task_status(taskId) 查终态；否则用 fjsp_get_dashboard 的 recentTasks 找到本次重调度任务拿 taskId 再查',
    async execute({ mode, eventId, oldPlanVersionId, weights, freezeWindowMinutes, idempotencyKey }) {
      if (mode !== 'LOCAL_RESCHEDULE' && mode !== 'FULL_RESCHEDULE') {
        return result({
          ok: false,
          error: { code: 'FJSP_INVALID_MODE', message: 'mode 必须是 LOCAL_RESCHEDULE 或 FULL_RESCHEDULE' },
        })
      }
      const body = { mode, eventId, oldPlanVersionId }
      if (weights) body.objectiveWeights = weights
      if (freezeWindowMinutes !== undefined) body.freezeWindowMinutes = freezeWindowMinutes
      const r = await api('POST', '/schedule-tasks', body, idempotencyKey)
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
              ...(t.status === 'SUCCESS' && t.planVersionId ? { ganttUrl: ganttUrl(t.planVersionId) } : {}),
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
    name: 'fjsp_get_gantt_link',
    description:
      '获取计划版本的甘特图链接（前端资源甘特图页 URL）。调度方案排好（fjsp_task_status 拿到 planVersionId）或发布后调用本工具，把返回的 ganttUrl 发给用户在浏览器中查看甘特图。不传 planVersionId 时取当前发布计划。',
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
      return result({ ok: true, planVersionId: v.id, versionCode: v.versionCode, ganttUrl: ganttUrl(v.id) })
    },
  },
  {
    name: 'fjsp_get_workpiece_position',
    description:
      '查询某订单（工件）的实时加工位置与进度：当前正在哪台设备加工（当前工序）、已完成/剩余工序数、进度百分比、下一道工序的计划设备与时间。orderRef 支持订单号（如 O001）或内部 id。用户问"某个件现在到哪了/还剩几道工序"时调用本工具。',
    parameters: Obj(
      { orderRef: S({ description: '订单号 orderCode（如 O001）或订单内部 id' }) },
      ['orderRef'],
    ),
    meta: READ,
    async execute({ orderRef }) {
      if (!orderRef) {
        return result({ ok: false, error: { code: 'FJSP_INVALID_ORDER_REF', message: 'orderRef 不能为空' } })
      }
      const r = await api('GET', `/orders/${encodeURIComponent(orderRef)}/position`)
      if (!r.ok) return result(r)
      return result({ ok: true, position: r.data })
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
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      ['planVersionId', 'version'],
    ),
    meta: WRITE,
    terminalQuery: '用 fjsp_get_plan(planVersionId) 读最新 status 与 version 确认是否已提交评审（status=REVIEW_PENDING 即已生效）',
    async execute({ planVersionId, version, idempotencyKey }) {
      const before = await getVersion(planVersionId)
      if (!before) return result({ ok: false, error: { code: 'FJSP_NOT_FOUND', message: '计划版本不存在' } })
      if (before.status === 'DRAFT') {
        const r = await api('POST', `/plan-versions/${encodeURIComponent(planVersionId)}/submit-review`, { version }, idempotencyKey)
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
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      ['planVersionId'],
    ),
    meta: HIGH_RISK,
    terminalQuery: '用 fjsp_get_plan(planVersionId) 读最新 status 确认评审是否已生效（REVIEWED/REJECTED 即已生效）',
    async execute({ planVersionId, decision, comment, idempotencyKey }) {
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
      }, idempotencyKey)
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
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      ['planVersionId', 'version'],
    ),
    meta: WRITE,
    terminalQuery: '用 fjsp_get_plan(planVersionId) 读最新 status 确认是否已退回 DRAFT',
    async execute({ planVersionId, version, idempotencyKey }) {
      const cur = await getVersion(planVersionId)
      if (!cur) return result({ ok: false, error: { code: 'FJSP_NOT_FOUND', message: '计划版本不存在' } })
      if (cur.status !== 'REJECTED') {
        return result({
          ok: false,
          error: { code: 'FJSP_INVALID_STATE', message: `只有 REJECTED 状态可退回修改，当前状态 ${cur.status}` },
        })
      }
      const r = await api('POST', `/plan-versions/${encodeURIComponent(planVersionId)}/revise`, { version }, idempotencyKey)
      if (!r.ok) return result({ ...r, step: 'revise' })
      const after = await getVersion(planVersionId)
      return result({ ok: true, plan: trimVersion(after || cur) })
    },
  },
  {
    name: 'fjsp_publish',
    description:
      '发布已评审通过的计划版本（REVIEWED → PUBLISHED），发布后成为车间执行计划，原发布版本转为 SUPERSEDED。本工具只执行发布这一步：不自动提交评审、不自动审批。属于高风险操作：必须由人工在审批弹窗中确认后才真正执行。调用前先用 fjsp_get_plan 获取最新乐观锁 version。',
    parameters: Obj({ planVersionId: S(), idempotencyKey: IDEMPOTENCY_KEY }, ['planVersionId']),
    meta: HIGH_RISK,
    terminalQuery: '用 fjsp_get_plan(planVersionId) 读最新 status 确认是否已发布（PUBLISHED 即已生效）',
    async execute({ planVersionId, idempotencyKey }) {
      const cur = await getVersion(planVersionId)
      if (!cur) return result({ ok: false, error: { code: 'FJSP_NOT_FOUND', message: '计划版本不存在' } })
      if (cur.status === 'PUBLISHED') return result({ ok: true, alreadyPublished: true, plan: trimVersion(cur), ganttUrl: ganttUrl(planVersionId) })
      if (cur.status !== 'REVIEWED') {
        return result({
          ok: false,
          error: {
            code: 'FJSP_INVALID_STATE',
            message: `只有 REVIEWED 状态可发布，当前状态 ${cur.status}。正确流程：fjsp_submit_review → 人工查看方案对比与 KPI → fjsp_approve_review → fjsp_publish`,
          },
        })
      }
      const r = await api('POST', `/plan-versions/${encodeURIComponent(planVersionId)}/publish`, { version: cur.version }, idempotencyKey)
      if (!r.ok) return result({ ...r, step: 'publish' })
      const after = await getVersion(planVersionId)
      const done = after && after.status === 'PUBLISHED'
      return result({
        ok: !!done,
        ...(done ? {} : { error: { code: 'FJSP_PUBLISH_INCOMPLETE', message: `发布未完成，当前状态 ${after && after.status}` } }),
        ...(done ? { ganttUrl: ganttUrl(planVersionId) } : {}),
        plan: trimVersion(after || cur),
      })
    },
  },
  {
    name: 'fjsp_experience_query',
    description:
      '查询扰动处置经验库：历史同类事件采用的重调度模式/权重及结果（KPI 差值、扰动率、是否发布）。决定重调度策略前调用；传 query（当前情景的自然语言描述，如「M-05 主轴过热停机」）时走 agent-bff 的 RAG 语义检索（e5 向量 + BM25 混合召回，返回带 score 的最相似历史记录），BFF 不在线时回退本地统计；recommendation 按模式统计历史平均加权拖期差值并给出表现最好的模式，经验为空时为 null（此时按默认策略：LOCAL 优先）。',
    parameters: Obj({
      eventType: S({ description: 'BREAKDOWN（设备故障）或 NEW_ORDER（插单）；不传返回全部类型' }),
      query: S({ description: '当前情景的自然语言描述，用于语义检索最相似的历史处置（如「M-05 主轴过热停机，维修 2 小时」）；不传则按时间倒序' }),
      limit: I({ description: '最多返回条数，默认 10' }),
      loadLevel: S({ description: '当前负荷水平 LOW / NORMAL / HIGH，传入后同类负荷的历史记录加权（语义检索路径生效）', enum: ['LOW', 'NORMAL', 'HIGH'] }),
      dueUrgency: S({ description: '当前交期紧迫度 LOW / MEDIUM / HIGH，传入后同紧迫度的历史记录加权（语义检索路径生效）', enum: ['LOW', 'MEDIUM', 'HIGH'] }),
    }),
    meta: READ,
    async execute({ eventType, limit, query, loadLevel, dueUrgency }) {
      // RAG 语义检索优先：agent-bff 的 /rag/experience-query（本地 e5 向量 + BM25 混合召回）。
      // BFF 已加鉴权（P0）：携带业务服务 JWT（与 api() 同一来源）；未配置凭据时 BFF 返回 401，
      // 与 BFF 不在线一样回退到下方本地统计逻辑，保证工具永远可用。
      try {
        const ragToken = await ensureToken()
        const res = await fetch(process.env.FJSP_RAG_URL || 'http://127.0.0.1:4178/agent-api/rag/experience-query', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(ragToken ? { Authorization: `Bearer ${ragToken}` } : {}),
          },
          body: JSON.stringify({ eventType, query, limit: limit ?? 10, loadLevel, dueUrgency }),
          signal: AbortSignal.timeout(4000),
        })
        if (res.ok) {
          const data = await res.json()
          if (data && data.ok) return result(data)
        }
      } catch { /* BFF 不可达：回退本地逻辑 */ }
      // BFF 不可达：回退本地逻辑。feedback 行（任务 5.1 结果反馈）不是经验记录，本地回落一并跳过。
      const all = readExperience().filter((r) => r.kind !== 'feedback')
      const matched = (eventType ? all.filter((r) => r.eventType === eventType) : all)
        .slice(-Math.min(Math.max(limit ?? 10, 1), 100))
        .reverse()
      // 推荐：按模式统计平均加权拖期差值（越小越好），平均扰动率作平局依据
      const stats = {}
      for (const r of matched) {
        if (!r.mode || typeof r.kpiDiff?.weightedTardinessMinutes !== 'number') continue
        const s = (stats[r.mode] ??= { mode: r.mode, count: 0, tardinessSum: 0, deltaPlanSum: 0, deltaPlanCount: 0 })
        s.count += 1
        s.tardinessSum += r.kpiDiff.weightedTardinessMinutes
        if (typeof r.kpiDiff?.deltaPlan === 'number') {
          s.deltaPlanSum += r.kpiDiff.deltaPlan
          s.deltaPlanCount += 1
        }
      }
      const ranked = Object.values(stats)
        .map((s) => ({
          mode: s.mode,
          count: s.count,
          avgWeightedTardinessDiff: Math.round((s.tardinessSum / s.count) * 100) / 100,
          ...(s.deltaPlanCount ? { avgDeltaPlan: Math.round((s.deltaPlanSum / s.deltaPlanCount) * 1000) / 1000 } : {}),
        }))
        .sort((a, b) => a.avgWeightedTardinessDiff - b.avgWeightedTardinessDiff || (a.avgDeltaPlan ?? 0) - (b.avgDeltaPlan ?? 0))
      return result({
        ok: true,
        total: all.length,
        matched: matched.length,
        records: matched,
        recommendation: ranked.length
          ? {
              mode: ranked[0].mode,
              reason: `历史 ${ranked[0].count} 次同类处置平均加权拖期差值 ${ranked[0].avgWeightedTardinessDiff}，为各模式最优`,
              byMode: ranked,
            }
          : null,
      })
    },
  },
  {
    name: 'fjsp_experience_record',
    description:
      '把本次扰动处置的结果写入经验库（事件类型、设备、重调度模式与权重、KPI 差值、是否发布、备注），供后续同类事件处置参考。在方案对比（fjsp_compare_plans）完成后、流程结束时调用一次；零扰动无需发布的场景也要记录（published=false）。',
    parameters: Obj(
      {
        eventType: S({ description: 'BREAKDOWN 或 NEW_ORDER' }),
        machineId: S({ description: '故障设备号（BREAKDOWN 时填）' }),
        mode: S({ description: 'LOCAL_RESCHEDULE 或 FULL_RESCHEDULE' }),
        weights: RESCHEDULE_WEIGHTS,
        resultStatus: S({ description: 'FEASIBLE / INFEASIBLE' }),
        kpiDiff: KPI_DIFF,
        published: S({ description: '"true" 已发布 / "false" 未发布（含零扰动无需发布）' }),
        note: S({ description: '一句话处置结论，如「故障落在空闲窗口，零扰动未发布」' }),
        // 情景字段（任务 5.1）：供检索时比较同类场景，均可选，旧调用不变
        loadLevel: S({ description: '负荷水平 LOW / NORMAL / HIGH（可据当前计划 KPI 负载/设备状态映射）', enum: ['LOW', 'NORMAL', 'HIGH'] }),
        dueUrgency: S({ description: '交期紧迫度 LOW / MEDIUM / HIGH（可据订单 dueAt 相对当前时间与优先级映射）', enum: ['LOW', 'MEDIUM', 'HIGH'] }),
        repairDurationMinutes: I({ description: '故障预计维修时长（分钟，BREAKDOWN 的扰动规模，取 fjsp_report_breakdown 的入参）', minimum: 1 }),
        orderQuantity: I({ description: '插单数量（NEW_ORDER 的扰动规模，取 fjsp_insert_order 的 quantity）', minimum: 1 }),
      },
      ['eventType', 'mode'],
    ),
    meta: WRITE,
    async execute({ eventType, machineId, mode, weights, resultStatus, kpiDiff, published, note, loadLevel, dueUrgency, repairDurationMinutes, orderQuantity }) {
      if (eventType !== 'BREAKDOWN' && eventType !== 'NEW_ORDER') {
        return result({ ok: false, error: { code: 'FJSP_INVALID_EVENT_TYPE', message: 'eventType 必须是 BREAKDOWN 或 NEW_ORDER' } })
      }
      if (mode !== 'LOCAL_RESCHEDULE' && mode !== 'FULL_RESCHEDULE') {
        return result({ ok: false, error: { code: 'FJSP_INVALID_MODE', message: 'mode 必须是 LOCAL_RESCHEDULE 或 FULL_RESCHEDULE' } })
      }
      const record = {
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        eventType,
        mode,
        ...(machineId ? { machineId } : {}),
        ...(weights ? { weights } : {}),
        ...(resultStatus ? { resultStatus } : {}),
        ...(kpiDiff ? { kpiDiff } : {}),
        ...(published !== undefined ? { published: published === 'true' } : {}),
        ...(note ? { note } : {}),
        ...(loadLevel ? { loadLevel } : {}),
        ...(dueUrgency ? { dueUrgency } : {}),
        ...(repairDurationMinutes !== undefined ? { repairDurationMinutes } : {}),
        ...(orderQuantity !== undefined ? { orderQuantity } : {}),
        sessionId: aghSessionId(),
      }
      try {
        appendFileSync(EXPERIENCE_FILE, JSON.stringify(record) + '\n')
      } catch (e) {
        return result({ ok: false, error: { code: 'FJSP_EXPERIENCE_WRITE_FAILED', message: String(e) } })
      }
      return result({ ok: true, recorded: record, total: readExperience().length })
    },
  },
  {
    name: 'fjsp_experience_feedback',
    description:
      '对已沉淀的处置经验追加结果反馈（业务结果 / 人工评审驳回 / 返工）：不修改原始记录，追加一条 kind=feedback 的记录关联 experienceId；检索时按 outcome 对原经验降权（rejected/reworked/failed）或正常保留（success/partial）。评审被驳回、返工或事后确认处置效果不佳时调用。',
    parameters: Obj(
      {
        experienceId: S({ description: '目标经验记录 id（fjsp_experience_record 返回的 recorded.id）' }),
        outcome: S({ description: 'success 成功 / partial 部分达成 / failed 失败 / rejected 评审驳回 / reworked 返工', enum: ['success', 'partial', 'failed', 'rejected', 'reworked'] }),
        feedbackBy: S({ description: '反馈来源操作者（人工驳回/返工时记录操作者账号）' }),
        note: S({ description: '补充说明，如驳回原因摘要' }),
      },
      ['experienceId', 'outcome'],
    ),
    meta: WRITE,
    async execute({ experienceId, outcome, feedbackBy, note }) {
      const target = readExperience().find((r) => r.kind !== 'feedback' && r.id === experienceId)
      if (!target) {
        return result({ ok: false, error: { code: 'FJSP_NOT_FOUND', message: `经验记录 ${experienceId} 不存在（仅 fjsp_experience_record 新写入的记录带 id，旧记录无 id 不能反馈）` } })
      }
      const feedback = {
        kind: 'feedback',
        experienceId,
        outcome,
        feedbackAt: new Date().toISOString(),
        ...(feedbackBy ? { feedbackBy } : {}),
        ...(note ? { note } : {}),
        sessionId: aghSessionId(),
      }
      try {
        appendFileSync(EXPERIENCE_FILE, JSON.stringify(feedback) + '\n')
      } catch (e) {
        return result({ ok: false, error: { code: 'FJSP_EXPERIENCE_WRITE_FAILED', message: String(e) } })
      }
      return result({ ok: true, feedback, total: readExperience().length })
    },
  },
  {
    name: 'fjsp_reset_demo',
    description: '演示重置：清空全部排程数据并重建演示数据集。仅在演示/联调时使用，会删除现有计划与事件。',
    parameters: Obj({ idempotencyKey: IDEMPOTENCY_KEY }),
    meta: DESTRUCTIVE,
    terminalQuery: '用 fjsp_get_dashboard 确认演示数据是否已重置（当前计划/订单/事件/任务是否已清空重建）',
    async execute({ idempotencyKey }) {
      const r = await api('POST', '/demo/reset', {}, idempotencyKey)
      if (!r.ok) return result(r)
      return result({ ok: true, data: r.data ?? '演示数据已重置' })
    },
  },
]

// ---- 入参运行时校验挂接（任务 2.1）：包在每个工具的 execute 外层。
// AGH 插件与 MCP Server 共用本 tools 数组，两个入口同时生效；校验失败返回
// FJSP_INVALID_PARAMS 结构化错误，不发任何 HTTP 请求。
// 未知结果恢复指引（任务 2.B）：带 terminalQuery 的写工具返回超时/连接中断/5xx 等
// 结果未知类错误时，把 recovery 改写为该工具的具体终态查询方式 + 同键重试约定，
// 保持 content[0].text 与 structured 为同一份 JSON。
for (const tool of tools) {
  const inner = tool.execute
  tool.execute = async (args) => {
    const safeArgs = args ?? {}
    const issues = validateParams(tool.parameters, safeArgs)
    if (issues.length > 0) {
      return result({
        ok: false,
        error: {
          code: 'FJSP_INVALID_PARAMS',
          message: `参数校验失败：${issues.map((i) => `${i.path || '(root)'} ${i.message}`).join('；')}`,
          details: { issues },
        },
      })
    }
    const out = await inner(safeArgs)
    if (tool.terminalQuery && out.structured && out.structured.ok === false && out.structured.error && isUnknownResultCode(out.structured.error.code)) {
      const clean = {
        ...out.structured,
        error: {
          ...out.structured.error,
          recovery: `结果未知（请求可能已到达服务端）：先 ${tool.terminalQuery} 确认本次调用是否已生效；未生效再用同一 idempotencyKey 重试（重试必须复用同键；原调用未传键时先自行固定一个键再重发，不要每次换键），反复出现转人工`,
        },
      }
      return { ...out, content: [{ type: 'text', text: JSON.stringify(clean) }], structured: clean }
    }
    return out
  }
}

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

// MCP Server（agent-bff/mcp-server.mts）复用同一套工具实现：AGH 插件与 MCP 双形态暴露。
export { tools }

// 契约测试（fjsp-tools/test-contract.mjs）专用内部出口，不影响两个入口的消费方式。
export const __contract = { validateParams, classifyError, ERROR_CLASSES, ERROR_CLASS_DEFAULT }
