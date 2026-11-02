// test-audit-trail: agent-bff 审计聚合视图测试（任务 4.2）。
// 与 test-approval-status.mts 同一隔离思路：mock business-service（/auth/me 内检 +
// /audit-logs 业务审计查询）+ 静默 WS hub；BFF 经 tsx 在本进程内 import（env 先隔离
// 到临时目录与独立端口 14185）；工作流检查点写入临时 FJSP_WORKFLOW_DIR。
// 覆盖：聚合链完整性（一条 workflow 的审批+业务副作用都关联到）；旧记录经检查点
// requestId 关联（无 workflowId 的存量记录）；跨用户/低角色 403、未认证 401；
// 参数校验 400、未知工作流 404；关联键缺失/业务审计不可达的降级标注（unknown 不编造）；
// format=jsonl 导出格式稳定。
//
// 运行：../agnes-harness/node_modules/.bin/tsx test-audit-trail.mts（在 agh-integration/agent-bff/ 目录下）
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MOCK_PORT = 18105
const HUB_PORT = 18106
const BFF_PORT = 14185
const BFF = `http://127.0.0.1:${BFF_PORT}/agent-api`

const USERS: Record<string, { username: string; role: string; displayName: string }> = {
  'tok-admin': { username: 'admin', role: 'ADMIN', displayName: '管理员' },
  'tok-dispatcher': { username: 'alice', role: 'DISPATCHER', displayName: '调度员A' },
}

// mock 业务审计：PV-100 有一条 PLAN_PUBLISH（业务请求 ID biz-req-1）；PV-FAIL 返回 500
const BIZ_AUDIT_PV100 = [
  { id: 'audit-1', action: 'PLAN_SUBMIT_REVIEW', objectType: 'plan_version', objectId: 'PV-100', operator: 'alice', requestId: 'biz-req-0', detail: 'v3', createdAt: '2026-11-02T09:00:00+08:00' },
  { id: 'audit-2', action: 'PLAN_PUBLISH', objectType: 'plan_version', objectId: 'PV-100', operator: 'admin', requestId: 'biz-req-1', detail: 'v3', createdAt: '2026-11-02T09:05:00+08:00' },
]

const tmp = mkdtempSync(join(tmpdir(), 'bff-audit-trail-test-'))
const wfDir = join(tmp, 'workflows')
mkdirSync(wfDir)

const mockAuth = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/api/v1/auth/me') {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    const user = USERS[token]
    res.writeHead(user ? 200 : 401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(user
      ? { code: 'OK', data: user }
      : { code: 'E_UNAUTHORIZED', message: '未认证或凭证已失效', data: null }))
    return
  }
  if (url.pathname === '/api/v1/audit-logs') {
    const objectId = url.searchParams.get('objectId')
    if (objectId === 'PV-FAIL') {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 'E_INTERNAL', message: 'mock 故障', data: null }))
      return
    }
    const items = objectId === 'PV-100' ? BIZ_AUDIT_PV100 : []
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 'OK', message: '', data: { items, page: 0, size: 200, total: items.length, totalPages: 1 } }))
    return
  }
  res.writeHead(404).end()
})

// 静默 WS hub（同 test-approval：mhs.mts 连不上 hub 会触发已知的 ECONNREFUSED 递归崩溃）
const mockHub = createServer()
mockHub.on('upgrade', (req, socket) => {
  const accept = createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
})

// env 必须在动态 import server.mts 之前设置（模块加载时读取）
process.env.AGENT_BFF_PORT = String(BFF_PORT)
process.env.AGENT_BFF_HOST = '127.0.0.1'
process.env.FJSP_API_BASE = `http://127.0.0.1:${MOCK_PORT}/api/v1`
process.env.AGENT_BFF_STORE_FILE = join(tmp, 'store.json')
process.env.AGENT_BFF_SESSION_ID_FILE = join(tmp, 'session-id')
process.env.AGENT_BFF_AUDIT_FILE = join(tmp, 'audit.jsonl')
process.env.AGENT_BFF_APPROVALS_FILE = join(tmp, 'approvals.json')
process.env.AGH_OWNER_FILE = join(tmp, 'owner.json') // 不存在 → daemon absent
process.env.AGNES_HUB_URL = `ws://127.0.0.1:${HUB_PORT}/ws/hub`
process.env.FJSP_WORKFLOW_DIR = wfDir

await new Promise<void>((resolve) => mockAuth.listen(MOCK_PORT, '127.0.0.1', resolve))
await new Promise<void>((resolve) => mockHub.listen(HUB_PORT, '127.0.0.1', resolve))
await import('./server.mts')

let passed = 0
function ok(name: string) {
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

async function api(method: string, path: string, { token, body, raw }: { token?: string; body?: unknown; raw?: boolean } = {}) {
  const res = await fetch(BFF + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (raw) return { status: res.status, contentType: res.headers.get('content-type'), text: await res.text() }
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

function writeCheckpoint(workflowId: string, cp: Record<string, unknown>) {
  writeFileSync(join(wfDir, `${workflowId}.json`), JSON.stringify({
    version: 1,
    workflowId,
    type: 'DISTURBANCE',
    status: 'COMPLETED',
    trigger: { source: 'mhs', dedupeKey: `dk-${workflowId}` },
    refs: { eventId: null, taskId: null, planVersionId: null },
    current: null,
    completedSteps: [],
    pendingApproval: null,
    expiredApprovals: [],
    createdAt: '2026-11-02T08:59:00+08:00',
    updatedAt: '2026-11-02T09:05:00+08:00',
    ...cp,
  }, null, 2))
}

try {
  // 准备：admin 登记两条审批——wf-audit-test-1（带 workflowId，随后批准落审计）与
  // 一条无 workflowId 的存量式记录（随后由 wf-audit-test-3 的检查点经 requestId 关联）
  const reg1 = await api('POST', '/approvals', {
    token: 'tok-admin',
    body: { conversationId: 'conv-audit', toolCall: { name: 'fjsp_publish', args: { planVersionId: 'PV-100' } }, workflowId: 'wf-audit-test-1' },
  })
  assert.equal(reg1.status, 202, JSON.stringify(reg1.data))
  const req1 = reg1.data.approval.requestId
  assert.equal(reg1.data.approval.workflowId, 'wf-audit-test-1', '登记响应应带 workflowId')
  const decide1 = await api('POST', '/permission', {
    token: 'tok-admin',
    body: { conversationId: 'conv-audit', requestId: req1, verdict: 'allowed-once' },
  })
  assert.equal(decide1.status, 202, JSON.stringify(decide1.data))

  const regLegacy = await api('POST', '/approvals', {
    token: 'tok-admin',
    body: { conversationId: 'conv-audit', toolCall: { name: 'fjsp_approve_review', args: { planVersionId: 'PV-legacy' } } },
  })
  assert.equal(regLegacy.status, 202)
  assert.equal(regLegacy.data.approval.workflowId, null, '未带 workflowId 的登记为 null')

  writeCheckpoint('wf-audit-test-1', {
    refs: { eventId: null, taskId: null, planVersionId: 'PV-100' },
    completedSteps: [
      { node: 'publish', seq: 1, attempt: 1, idempotencyKey: 'wf-audit-test-1:publish:1', result: { planVersionId: 'PV-100', requestId: req1 }, completedAt: '2026-11-02T09:05:00+08:00' },
    ],
  })
  writeCheckpoint('wf-audit-test-3', {
    refs: { eventId: null, taskId: null, planVersionId: 'PV-legacy' },
    completedSteps: [
      { node: 'review', seq: 1, attempt: 1, idempotencyKey: 'wf-audit-test-3:review:1', result: { requestId: regLegacy.data.approval.requestId }, completedAt: '2026-11-02T09:01:00+08:00' },
    ],
  })
  // 降级场景：检查点引用了 BFF 找不到的审批记录 + 业务审计不可达
  writeCheckpoint('wf-audit-test-2', {
    refs: { eventId: null, taskId: null, planVersionId: 'PV-FAIL' },
    completedSteps: [
      { node: 'publish', seq: 1, attempt: 1, idempotencyKey: 'wf-audit-test-2:publish:1', result: { requestId: 'req-ghost' }, completedAt: '2026-11-02T09:02:00+08:00' },
    ],
  })

  // 1. 聚合链完整性：一条 workflow 的审批 + 裁决留痕 + 业务副作用全部关联到
  const trail = await api('GET', '/audit/trail?workflowId=wf-audit-test-1', { token: 'tok-admin' })
  assert.equal(trail.status, 200, JSON.stringify(trail.data))
  const t = trail.data
  assert.equal(t.ok, true)
  assert.equal(t.workflow.workflowId, 'wf-audit-test-1')
  assert.equal(t.workflow.status, 'COMPLETED')
  assert.ok(t.approvals.some((a: { requestId: string; workflowId: string | null }) => a.requestId === req1 && a.workflowId === 'wf-audit-test-1'), '审批记录应经 workflowId 关联')
  assert.ok(t.approvalEvents.some((e: { requestId: string; result: string; by: string }) => e.requestId === req1 && e.result === 'approved' && e.by === 'admin'), '批准裁决留痕应关联到')
  assert.ok(t.businessAudit.some((b: { requestId: string; action: string }) => b.requestId === 'biz-req-1' && b.action === 'PLAN_PUBLISH'), '业务副作用（业务审计 + 业务请求 ID）应关联到')
  assert.ok(t.correlation.requestIds.includes(req1), 'correlation.requestIds 应含审批请求 ID')
  assert.ok(t.correlation.idempotencyKeys.includes('wf-audit-test-1:publish:1'), 'correlation 应含幂等键')
  assert.equal(t.correlation.refs.planVersionId, 'PV-100')
  assert.deepEqual(t.degraded, [], '链路完整时不应有降级标注')
  ok('聚合链完整性：审批记录+裁决留痕+业务副作用+关联键（requestId/幂等键/业务对象）齐全')

  // 2. 存量记录（无 workflowId）经检查点 requestId 关联
  const trail3 = await api('GET', '/audit/trail?workflowId=wf-audit-test-3', { token: 'tok-admin' })
  assert.equal(trail3.status, 200)
  assert.ok(trail3.data.approvals.some((a: { requestId: string }) => a.requestId === regLegacy.data.approval.requestId), '无 workflowId 的存量审批应经检查点 requestId 关联')
  assert.deepEqual(trail3.data.degraded, [])
  ok('存量审批记录（无 workflowId）经检查点 requestId 关联，关联键贯通向后兼容')

  // 3. 关联键缺失时的降级呈现：unknown 标注，不编造
  const trail2 = await api('GET', '/audit/trail?workflowId=wf-audit-test-2', { token: 'tok-admin' })
  assert.equal(trail2.status, 200)
  assert.deepEqual(trail2.data.approvals, [])
  assert.deepEqual(trail2.data.businessAudit, [])
  assert.ok(trail2.data.degraded.some((d: string) => d.includes('approval_unknown') && d.includes('req-ghost')), '找不到的审批记录应标 approval_unknown')
  assert.ok(trail2.data.degraded.some((d: string) => d.includes('business_audit_http_500')), '业务审计不可达应进 degraded')
  ok('关联键缺失/业务审计故障 → degraded 显式标注 unknown，不编造')

  // 4. 访问控制：未认证 401；低角色 403；跨用户低角色同样 403（角色闸与属主无关）
  const noAuth = await api('GET', '/audit/trail?workflowId=wf-audit-test-1')
  assert.equal(noAuth.status, 401)
  const lowRole = await api('GET', '/audit/trail?workflowId=wf-audit-test-1', { token: 'tok-dispatcher' })
  assert.equal(lowRole.status, 403)
  assert.equal(lowRole.data.error, 'audit_forbidden')
  ok('访问控制：未认证 401；非 ADMIN（含其他用户）403 audit_forbidden')

  // 5. 参数校验与未知工作流
  const badId = await api('GET', '/audit/trail?workflowId=../../etc', { token: 'tok-admin' })
  assert.equal(badId.status, 400)
  const noParam = await api('GET', '/audit/trail', { token: 'tok-admin' })
  assert.equal(noParam.status, 400)
  const notFound = await api('GET', '/audit/trail?workflowId=wf-no-such-workflow', { token: 'tok-admin' })
  assert.equal(notFound.status, 404)
  assert.equal(notFound.data.error, 'workflow_not_found')
  ok('参数校验：非法 workflowId / 缺查询条件 400；未知工作流 404')

  // 6. 按业务对象聚合：bizObject 值匹配 + 业务审计直通
  const byBiz = await api('GET', '/audit/trail?objectType=plan_version&objectId=PV-100', { token: 'tok-admin' })
  assert.equal(byBiz.status, 200)
  assert.ok(byBiz.data.approvals.some((a: { requestId: string }) => a.requestId === req1), '业务对象模式应命中 bizObject 匹配的审批')
  assert.ok(byBiz.data.approvalEvents.some((e: { requestId: string }) => e.requestId === req1), '业务对象模式应带出该审批的裁决留痕')
  assert.equal(byBiz.data.businessAudit.length, 2)
  ok('按业务对象（objectType+objectId）聚合：审批+留痕+业务审计齐全')

  // 7. 导出 format=jsonl：NDJSON、一行一条、kind 分区、顺序稳定
  const exp = await api('GET', '/audit/trail?workflowId=wf-audit-test-1&format=jsonl', { token: 'tok-admin', raw: true })
  assert.equal(exp.status, 200)
  assert.match(exp.contentType ?? '', /application\/x-ndjson/)
  const lines = exp.text!.trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines[0].kind, 'meta', '首行应为 meta（查询+关联键+降级标注）')
  assert.deepEqual(lines[0].correlation.requestIds, t.correlation.requestIds)
  const kinds = lines.map((l) => l.kind)
  assert.deepEqual(kinds, ['meta', 'workflow', 'approval', 'approval_event', 'business_audit', 'business_audit'], '导出顺序应稳定：meta→workflow→approval→approval_event→business_audit')
  assert.equal(lines.find((l) => l.kind === 'approval').requestId, req1)
  assert.ok(lines.filter((l) => l.kind === 'business_audit').some((l) => l.requestId === 'biz-req-1'))
  ok('导出 format=jsonl：NDJSON 稳定结构（meta/workflow/approval/approval_event/business_audit）')

  console.log(`\nPASS ${passed} 组断言全部通过`)
  process.exitCode = 0
} catch (err) {
  console.error('FAIL:', err)
  process.exitCode = 1
} finally {
  mockAuth.close()
  mockHub.close()
  rmSync(tmp, { recursive: true, force: true })
  // 本进程内 import 的 BFF 仍在监听，直接退出
  setTimeout(() => process.exit(process.exitCode ?? 0), 200)
}
