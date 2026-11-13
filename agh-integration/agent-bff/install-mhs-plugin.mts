// install-mhs-plugin: disable → remove → inspect → install → trust → enable @agnes/mhs
// （AgnesHub 数字孪生设备通道插件）。与 reinstall-plugin.mts 同流程，差异：
// capabilityHash 不硬编码，取自 inspect 结果（package-manager/inspect.ts 会算好）。
// 插件源 file:./agnes-harness/packages/mhs/plugin 相对 daemon workspace（agh-integration/）解析，
// 需已执行 pnpm --filter @agnes/mhs build:plugin（本仓库复制的源码树已含 dist/hub.mjs）。
// Usage: ../agnes-harness/node_modules/.bin/tsx install-mhs-plugin.mts
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createClient } from '../agnes-harness/packages/sdk/src/index.node.ts'
import { createPackageAdminClient } from '../agnes-harness/packages/sdk/src/package-admin.node.ts'

const PROFILE = 'local-dev'
const PKG_ID = '@agnes/mhs'
const SOURCE = { type: 'file', ref: 'file:./agnes-harness/packages/mhs/plugin' }

const owner = JSON.parse(readFileSync(`${process.env.HOME}/.agh/data/daemon/owner.json`, 'utf8'))
const client = createClient({
  transport: { kind: 'unix', path: owner.socketPath },
  clientId: 'fjsp-mhs-plugin-admin',
})
const pa = createPackageAdminClient({
  call: (method: string, params: unknown) => client.call(method, params as Record<string, unknown>),
})

const base = () => ({ profile: PROFILE, clientId: 'fjsp-mhs-plugin-admin', commandId: randomUUID() })

async function waitOp(receipt: { operationId: string }, label: string, allowFail = false) {
  for (;;) {
    const op = await pa.operation.get({ profile: PROFILE, operationId: receipt.operationId })
    if (['completed', 'failed', 'cancelled', 'rolled-back'].includes(op.state)) {
      const detail = op.state === 'completed' ? '' : JSON.stringify(op).slice(0, 500)
      console.log(`[${label}] ${op.state} ${detail}`)
      if (op.state !== 'completed' && !allowFail) throw new Error(`${label} ${op.state}: ${detail}`)
      return op
    }
    await new Promise((r) => setTimeout(r, 400))
  }
}

try {
  await waitOp(await pa.disable({ ...base(), id: PKG_ID }), 'disable', true)
  await waitOp(await pa.remove({ ...base(), id: PKG_ID }), 'remove', true)

  const inspected = await waitOp(await pa.inspect({ ...base(), source: SOURCE }), 'inspect')
  const pick = (k: string) =>
    (inspected as Record<string, Record<string, unknown>>).preview?.[k]
    ?? (inspected as Record<string, Record<string, unknown>>).result?.[k]
    ?? (inspected as Record<string, unknown>)[k]
  const integrity = pick('integrity')
  const capabilityHash = pick('capabilityHash')
  if (!integrity || !capabilityHash) {
    throw new Error('inspect 未返回 integrity/capabilityHash: ' + JSON.stringify(inspected).slice(0, 500))
  }
  console.log('[integrity]', integrity, '[capabilityHash]', capabilityHash)

  await waitOp(await pa.install({ ...base(), source: SOURCE, expectedIntegrity: integrity }), 'install')
  await waitOp(
    await pa.trust({ ...base(), id: PKG_ID, expectedIntegrity: integrity, capabilityHash }),
    'trust',
  )
  await waitOp(await pa.enable({ ...base(), id: PKG_ID, expectedInstalledIntegrity: integrity }), 'enable')

  const list = await pa.list({ profile: PROFILE })
  console.log('[list]', JSON.stringify(list).slice(0, 800))
} finally {
  await client.close()
}
