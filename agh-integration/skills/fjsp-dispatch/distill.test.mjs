// distill.mjs 的聚焦测试：mock 经验库一律写入临时目录，绝不触碰真实经验库。
// 运行：node --test agh-integration/skills/fjsp-dispatch/distill.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { aggregate, buildProposal, DEFAULT_MIN_SUPPORT } from './distill.mjs'

const NOW = Date.parse('2026-11-02T00:00:00.000Z')
const ts = '2026-10-30T00:00:00.000Z'

function rec(over = {}) {
  return {
    id: over.id ?? `exp-${Math.random().toString(36).slice(2, 10)}`,
    ts,
    eventType: 'BREAKDOWN',
    mode: 'LOCAL_RESCHEDULE',
    machineId: 'M-03',
    resultStatus: 'FEASIBLE',
    kpiDiff: { weightedTardinessMinutes: 100, deltaPlan: 0.1 },
    published: true,
    ...over,
  }
}

function feedback(experienceId, outcome, feedbackAt = '2026-10-31T00:00:00.000Z') {
  return { kind: 'feedback', experienceId, outcome, feedbackAt }
}

test('高频成功模式按 扰动类型×mode 正确聚合', () => {
  const a = rec({ id: 'a1' })
  const b = rec({ id: 'a2', kpiDiff: { weightedTardinessMinutes: 200, deltaPlan: 0.2 } })
  const c = rec({ id: 'a3', machineId: 'M-05' })
  const lines = [a, b, c, feedback('a1', 'success'), rec({ id: 'n1', eventType: 'NEW_ORDER', mode: 'FULL_RESCHEDULE' })]
  const groups = aggregate(lines, NOW)
  const local = groups.find((g) => g.key === 'BREAKDOWN × LOCAL_RESCHEDULE')
  assert.equal(local.count, 3)
  assert.equal(local.published, 3)
  assert.equal(Math.round(local.tardinessSum / local.tardinessCount), 133)
  const full = groups.find((g) => g.key === 'NEW_ORDER × FULL_RESCHEDULE')
  assert.equal(full.count, 1)
  // 组按 count 降序
  assert.equal(groups[0].key, 'BREAKDOWN × LOCAL_RESCHEDULE')
})

test('负面 outcome（rejected/reworked/failed）与 partial 不进提案', () => {
  const lines = [
    rec({ id: 'ok1' }),
    rec({ id: 'bad1' }),
    rec({ id: 'bad2' }),
    rec({ id: 'bad3' }),
    feedback('bad1', 'rejected'),
    feedback('bad2', 'reworked'),
    feedback('bad3', 'failed'),
    feedback('ok1', 'success'),
  ]
  const groups = aggregate(lines, NOW)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].count, 1)
  // 全部为负面时无任何模式组
  const allBad = aggregate([rec({ id: 'x1' }), feedback('x1', 'failed')], NOW)
  assert.equal(allBad.length, 0)
})

test('样本不足时提案明确写"证据不足"，且不进入规则草稿', () => {
  const groups = aggregate([rec({ id: 's1' }), rec({ id: 's2', mode: 'FULL_RESCHEDULE' })], NOW)
  const md = buildProposal({ groups, minSupport: DEFAULT_MIN_SUPPORT, file: '/tmp/mock.jsonl', total: 2, badLines: 0, missing: false, now: new Date(NOW) })
  assert.match(md, /证据不足/)
  assert.match(md, /所有模式组样本不足/)
  assert.doesNotMatch(md, /### 规则 1/)
})

test('样本达到 minSupport 时产出规则草稿与支撑证据计数', () => {
  const lines = [rec({ id: 'e1' }), rec({ id: 'e2' }), rec({ id: 'e3' })]
  const groups = aggregate(lines, NOW)
  const md = buildProposal({ groups, minSupport: 3, file: '/tmp/mock.jsonl', total: 3, badLines: 0, missing: false, now: new Date(NOW) })
  assert.match(md, /### 规则 1：设备故障 → LOCAL_RESCHEDULE/)
  assert.match(md, /n=3/)
  assert.match(md, /只产出提案|只是提案/)
})

test('空库与不存在的文件不报错，提案写明无规则', () => {
  const dir = mkdtempSync(join(tmpdir(), 'distill-test-'))
  const out = join(dir, 'distill-proposal.md')
  const missingFile = join(dir, 'no-such.jsonl')
  execFileSync(process.execPath, [new URL('./distill.mjs', import.meta.url).pathname, '--experience-file', missingFile, '--out', out])
  const md = readFileSync(out, 'utf8')
  assert.match(md, /文件不存在/)
  assert.match(md, /空库不视为错误/)
})

test('空文件（0 行）同样不报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'distill-test-'))
  const file = join(dir, 'empty.jsonl')
  writeFileSync(file, '')
  const out = join(dir, 'distill-proposal.md')
  execFileSync(process.execPath, [new URL('./distill.mjs', import.meta.url).pathname, '--experience-file', file, '--out', out])
  assert.match(readFileSync(out, 'utf8'), /无可蒸馏规则/)
})

test('求解不可行（resultStatus!=FEASIBLE）的记录不计入成功模式', () => {
  const groups = aggregate([rec({ id: 'f1', resultStatus: 'INFEASIBLE' }), rec({ id: 'f2' })], NOW)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].count, 1)
})
