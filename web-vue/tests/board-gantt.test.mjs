import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGanttStrip, ganttTicks } from '../src/utils/boardGantt.js';

const T = (h) => `2026-11-16T0${h}:00:00Z`;
const ops = [
  { operationId: 'ORD-A-10', orderCode: 'ORD-A', machineId: 'M-01', startAt: T(0), endAt: T(2) },
  { operationId: 'ORD-B-10', orderId: 'B', orderCode: 'ORD-B', machineId: 'M-02', startAt: T(2), endAt: T(4) },
  { operationId: 'ORD-A-20', orderCode: 'ORD-A', machineId: 'M-03', startAt: T(1), endAt: T(3) },
  { operationId: 'BAD', machineId: 'M-01', startAt: 'x', endAt: T(1) },
];

test('按设备分泳道，位置换算为窗口百分比，非法时间被丢弃', () => {
  const g = buildGanttStrip(ops, [{ machineId: 'M-02' }, { machineId: 'M-01' }], Date.parse(T(1)));
  assert.deepEqual(g.lanes.map(l => l.machineId), ['M-02', 'M-01', 'M-03']); // 列表外设备追加末尾
  const a = g.lanes[1].bars;
  assert.equal(a.length, 1);
  assert.equal(a[0].left, 0);
  assert.equal(a[0].width, 50);
  assert.equal(a[0].orderKey, 'ORD-A'); // 无 orderId 时从工序号推断
  assert.equal(g.lanes[0].bars[0].orderKey, 'B');
  assert.equal(g.nowPct, 25);
  assert.deepEqual(g.orders, ['ORD-A', 'B']);
});

test('当前时刻不在窗口内时不画现在线；无工序返回空结构', () => {
  assert.equal(buildGanttStrip(ops, [], Date.parse('2026-11-17T00:00:00Z')).nowPct, null);
  const e = buildGanttStrip([], []);
  assert.deepEqual(e.lanes, []);
  assert.deepEqual(ganttTicks(e.start, e.end), []);
  assert.equal(ganttTicks(0, 600, 3).map(t => t.ms).join(','), '0,200,400,600');
});
