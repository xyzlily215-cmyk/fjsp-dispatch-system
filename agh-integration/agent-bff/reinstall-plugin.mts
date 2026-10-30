// reinstall-plugin: disable → remove → inspect → install → trust → enable @fjsp/fjsp-tools
// through the daemon's package-admin RPC (SDK 直连，等价于 README 的 CLI 流程，
// 用于 CLI 无法拉起本地 daemon 的环境）。capabilities 未变，capabilityHash 沿用 README 记录值。
// Usage: ../agnes-harness/node_modules/.bin/tsx reinstall-plugin.mts
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createClient } from '../agnes-harness/packages/sdk/src/index.node.ts'
import { createPackageAdminClient } from '../agnes-harness/packages/sdk/src/package-admin.node.ts'

const PROFILE = 'local-dev'
const PKG_ID = '@fjsp/fjsp-tools'
const SOURCE = { type: 'file', ref: 'file:./fjsp-tools' }
const CAPABILITY_HASH = 'e3de4e5f2da4b8aa2650af5c4f822d397c2dadd7a6695e5071c0444d26a22b01'

const owner = JSON.parse(readFileSync(`${process.env.HOME}/.agh/data/daemon/owner.json`, 'utf8'))
const client = createClient({
  transport: { kind: 'unix', path: owner.socketPath },
  clientId: 'fjsp-package-admin',
})
const pa = createPackageAdminClient({
  call: (method: string, params: unknown) => client.call(method, params as Record<string, unknown>),
})

const base = () => ({ profile: PROFILE, clientId: 'fjsp-package-admin', commandId: randomUUID() })

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
  const integrity =
    (inspected as { preview?: { integrity?: string } }).preview?.integrity
    ?? (inspected as { result?: { integrity?: string } }).result?.integrity
    ?? (inspected as { integrity?: string }).integrity
  if (!integrity) throw new Error('inspect 未返回 integrity: ' + JSON.stringify(inspected).slice(0, 500))
  console.log('[integrity]', integrity)

  await waitOp(await pa.install({ ...base(), source: SOURCE, expectedIntegrity: integrity }), 'install')
  await waitOp(
    await pa.trust({ ...base(), id: PKG_ID, expectedIntegrity: integrity, capabilityHash: CAPABILITY_HASH }),
    'trust',
  )
  await waitOp(await pa.enable({ ...base(), id: PKG_ID, expectedInstalledIntegrity: integrity }), 'enable')

  const list = await pa.list({ profile: PROFILE })
  console.log('[list]', JSON.stringify(list).slice(0, 800))
} finally {
  await client.close()
}
