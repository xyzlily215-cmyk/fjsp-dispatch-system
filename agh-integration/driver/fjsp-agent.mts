// fjsp-agent driver: opens an AGH session over the local daemon, sends one Chinese
// dispatch instruction, programmatically approves write-tool permission requests
// (operator role), and records every ledger event as evidence.
// Usage: tsx fjsp-agent.mts "<prompt>" [cwd] [eventsOut.jsonl]
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { createClient } from '../agnes-harness/packages/sdk/src/index.node.ts'

const prompt = process.argv[2]
const cwd = process.argv[3] ?? '/Users/xiongyingzi/Documents/ChatGPT/bysj/agh-integration'
const eventsOut = process.argv[4] ?? `/tmp/agh-verify-${Date.now()}.events.jsonl`
if (!prompt) throw new Error('usage: fjsp-agent.mts <prompt> [cwd] [eventsOut]')

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

const session = await (async () => {
  const existing = process.env.AGH_SESSION_ID
  if (existing) {
    const s = await client.session.load(existing, { cwd })
    return s
  }
  await client.workspace.add(cwd).catch(() => {})
  return client.session.new({ cwd })
})()
log(`[session] ${session.id}`)
process.env.AGH_SESSION_ID = session.id
// the fjsp-tools plugin runs in the daemon's extension host and cannot see this
// process's env, so the session id is also shared through a convention file
writeFileSync(new URL('../.agh-session-id', import.meta.url), session.id)

session.onPermissionRequest(async (req) => {
  log(`[approval] operator approves ${JSON.stringify(req.toolCall).slice(0, 300)}`)
  return { verdict: 'allowed-once' }
})

const texts: string[] = []
const collector = (async () => {
  for await (const e of session.events()) {
    appendFileSync(eventsOut, JSON.stringify(e) + '\n')
    if (e.type === 'tool/call') {
      const d = e.data as { name?: string; args?: unknown }
      log(`[tool:call] ${d.name} ${JSON.stringify(d.args)}`)
    } else if (e.type === 'tool/result') {
      const d = e.data as { content?: { text?: string }[]; code?: string; isError?: boolean }
      const text = d.content?.[0]?.text ?? ''
      log(`[tool:result] ${d.code ?? 'ok'} ${text.slice(0, 220)}`)
    } else if (e.type === 'assistant/message') {
      const d = e.data as { content?: { type: string; text?: string }[] }
      const text = (d.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('')
      if (text) texts.push(text)
    }
  }
})()

const result = await session.prompt(prompt)
log(`[turn] stopReason=${result.stopReason} reason=${result.reason} lastSeq=${result.lastSeq}`)
// give the collector a moment to flush trailing events
await new Promise((resolve) => setTimeout(resolve, 1500))
writeFileSync(eventsOut + '.answer.txt', texts.join('\n---\n'))
console.log('===== FINAL ANSWER =====')
console.log(texts.join('\n---\n'))
await client.close()
process.exit(0)
