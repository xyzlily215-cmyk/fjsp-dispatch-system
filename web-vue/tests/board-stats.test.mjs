import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBoardStats, orderProfile, urgencyLevel } from '../src/utils/boardStats.js';

const op = (id, cands) => ({ operationId: id, status: 'NOT_STARTED', candidates: cands.map(([machineId, s, p]) => ({ machineId, setupMinutes: s, processMinutes: p })) });
const machines = [
  { machineId: 'M-01', workCenterId: 'WC-车削', status: 'ACTIVE' },
  { machineId: 'M-02', workCenterId: 'WC-车削', status: 'DOWN' },
];
const orders = [
  { orderId: 'A', orderCode: 'ORD-A', productFamily: '轴类A', quantity: 10, priority: 5, status: 'WAITING',
    arrivalAt: '2026-10-30T00:00:00Z', dueAt: '2026-10-30T02:00:00Z',
    operations: [op('A-10', [['M-01', 10, 50], ['M-02', 5, 85]])] },
  { orderId: 'B', orderCode: 'ORD-B', productFamily: '盘类B', quantity: 4, priority: 1, status: 'COMPLETED',
    arrivalAt: '2026-10-30T00:00:00Z', dueAt: '2026-10-30T10:00:00Z',
    operations: [op('B-10', [['M-01', 0, 60]])] },
];

test('订单最短加工链取每道工序候选中 setup+process 最小值，紧迫度=加工链/交付窗口', () => {
  const p = orderProfile(orders[0]);
  assert.equal(p.minChainMinutes, 60);
  assert.equal(p.leadMinutes, 120);
  assert.equal(p.urgency, 0.5);
  assert.equal(urgencyLevel(p.urgency).key, 'critical');
  assert.equal(urgencyLevel(0.4).key, 'warning');
  assert.equal(urgencyLevel(null).key, 'good');
});

test('无排程也能出统计：已完成订单不计入在制负荷与风险', () => {
  const s = buildBoardStats(orders, machines);
  assert.equal(s.totals.orders, 2);
  assert.equal(s.totals.activeMachines, 1);
  assert.equal(s.totals.operations, 1, '已完成订单的工序不计入');
  assert.equal(s.totals.highRisk, 1);
  assert.deepEqual(s.riskOrders.map(r => r.orderId), ['A']);
  assert.deepEqual(s.byStatus, { WAITING: 1, SCHEDULED: 0, RUNNING: 0, COMPLETED: 1 });
  assert.equal(s.totals.horizonMinutes, 600);
  // A-10 平均工时 (60+90)/2=75，两台候选各均摊 37.5
  assert.deepEqual(s.machineLoad.map(m => [m.machineId, m.minutes]), [['M-01', 37.5], ['M-02', 37.5]]);
  assert.deepEqual(s.priorities.map(p => p.orders), [1, 0, 0, 0, 1]);
  assert.deepEqual(s.workCenters, [{ workCenterId: 'WC-车削', total: 2, active: 1 }]);
});

test('交期分桶按小时连续补齐空桶', () => {
  const s = buildBoardStats(orders, machines);
  assert.equal(s.dueBuckets.length, 9); // 02:00Z ~ 10:00Z 共 9 个小时桶
  assert.equal(s.dueBuckets.reduce((n, b) => n + b.orders, 0), 2);
});

test('空数据不报错', () => {
  const s = buildBoardStats([], []);
  assert.equal(s.totals.orders, 0);
  assert.equal(s.totals.theoreticalLoad, null);
  assert.deepEqual(s.dueBuckets, []);
});
