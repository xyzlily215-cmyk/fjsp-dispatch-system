// Effective objectives in algorithm-service/app/ga.py resolve_objective_weights.
// Missing keys receive these defaults; values are not normalized to sum to one.
export const BASELINE_WEIGHT_DEFAULTS = Object.freeze({ makespan: 0.4, weightedTardiness: 0.4, loadImbalance: 0.2 })
export const RESCHEDULE_WEIGHT_DEFAULTS = Object.freeze({ weightedTardiness: 0.4, makespan: 0.3, deltaPlan: 0.2, machineChange: 0.1 })
export const BASELINE_WEIGHT_KEYS = Object.freeze(Object.keys(BASELINE_WEIGHT_DEFAULTS))
export const RESCHEDULE_WEIGHT_KEYS = Object.freeze(Object.keys(RESCHEDULE_WEIGHT_DEFAULTS))
