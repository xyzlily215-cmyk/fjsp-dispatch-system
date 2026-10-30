// mcp-smoke: spawn the MCP server, run initialize → tools/list → tools/call.
const { spawn } = await import('node:child_process')

const here = '/Users/xiongyingzi/Desktop/bysj/agh-integration/agent-bff/'
const server = spawn(
  `${here}../agnes-harness/node_modules/.bin/tsx`,
  [`${here}mcp-server.mts`],
  { stdio: ['pipe', 'pipe', 'inherit'] },
)

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

function call(method, params = {}) {
  const id = String(++seq)
  return new Promise((resolve) => {
    pending.set(id, resolve)
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

const init = await call('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'mcp-smoke', version: '0.1' },
})
console.log('[initialize]', init.result.serverInfo, '| protocol:', init.result.protocolVersion)

const list = await call('tools/list')
console.log('[tools/list] count:', list.result.tools.length)
console.log('  names:', list.result.tools.map((t) => t.name).join(', '))

const dash = await call('tools/call', { name: 'fjsp_get_dashboard', arguments: {} })
console.log('[fjsp_get_dashboard] isError:', !!dash.result.isError, '|', dash.result.content[0].text.slice(0, 160))

const denied = await call('tools/call', { name: 'fjsp_experience_record', arguments: { eventType: 'BREAKDOWN', mode: 'LOCAL_RESCHEDULE' } })
console.log('[write without _confirm] isError:', !!denied.result.isError, '|', denied.result.content[0].text.slice(0, 180))

const confirmed = await call('tools/call', {
  name: 'fjsp_experience_record',
  arguments: { eventType: 'BREAKDOWN', mode: 'LOCAL_RESCHEDULE', note: 'MCP 通道冒烟测试（随后清理）', _confirm: true },
})
console.log('[write with _confirm] isError:', !!confirmed.result.isError, '|', confirmed.result.content[0].text.slice(0, 160))

server.kill()
process.exit(0)
