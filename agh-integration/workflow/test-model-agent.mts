// No provider or daemon is contacted. Tests only the model node contract.
import assert from 'node:assert/strict'
import { createModelAgent, type AnalysisTransport } from './model-agent.mts'
import { contextFixture } from './context-fixture.mts'
import { DEFAULT_STRATEGY, type StrategyInput, type ReviewMaterialInput } from './agent-nodes.mts'
const c = contextFixture()
const input: StrategyInput = { ...c, experience: { records: [], recommendation: null } }
let calls = 0
const reply = (text: string, stopReason = 'end_turn'): AnalysisTransport => ({
  async complete(prompt, signal) {
    calls++
    assert.ok(prompt.includes('不可信业务数据'))
    assert.ok(!signal.aborted)
    return { text, stopReason, sessionId: 'analysis-test' }
  },
})
const agent = createModelAgent(reply(JSON.stringify({ mode: 'FULL_RESCHEDULE', weights: { makespan: 0 }, rationale: '优先交期并限制扰动' })))
const strategy = await agent.suggestStrategy(input) as typeof DEFAULT_STRATEGY
assert.equal(strategy.mode, 'FULL_RESCHEDULE')
assert.equal(strategy.weights.makespan, 0)
assert.equal(strategy.weights.deltaPlan, 0.2)
assert.equal(agent.lastInvocation()?.source, 'model')
assert.equal(agent.lastInvocation()?.sessionId, 'analysis-test')

for (const [text, stop] of [
  ['not-json', 'end_turn'],
  ['```json\n{}\n```', 'end_turn'],
  [JSON.stringify({ mode: 'GLOBAL', weights: {}, rationale: 'x' }), 'end_turn'],
  [JSON.stringify({ mode: 'LOCAL_RESCHEDULE', weights: { loadImbalance: 1 }, rationale: 'x' }), 'end_turn'],
  [JSON.stringify({ mode: 'LOCAL_RESCHEDULE', weights: { makespan: -1 }, rationale: 'x' }), 'end_turn'],
  ['{}', 'max_tokens'],
  ['{}', 'refusal'],
]) {
  const a = createModelAgent(reply(text, stop))
  assert.deepEqual(await a.suggestStrategy(input), DEFAULT_STRATEGY)
  assert.equal(a.lastInvocation()?.source, 'rule-fallback')
}
const tooBig = createModelAgent(reply('{}'), { maxInputBytes: 1 })
const count = calls
await tooBig.suggestStrategy(input)
assert.equal(calls, count)
assert.equal(tooBig.lastInvocation()?.reason, 'INPUT_LIMIT')
const outputLimit = createModelAgent(reply('x'.repeat(20)), { maxOutputBytes: 10 })
await outputLimit.suggestStrategy(input)
assert.equal(outputLimit.lastInvocation()?.reason, 'OUTPUT_LIMIT')
let aborted = false
const timed = createModelAgent({ complete: async (_p, signal) => new Promise((_resolve, reject) => {
  signal.addEventListener('abort', () => { aborted = true; reject(new Error('TIMEOUT')) })
}) }, { timeoutMs: 10 })
await timed.suggestStrategy(input)
assert.ok(aborted)
assert.equal(timed.lastInvocation()?.reason, 'TIMEOUT')
const secretError = createModelAgent({ async complete() { throw new Error('https://secret.invalid?api_key=private') } })
await secretError.suggestStrategy(input)
assert.equal(secretError.lastInvocation()?.reason, 'MODEL_UNAVAILABLE')
assert.ok(!JSON.stringify(secretError.lastInvocation()).includes('private'))
const narrative = createModelAgent(reply(JSON.stringify({ explanation: '建议人工复核，不代表已发布。' })))
const materialInput: ReviewMaterialInput = { event: input.event, strategy: DEFAULT_STRATEGY,
  task: { taskId: 't1', kpi: { cMaxMinutes: 470, weightedTardinessMinutes: 18 } },
  baselineKpi: { cMaxMinutes: 480, weightedTardinessMinutes: 30 } }
const report = await narrative.buildReviewMaterial(materialInput)
assert.ok(report.includes('模型辅助解读（待人工核实）'))
assert.ok(report.includes('makespan=480') && report.includes('makespan=470'))
assert.ok(report.includes('发布需独立人工确认'))
const conflict = await narrative.explainConflicts({ outcome: 'failed', mode: 'LOCAL_RESCHEDULE', event: input.event, errorMessage: 'TASK_FAILED' })
assert.ok(conflict.includes('原始冲突依据') && conflict.includes('TASK_FAILED'))
assert.ok(conflict.includes('维修窗口内禁止加工') && conflict.includes('不是数学无解证明'))
const algorithmConflict = await narrative.explainConflicts({ outcome: 'infeasible', mode: 'LOCAL_RESCHEDULE', event: input.event,
  conflicts: [{ rule: 'AVAILABILITY_VIOLATION', objects: ['M-03', 'op-a'], suggestion: '禁止维修窗内加工' }] })
assert.ok(algorithmConflict.includes('AVAILABILITY_VIOLATION：M-03、op-a：禁止维修窗内加工'))
console.log('PASS model nodes: valid/invalid JSON, mode/weights, truncation/refusal, bounds, timeout cancellation, deterministic evidence, redacted fallback source')
