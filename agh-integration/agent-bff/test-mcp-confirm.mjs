// test-mcp-confirm: MCP `_confirm` 回归（任务 1.3 第 3 项）——直调 MCP server 带
// _confirm:true 的 WRITE 工具必须 APPROVAL_CHANNEL_REQUIRED，且对真实 business-service
// 无业务副作用（故障事件数不变）。与 mcp-smoke.mjs 的差异：FJSP_API_BASE 指向真实
// 隔离回归业务服务（而非死端口），并在调用前后核对 BREAKDOWN 事件总数。
//
// 安全守卫：必须显式提供 FJSP_API_BASE 且不得指向演示端口 8081。
// 运行（在 agh-integration/agent-bff/ 目录下，先起好回归环境）：
//   FJSP_API_BASE=http://localhost:18081/api/v1 node test-mcp-confirm.mjs
// tsx 解析顺序：FJSP_TSX 环境变量 → ../agnes-harness/node_modules/.bin/tsx
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const FJSP_API_BASE = (process.env.FJSP_API_BASE ?? '').replace(/\/+$/, '')
if (!FJSP_API_BASE || /:(8081)(\/|$)/.test(FJSP_API_BASE)) {
  console.error(`FAIL: FJSP_API_BASE（${FJSP_API_BASE || '未设置'}）必须显式指向隔离回归业务服务，且不得为演示端口 8081`)
  process.exit(2)
}
const PASSWORD = process.env.FJSP_REG_AUTH_PASSWORD ?? process.env.FJSP_AUTH_PASSWORD ?? 'Fj@123456'
const tsx = process.env.FJSP_TSX ?? new URL('../agnes-harness/node_modules/.bin/tsx', import.meta.url).pathname
if (!existsSync(tsx)) {
  console.error(`FAIL: 找不到 tsx（${tsx}），可用 FJSP_TSX 指定`)
  process.exit(2)
}

let failures = 0
const assert = (cond, msg) => {
  if (cond) console.log('PASS ' + msg)
  else { failures++; console.log('FAIL ' + msg) }
}

const loginRes = await fetch(`${FJSP_API_BASE}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: PASSWORD }),
})
const loginJson = await loginRes.json()
if (!loginRes.ok || !loginJson?.data?.token) {
  console.error(`FAIL: 登录回归业务服务失败 HTTP ${loginRes.status}`)
  process.exit(1)
}
const TOKEN = loginJson.data.token

async function breakdownCount() {
  const res = await fetch(`${FJSP_API_BASE}/events?eventType=BREAKDOWN&page=0&size=1`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  const json = await res.json()
  return json.data.total
}

const server = spawn(tsx, [new URL('./mcp-server.mts', import.meta.url).pathname], {
  env: { ...process.env, FJSP_API_BASE },
  stdio: ['pipe', 'pipe', 'inherit'],
})

let buf = ''
const pending = new Map()
let seq = 0
server.stdout.on('data', (chunk) => {
  buf += chunk
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx)
    buf = buf.slice(idx + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
})
const call = (method, params = {}) => {
  const id = String(++seq)
  return new Promise((resolve) => {
    pending.set(id, resolve)
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

try {
  const init = await call('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-mcp-confirm', version: '0' },
  })
  assert(init.result?.serverInfo, 'MCP initialize 成功')

  // 对照：READ 工具真实打通回归业务服务（证明 MCP 确实指向 FJSP_API_BASE）
  const dash = await call('tools/call', { name: 'fjsp_get_dashboard', arguments: {} })
  assert(!dash.result.isError, `READ 工具 fjsp_get_dashboard 真实可达（${dash.result.content[0].text.slice(0, 80)}…）`)

  const before = await breakdownCount()

  // WRITE 带 _confirm:true 直调 → 必须 APPROVAL_CHANNEL_REQUIRED
  const write = await call('tools/call', {
    name: 'fjsp_report_breakdown',
    arguments: {
      machineId: 'M-07',
      occurredAt: '2026-09-18T00:00:00.000Z',
      repairDurationMinutes: 30,
      note: 'security-regression-mcp-confirm（若落库即回归）',
      _confirm: true,
    },
  })
  const payload = JSON.parse(write.result.content[0].text)
  assert(write.result.isError === true, 'fjsp_report_breakdown 带 _confirm:true → isError')
  assert(payload.error?.code === 'APPROVAL_CHANNEL_REQUIRED',
    `错误码 APPROVAL_CHANNEL_REQUIRED（实际 ${payload.error?.code}）`)

  // DESTRUCTIVE 同样
  const destructive = await call('tools/call', { name: 'fjsp_reset_demo', arguments: { _confirm: true } })
  const dPayload = JSON.parse(destructive.result.content[0].text)
  assert(destructive.result.isError === true && dPayload.error?.code === 'APPROVAL_CHANNEL_REQUIRED',
    'fjsp_reset_demo 带 _confirm:true → APPROVAL_CHANNEL_REQUIRED')

  // 无业务副作用：BREAKDOWN 事件总数不变（若写工具被放行，此处必然 +1）
  const after = await breakdownCount()
  assert(after === before, `无业务副作用：BREAKDOWN 事件总数不变（${before} -> ${after}）`)
} finally {
  server.kill()
}

if (failures) {
  console.error(`\nFAIL ${failures} 项断言未过`)
  process.exit(1)
}
console.log('\nPASS MCP _confirm 回归全部通过（真实业务服务 ' + FJSP_API_BASE + '）')
process.exit(0)
