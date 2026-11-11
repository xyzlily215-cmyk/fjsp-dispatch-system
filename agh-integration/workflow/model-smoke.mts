// Opt-in paid smoke only. Synthetic input; never loads production business data.
// Usage: tsx workflow/model-smoke.mts --allow-billed --workspace /absolute/isolated-analysis-workspace
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { MARKER } from '../analysis-guard/index.mjs'
import { createAghDisturbanceAgent } from './agh-analysis.mts'
import { contextFixture } from './context-fixture.mts'
import { DEFAULT_STRATEGY } from './agent-nodes.mts'

if (!process.argv.includes('--allow-billed')) throw new Error('真实模型可能计费；确认预算后显式传 --allow-billed')
const operationIndex = process.argv.indexOf('--operation')
const operation = operationIndex < 0 ? 'strategy' : process.argv[operationIndex + 1]
if (!['strategy', 'conflicts', 'review'].includes(operation)) throw new Error('--operation 必须为 strategy / conflicts / review')
const index = process.argv.indexOf('--workspace')
if (index < 0 || !process.argv[index + 1]) throw new Error('必须显式指定新的隔离工作区 --workspace <path>')
const workspace = resolve(process.argv[index + 1])
if (existsSync(workspace)) throw new Error('拒绝覆盖已有目录；请指定全新隔离工作区')
mkdirSync(workspace, { recursive: true, mode: 0o700 })
writeFileSync(join(workspace, MARKER), JSON.stringify({ version: 1, mode: 'fjsp-workflow-analysis' }), { mode: 0o600, flag: 'wx' })
const agent = createAghDisturbanceAgent({ workspace, timeoutMs: 60000 })
const context = contextFixture()
const output = operation === 'strategy'
  ? await agent.suggestStrategy({ ...context, experience: { records: [], recommendation: null } })
  : operation === 'conflicts'
    ? await agent.explainConflicts({ outcome: 'infeasible', mode: 'LOCAL_RESCHEDULE', event: context.event,
      conflicts: [{ rule: 'AVAILABILITY_VIOLATION', objects: ['M-03', 'synthetic-op'], severity: 'ERROR', suggestion: '维修窗口内不能安排工序，请人工核实维修时长或评估完全重调度' }] })
    : await agent.buildReviewMaterial({ event: context.event, strategy: DEFAULT_STRATEGY,
      task: { taskId: 'synthetic-task', resultStatus: 'FEASIBLE', kpi: { cMaxMinutes: 470, weightedTardinessMinutes: 18, nTardy: 1, loadImbalance: 0.1 } },
      baselineKpi: { cMaxMinutes: 480, weightedTardinessMinutes: 30, nTardy: 1, loadImbalance: 0.12 },
      diff: { kpiDiff: { cMaxMinutes: -10, weightedTardinessMinutes: -12 }, changedOperationsTotal: 3, summary: { machineChangedCount: 1 } } })
const invocation = agent.lastInvocation()
console.log(JSON.stringify({ operation, output, invocation }, null, 2))
// A safe downgrade is not a successful live-model smoke.
if (invocation?.source !== 'model') process.exitCode = 1
