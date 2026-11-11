import type { DisturbanceContext } from './agent-nodes.mts'

// Explicit authoritative fixture; IDs intentionally do not follow operation naming conventions.
export function contextFixture(eventId = 'ev-1', planVersionId = 'pv-old'): DisturbanceContext {
  return {
    schemaVersion: 1, readAt: '2026-11-02T06:01:00Z',
    event: { eventId, eventType: 'BREAKDOWN', occurredAt: '2026-11-02T06:00:00Z', machineId: 'M-03' },
    baselinePlan: { id: planVersionId, status: 'PUBLISHED', kpi: { cMaxMinutes: 480, weightedTardinessMinutes: 30 } },
    constraints: {
      freezeWindowMinutes: 45, freezeStartsAt: '2026-11-02T06:00:00Z', hardLockedCount: 2,
      softLockedCount: 5, impactedOperationCount: 3, impactedOrderCount: 1, impactedOrders: ['real-order-id'],
      impactSummary: { total: 3, byType: { SAME_MACHINE_CONFLICT: 1, SUCCESSOR: 2 } },
      modeEstimates: { LOCAL_RESCHEDULE: { estimatedOperationCount: 2 }, FULL_RESCHEDULE: { estimatedOperationCount: 7 } },
      registeredImpacts: [{ operationId: 'opaque-operation', lockType: 'ADJUSTABLE' }],
    },
    affectedOrders: [{ orderId: 'real-order-id', dueAt: '2026-11-02T07:00:00Z', priority: 5, minutesToDueAtEvent: 60 }],
    deadlinePressure: { referenceAt: '2026-11-02T06:00:00Z', definition: 'dueAt - event.occurredAt',
      pastDueOrderCount: 0, dueWithin24HoursCount: 1, highPriorityOrderCount: 1, minMinutesToDueAtEvent: 60 },
    provenance: { event: `/events/${eventId}`, constraints: `/events/${eventId}/reschedule-preview`, affectedOrders: '/orders' },
    limitations: ['预览规模不是实际求解规模'],
  }
}
