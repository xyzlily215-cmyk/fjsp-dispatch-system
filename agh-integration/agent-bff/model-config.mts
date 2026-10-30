// model-config: inspect and switch the daemon's model provider account via the SDK config API.
// The API key is read from env AGH_MODEL_API_KEY (never argv, never written to the repo);
// it is stored by the daemon in ~/.agh (outside this repository).
//
//   tsx model-config.mts list
//   tsx model-config.mts providers
//   tsx model-config.mts test <providerId> <model>
//   tsx model-config.mts save <providerId> <model> [--default] [--base-url <url>]
import { readFileSync } from 'node:fs'
import { createClient } from '../agnes-harness/packages/sdk/src/index.node.ts'

const [action, providerId, model, ...rest] = process.argv.slice(2)
const owner = JSON.parse(readFileSync(`${process.env.HOME}/.agh/data/daemon/owner.json`, 'utf8'))
const client = createClient({
  transport: { kind: 'unix', path: owner.socketPath },
  clientId: 'fjsp-model-config',
})

function flag(name: string): string | null {
  const i = rest.indexOf(name)
  return i >= 0 ? (rest[i + 1] ?? null) : null
}

try {
  if (action === 'list') {
    const snap = await client.config.get()
    console.log(JSON.stringify(snap, null, 2))
  } else if (action === 'providers') {
    const providers = await client.config.providers()
    console.log(JSON.stringify(providers, null, 2))
  } else if (action === 'test') {
    if (!providerId || !model) throw new Error('usage: test <providerId> <model>')
    const apiKey = process.env.AGH_MODEL_API_KEY
    const result = await client.config.test({
      providerId,
      model,
      ...(apiKey ? { apiKey } : {}),
      ...(flag('--base-url') ? { baseUrl: flag('--base-url')! } : {}),
    })
    console.log(JSON.stringify(result, null, 2))
  } else if (action === 'save') {
    if (!providerId || !model) throw new Error('usage: save <providerId> <model> [--default] [--base-url <url>]')
    const apiKey = process.env.AGH_MODEL_API_KEY
    if (!apiKey) throw new Error('AGH_MODEL_API_KEY env is required for save')
    const snap = await client.config.save({
      providerId,
      model,
      apiKey,
      ...(flag('--base-url') ? { baseUrl: flag('--base-url')! } : {}),
      ...(rest.includes('--default') ? { makeDefault: true } : {}),
    })
    console.log(JSON.stringify(snap, null, 2))
  } else {
    throw new Error('usage: list | providers | test <providerId> <model> | save <providerId> <model> [--default]')
  }
} finally {
  await client.close()
}
