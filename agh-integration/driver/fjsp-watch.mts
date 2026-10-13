// fjsp-watch driver: attaches to an EXISTING AGH session that has a parked
// watch_device, then waits for the device wake-up turn to run. Approves write-tool
// permission requests (operator role) and records every ledger event as evidence.
// Exits after fjsp_submit_review completes (plus a grace period for the final
// message), or on overall timeout.
// Usage: AGH_SESSION_ID=<id> tsx fjsp-watch.mts [cwd] [eventsOut.jsonl] [timeoutSec]
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { createClient } from '../agnes-harness/packages/sdk/src/index.node.ts'

const cwd = process.argv[2] ?? '/Users/xiongyingzi/Documents/ChatGPT/bysj/agh-integration'
const eventsOut = process.argv[3] ?? `/tmp/agh-watch-${Date.now()}.events.jsonl`
const timeoutSec = Number(process.argv[4] ?? 900)

const log = (line: string) => {
  const stamped = `${new Date().toISOString()} ${line}`
  console.log(stamped)
  appendFileSync(eventsOut + '.log', stamped + '\n')
}

const owner = JSON.parse(readFileSync(`${process.env.HOME}/.agh/data/daemon/owner.json`, 'utf8'))
const client = createClient({
  transport: { kind: 'unix', path: owner.socketPath },
  clientId: 'fjsp-verify-driver',
})

const sessionId = process.env.AGH_SESSION_ID ?? readFileSync(new URL('../.agh-session-id', import.meta.url), 'utf8').trim()
const session = await client.session.load(sessionId, { cwd })
log(`[session] attached ${session.id}`)
writeFileSync(new URL('../.agh-session-id', import.meta.url), session.id)

session.onPermissionRequest(async (req) => {
  log(`[approval] operator approves ${JSON.stringify(req.toolCall).slice(0, 300)}`)
  return { verdict: 'allowed-once' }
})

const texts: string[] = []
let reviewSubmitted = false
const collector = (async () => {
  for await (const e of session.events()) {
    appendFileSync(eventsOut, JSON.stringify(e) + '\n')
    if (e.type === 'tool/call') {
      const d = e.data as { name?: string; args?: unknown }
      log(`[tool:call] ${d.name} ${JSON.stringify(d.args)}`)
      if (d.name === 'fjsp_submit_review') reviewSubmitted = true
    } else if (e.type === 'tool/result') {
      const d = e.data as { content?: { text?: string }[]; code?: string }
      log(`[tool:result] ${d.code ?? 'ok'} ${(d.content?.[0]?.text ?? '').slice(0, 220)}`)
    } else if (e.type === 'assistant/message') {
      const d = e.data as { content?: { type: string; text?: string }[] }
      const text = (d.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('')
      if (text) texts.push(text)
    }
  }
})()

const deadline = Date.now() + timeoutSec * 1000
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 2000))
  if (reviewSubmitted) break
}
// grace period for the closing assistant message after submit-review
await new Promise((resolve) => setTimeout(resolve, reviewSubmitted ? 45_000 : 0))
log(`[done] reviewSubmitted=${reviewSubmitted}`)
writeFileSync(eventsOut + '.answer.txt', texts.join('\n---\n'))
console.log('===== FINAL ANSWER =====')
console.log(texts.join('\n---\n'))
await client.close()
process.exit(0)
