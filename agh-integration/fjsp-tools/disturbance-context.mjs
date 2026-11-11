// Read-only aggregation over existing business APIs. No independent impact algorithm.
// Counts come from reschedule-preview; due pressure is explicitly relative to event time.
export async function readDisturbanceContext(api, { eventId, planVersionId, freezeWindowMinutes }) {
  const eventPath = `/events/${encodeURIComponent(eventId)}`
  const query = new URLSearchParams({ planVersionId })
  if (freezeWindowMinutes !== undefined) query.set('freezeWindowMinutes', String(freezeWindowMinutes))
  const previewPath = `${eventPath}/reschedule-preview?${query}`
  const eventResult = await api('GET', eventPath)
  if (!eventResult.ok) return eventResult
  const previewResult = await api('GET', previewPath)
  if (!previewResult.ok) return previewResult
  const dashboardPath = `/dashboard?${new URLSearchParams({ planVersionId })}`
  const [dashboardResult, ordersResult] = await Promise.all([
    api('GET', dashboardPath), api('GET', '/orders'),
  ])
  if (!dashboardResult.ok) return dashboardResult
  if (!ordersResult.ok) return ordersResult

  const event = eventResult.data
  const preview = previewResult.data
  const plan = dashboardResult.data?.currentPlan
  const orders = ordersResult.data
  const invalid = (message) => ({ ok: false, error: { code: 'FJSP_BAD_RESPONSE', message: `扰动上下文不完整：${message}` } })
  const timestamp = (value) => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
  if (!event || !preview || !plan || !Array.isArray(orders)) return invalid('缺少事件、影响预览、计划或订单数组')
  if (event.status === 'CLOSED') return { ok: false, error: { code: 'E_STATE_CONFLICT', message: '事件已关闭，不可继续重调度' } }
  if (event.eventId !== preview.eventId || event.eventType !== preview.eventType
      || !timestamp(preview.occurredAt) || Date.parse(event.occurredAt) !== Date.parse(preview.occurredAt) || plan.id !== preview.planVersionId
      || ![event.eventId, event.eventCode].includes(eventId)
      || ![plan.id, plan.versionCode].includes(planVersionId)) return invalid('事件或固定计划版本不匹配')
  const at = Date.parse(event.occurredAt)
  if (!timestamp(event.occurredAt) || !['BREAKDOWN', 'NEW_ORDER'].includes(event.eventType)
      || !Array.isArray(event.impacts) || !Array.isArray(preview.impactedOrders)
      || !preview.impactedOrders.every((id) => typeof id === 'string')
      || !plan.kpi || typeof plan.kpi !== 'object' || Array.isArray(plan.kpi)) return invalid('事件时间、类型、影响集合或 KPI 缺失')
  if (event.eventType === 'BREAKDOWN' && (typeof event.machineId !== 'string'
      || !Number.isInteger(event.repairDurationMinutes) || event.repairDurationMinutes <= 0)) return invalid('故障设备或维修时长缺失')
  for (const key of ['cMaxMinutes', 'weightedTardinessMinutes', 'nTardy', 'loadImbalance']) {
    if (typeof plan.kpi[key] !== 'number' || !Number.isFinite(plan.kpi[key]) || plan.kpi[key] < 0) return invalid(`KPI.${key} 缺失或非法`)
  }
  for (const field of ['hardLockedCount', 'softLockedCount', 'impactedOperationCount', 'impactedOrderCount', 'freezeWindowMinutes']) {
    if (!Number.isInteger(preview[field]) || preview[field] < 0) return invalid(`${field} 不是非负整数`)
  }
  if (preview.freezeWindowMinutes > 1440 || (freezeWindowMinutes !== undefined && preview.freezeWindowMinutes !== freezeWindowMinutes)) {
    return invalid('冻结窗口与请求不一致')
  }
  for (const mode of ['LOCAL_RESCHEDULE', 'FULL_RESCHEDULE']) {
    const count = preview.modeEstimates?.[mode]?.estimatedOperationCount
    if (!Number.isInteger(count) || count < 0) return invalid(`${mode} 缺少求解规模估算`)
  }
  if (!preview.impactSummary || typeof preview.impactSummary.byType !== 'object'
      || preview.impactSummary.byType === null || Array.isArray(preview.impactSummary.byType)
      || preview.impactSummary.total !== preview.impactedOperationCount
      || !Object.values(preview.impactSummary.byType).every((n) => Number.isInteger(n) && n >= 0)
      || orders.some((o) => !o || typeof o.orderId !== 'string')) return invalid('缺少影响分类或订单ID')
  const impactedIds = [...new Set(preview.impactedOrders)].sort()
  if (impactedIds.length !== preview.impactedOrderCount) return invalid('受影响订单数量不一致')
  const byId = new Map(orders.map((order) => [order.orderId, order]))
  const affectedOrders = []
  for (const id of impactedIds) {
    const order = byId.get(id)
    const due = Date.parse(order?.dueAt)
    if (!order || !timestamp(order.dueAt) || !Number.isInteger(order.priority) || order.priority < 1 || order.priority > 5) {
      return invalid(`订单 ${id} 缺少有效交期或优先级`)
    }
    affectedOrders.push({
      orderId: id, orderCode: order.orderCode, status: order.status,
      dueAt: order.dueAt, priority: order.priority,
      minutesToDueAtEvent: (due - at) / 60000,
    })
  }
  return {
    ok: true,
    context: {
      schemaVersion: 1,
      readAt: new Date().toISOString(),
      event: {
        eventId: event.eventId, eventCode: event.eventCode, eventType: event.eventType,
        status: event.status, occurredAt: event.occurredAt, machineId: event.machineId,
        orderId: event.orderId, repairDurationMinutes: event.repairDurationMinutes,
        repairEndAt: event.repairEndAt, source: event.source, note: event.note,
      },
      baselinePlan: { id: plan.id, versionCode: plan.versionCode, status: plan.status, kpi: plan.kpi },
      constraints: {
        freezeWindowMinutes: preview.freezeWindowMinutes,
        freezeStartsAt: event.occurredAt,
        hardLockedCount: preview.hardLockedCount, softLockedCount: preview.softLockedCount,
        impactedOperationCount: preview.impactedOperationCount,
        impactedOrderCount: preview.impactedOrderCount,
        impactedOrders: impactedIds,
        impactSummary: preview.impactSummary,
        modeEstimates: preview.modeEstimates,
        registeredImpacts: event.impacts,
      },
      affectedOrders,
      deadlinePressure: {
        referenceAt: event.occurredAt,
        definition: 'dueAt - event.occurredAt（分钟）；不是计划拖期预测。priority=5 最高，24小时仅为展示阈值。',
        pastDueOrderCount: affectedOrders.filter((o) => o.minutesToDueAtEvent < 0).length,
        dueWithin24HoursCount: affectedOrders.filter((o) => o.minutesToDueAtEvent >= 0 && o.minutesToDueAtEvent <= 1440).length,
        highPriorityOrderCount: affectedOrders.filter((o) => o.priority >= 4).length,
        minMinutesToDueAtEvent: affectedOrders.length ? Math.min(...affectedOrders.map((o) => o.minutesToDueAtEvent)) : null,
      },
      provenance: { event: eventPath, constraints: previewPath, baselinePlan: dashboardPath, affectedOrders: '/orders' },
      limitations: [
        '影响预览为估算，不是实际求解工序集合；硬锁、软锁和受影响工序数不能直接相加。',
        'registeredImpacts.lockType 是事件登记时快照；hardLockedCount/softLockedCount 是预览时重算的分类。',
        '预览将全部登记影响工序纳入影响集合，求解快照排除登记时 HARD_LOCKED 的影响项；分类与规模可能不同。',
        '求解还可能纳入其他 WAITING 订单；本上下文的 affectedOrders 仅表示当前事件涉及的订单。',
        '多个只读请求不是事务快照；创建任务及发布时仍须重校验业务现态。KPI 是固定计划求解时指标。',
      ],
    },
  }
}
