// test-contract: fjsp-tools 工具契约测试（任务 2.1/2.2/2.3）——入参运行时校验、
// 出参/错误 envelope、错误分类。全程 mock fetch，不依赖真实 business-service，无副作用。
// 运行：node agh-integration/fjsp-tools/test-contract.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须在 import 工具模块前设置：模块加载时读取 env（BASE/凭据/经验库路径）
process.env.FJSP_AUTH_TOKEN = process.env.FJSP_AUTH_TOKEN || 'contract-test-token'
process.env.FJSP_API_BASE = 'http://contract-test.invalid/api/v1'
const tmpDir = mkdtempSync(join(tmpdir(), 'fjsp-contract-'))
process.env.FJSP_EXPERIENCE_FILE = join(tmpDir, 'experience.jsonl')

// ---- mock fetch：记录调用并按 handler 路由；handler 默认抛错（视为不该发请求） ----
let fetchCalls = []
let fetchHandler = () => {
  throw new Error('unexpected fetch')
}
globalThis.fetch = async (url, opts) => {
  fetchCalls.push({ url: String(url), method: (opts && opts.method) || 'GET' })
  return fetchHandler(String(url), opts)
}
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const resetFetch = (handler) => {
  fetchCalls = []
  fetchHandler = handler
}

let failures = 0
const assert = (cond, msg) => {
  if (cond) console.log('PASS ' + msg)
  else {
    failures++
    console.log('FAIL ' + msg)
  }
}

const CATEGORIES = ['retryable', 'needs-input', 'needs-human', 'terminal']

// 失败 envelope 形态断言：{ ok:false, error:{ code, message, category, retryable, recovery, ... } }
function assertErrEnvelope(out, code, label) {
  const s = out && out.structured
  assert(out.isError === true, `${label} isError=true`)
  assert(s && s.ok === false && s.error && typeof s.error === 'object', `${label} 形态 {ok:false, error:{...}}`)
  if (!s || !s.error) return
  assert(s.error.code === code, `${label} error.code=${code}（实际 ${s.error.code}）`)
  assert(typeof s.error.message === 'string' && s.error.message.length > 0, `${label} error.message 非空`)
  assert(CATEGORIES.includes(s.error.category), `${label} error.category 属于四类（实际 ${s.error.category}）`)
  assert(typeof s.error.retryable === 'boolean', `${label} error.retryable 为布尔`)
  assert(typeof s.error.recovery === 'string' && s.error.recovery.length > 0, `${label} error.recovery 非空`)
  // content[0].text 与 structured 一致（AGH/MCP 两个入口消费的是同一份 JSON）
  assert(JSON.stringify(JSON.parse(out.content[0].text)) === JSON.stringify(s), `${label} content.text 与 structured 一致`)
}

const { tools, __contract } = await import('./index.mjs')
const toolMap = new Map(tools.map((t) => [t.name, t]))
const { validateParams, classifyError, ERROR_CLASSES } = __contract

assert(tools.length === 18, `工具数量=18（实际 ${tools.length}）`)

// ---- 1. 每个工具：非法参数挡在执行前（fetch 0 次调用），envelope 形态正确 ----
resetFetch()
for (const tool of tools) {
  const hasRequired = (tool.parameters.required || []).length > 0
  const badArgs = hasRequired ? {} : { __bogus: 1 } // 缺必填 / 未定义字段
  const before = fetchCalls.length
  const out = await tool.execute(badArgs)
  assert(fetchCalls.length === before, `${tool.name} 非法参数未发 HTTP 请求`)
  assertErrEnvelope(out, 'FJSP_INVALID_PARAMS', `${tool.name} 非法参数`)
}

// ---- 1b. 错类型（含嵌套对象） ----
resetFetch()
{
  const out = await toolMap.get('fjsp_report_breakdown').execute({ machineId: 123, occurredAt: '2026-09-17T06:00:00Z', repairDurationMinutes: 60 })
  assertErrEnvelope(out, 'FJSP_INVALID_PARAMS', 'fjsp_report_breakdown machineId 错类型')
  assert(fetchCalls.length === 0, '错类型未发 HTTP 请求')
}
{
  const out = await toolMap.get('fjsp_task_status').execute({ taskId: 'TSK-1', waitSeconds: '60' })
  assertErrEnvelope(out, 'FJSP_INVALID_PARAMS', 'fjsp_task_status waitSeconds 错类型')
}
{
  const out = await toolMap.get('fjsp_create_baseline').execute({ weights: { makespan: 'big' } })
  assertErrEnvelope(out, 'FJSP_INVALID_PARAMS', 'fjsp_create_baseline 嵌套 weights.makespan 错类型')
}
{
  const out = await toolMap.get('fjsp_create_baseline').execute({ seed: 1.5 })
  assertErrEnvelope(out, 'FJSP_INVALID_PARAMS', 'fjsp_create_baseline seed 非整数')
}

// ---- 1c. 越界数值/数组上限（schema 已声明 maxItems:200） ----
{
  const out = await toolMap.get('fjsp_create_baseline').execute({ orderIds: Array.from({ length: 201 }, (_, i) => `O${i}`) })
  assertErrEnvelope(out, 'FJSP_INVALID_PARAMS', 'fjsp_create_baseline orderIds 超 maxItems')
  assert(fetchCalls.length === 0, '越界参数未发 HTTP 请求')
}

// ---- 1d. 错枚举（schema 未声明枚举的字段走工具内既有检查，同样挡在 HTTP 前） ----
{
  const out = await toolMap.get('fjsp_reschedule').execute({ mode: 'X', eventId: 'EVT-1', oldPlanVersionId: 'PV-1' })
  assertErrEnvelope(out, 'FJSP_INVALID_MODE', 'fjsp_reschedule 错枚举 mode')
  assert(fetchCalls.length === 0, '错枚举未发 HTTP 请求')
}

// ---- 2. 错误分类映射：覆盖全部已出现错误码；未知码走 fail-safe 默认 ----
{
  const knownCodes = [
    // 工具侧
    'FJSP_INVALID_PARAMS', 'FJSP_INVALID_MODE', 'FJSP_INVALID_DECISION', 'FJSP_COMMENT_REQUIRED',
    'FJSP_INVALID_ORDER_REF', 'FJSP_INVALID_EVENT_TYPE', 'FJSP_NOT_FOUND', 'FJSP_NO_PUBLISHED_PLAN',
    'FJSP_INVALID_STATE', 'FJSP_PUBLISH_INCOMPLETE', 'FJSP_EXPERIENCE_WRITE_FAILED',
    // 通道/基础设施
    'FJSP_UNREACHABLE', 'FJSP_BAD_RESPONSE', 'FJSP_UNAUTHORIZED', 'APPROVAL_CHANNEL_REQUIRED',
    // business-service 透传（BizException/GlobalExceptionHandler/SecurityConfig 全量）
    'E_EVENT_IN_PROCESS', 'E_VALIDATION', 'E_DUPLICATE', 'E_NOT_FOUND', 'E_VERSION_STALE',
    'E_STATE_CONFLICT', 'E_PLAN_STALE', 'E_INFEASIBLE', 'E_INTEGRITY_VIOLATION', 'E_ROLLBACK_CONFLICT',
    'E_UNAUTHORIZED', 'E_LOGIN_LOCKED', 'E_FORBIDDEN', 'E_INTERNAL',
  ]
  const missing = knownCodes.filter((c) => !ERROR_CLASSES[c])
  assert(missing.length === 0, `分类映射覆盖全部 ${knownCodes.length} 个已知错误码${missing.length ? '（缺 ' + missing.join(',') + '）' : ''}`)
  for (const [code, cls] of Object.entries(ERROR_CLASSES)) {
    assert(CATEGORIES.includes(cls.category) && typeof cls.retryable === 'boolean' && typeof cls.recovery === 'string' && cls.recovery.length > 0, `ERROR_CLASSES[${code}] 字段完整`)
  }
  const dft = classifyError('E_BRAND_NEW_CODE')
  assert(dft.category === 'needs-human' && dft.retryable === false, '未知错误码默认 needs-human + 不可重试（fail-safe）')
}

// ---- 2b. 方案点名的两个语义 ----
{
  const cls = classifyError('E_EVENT_IN_PROCESS')
  assert(cls.category === 'needs-input' && cls.retryable === true, 'E_EVENT_IN_PROCESS: needs-input + 可重试（换时间）')
  assert(cls.recovery.includes('严禁自动移动真实事件时间'), 'E_EVENT_IN_PROCESS recovery 明确禁止自动移动真实事件时间')
}
{
  const cls = classifyError('FJSP_INVALID_STATE')
  assert(cls.retryable === false, 'FJSP_INVALID_STATE: retryable=false（不能盲目重试）')
  assert(cls.recovery.includes('reads-before-retry'), 'FJSP_INVALID_STATE recovery 要求先读业务现态')
}

// ---- 3. envelope 成功/失败形态一致（mock 业务服务） ----
resetFetch(() => jsonRes(200, { code: 'OK', data: [{ machineId: 'M-01', workCenterId: 'WC-1', status: 'ACTIVE', productFamilies: ['轴类A'] }] }))
{
  const out = await toolMap.get('fjsp_list_machines').execute({})
  const s = out.structured
  assert(s && s.ok === true && Array.isArray(s.machines) && s.machines.length === 1, 'fjsp_list_machines 成功 {ok:true, machines:[...]}')
  assert(!('error' in s) && !out.isError, '成功 envelope 无 error 字段、无 isError')
  assert(fetchCalls.length === 1 && fetchCalls[0].url.endsWith('/machines'), '合法参数通过校验并发出 GET /machines')
}
// 合法参数的写路径：通过校验 → POST → 成功 envelope
resetFetch(() => jsonRes(200, { code: 'OK', data: { eventId: 'EVT-1', eventCode: 'BD-1', eventType: 'BREAKDOWN', machineId: 'M-03', occurredAt: '2026-09-17T06:00:00Z', status: 'RECORDED' } }))
{
  const out = await toolMap.get('fjsp_report_breakdown').execute({ machineId: 'M-03', occurredAt: '2026-09-17T06:00:00Z', repairDurationMinutes: 60 })
  const s = out.structured
  assert(s && s.ok === true && s.event && s.event.eventId === 'EVT-1', 'fjsp_report_breakdown 成功 {ok:true, event:{...}}')
  assert(fetchCalls.length === 1 && fetchCalls[0].method === 'POST' && fetchCalls[0].url.includes('/events/breakdowns'), '合法写参数发出 POST /events/breakdowns')
}
// 业务错误码透传 + 分类补齐 + requestId/httpStatus 保留
resetFetch(() => jsonRes(409, { code: 'E_EVENT_IN_PROCESS', message: '与在制工序冲突', requestId: 'req-1' }))
{
  const out = await toolMap.get('fjsp_report_breakdown').execute({ machineId: 'M-03', occurredAt: '2026-09-17T06:00:00Z', repairDurationMinutes: 60 })
  assertErrEnvelope(out, 'E_EVENT_IN_PROCESS', '业务错误码透传')
  const e = out.structured.error
  assert(e.category === 'needs-input' && e.retryable === true, 'E_EVENT_IN_PROCESS 分类 needs-input + retryable')
  assert(e.httpStatus === 409 && e.requestId === 'req-1', 'httpStatus/requestId 保留在 envelope 中')
}
// 未知业务错误码走默认分类
resetFetch(() => jsonRes(500, { code: 'E_BRAND_NEW_CODE', message: '未知错误' }))
{
  const out = await toolMap.get('fjsp_list_machines').execute({})
  assertErrEnvelope(out, 'E_BRAND_NEW_CODE', '未知业务错误码')
  const e = out.structured.error
  assert(e.category === 'needs-human' && e.retryable === false, '未知业务错误码默认 needs-human + 不可重试')
}
// 服务不可达
resetFetch(() => {
  throw new Error('connection refused')
})
{
  const out = await toolMap.get('fjsp_get_dashboard').execute({})
  assertErrEnvelope(out, 'FJSP_UNREACHABLE', '服务不可达')
  assert(out.structured.error.category === 'retryable' && out.structured.error.retryable === true, 'FJSP_UNREACHABLE 分类 retryable')
}
// 本地成功路径（经验库写入，不走 HTTP）
resetFetch()
{
  const out = await toolMap.get('fjsp_experience_record').execute({ eventType: 'BREAKDOWN', mode: 'LOCAL_RESCHEDULE', note: '契约测试' })
  const s = out.structured
  assert(s && s.ok === true && s.recorded && s.recorded.eventType === 'BREAKDOWN', 'fjsp_experience_record 本地成功 {ok:true, recorded:{...}}')
  assert(fetchCalls.length === 0, '经验库写入不发 HTTP 请求')
}

// ---- 4. 校验器单测（直接调 validateParams） ----
{
  const schema = toolMap.get('fjsp_insert_order').parameters
  assert(validateParams(schema, { orderCode: 'O1', productFamily: '轴类A', quantity: 10, arrivalAt: 'a', dueAt: 'b', priority: 5, occurredAt: 'c' }).length === 0, 'validateParams 合法参数零 issue')
  assert(validateParams(schema, { orderCode: 'O1' }).some((i) => i.path === 'quantity'), 'validateParams 缺必填被检出')
  assert(validateParams(schema, { extra: 1 }).some((i) => i.message === '未定义的字段'), 'validateParams 未定义字段被检出')
  assert(validateParams(toolMap.get('fjsp_get_dashboard').parameters, {}).length === 0, 'validateParams 空 schema 接受 {}')
  assert(validateParams(toolMap.get('fjsp_get_dashboard').parameters, null).length === 0, 'validateParams 接受缺省参数（MCP arguments 可省略）')
}

rmSync(tmpDir, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部契约测试通过')
