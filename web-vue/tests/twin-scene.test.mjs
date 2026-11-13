import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createWorkshop, updateDevices, disposeWorkshop } from '../src/components/twinScene.js';

test('设备按真实坐标进入车间，状态更新不重复创建模型，移除后释放模型', () => {
  const workshop = createWorkshop({ blue: '#409eff', ink: '#303133', bg: '#f5f7fa', line: '#e4e7ed', success: '#67c23a', warning: '#e6a23c', danger: '#f56c6c', muted: '#909399' });
  const machine = { id: 'cnc-m01', kind: 'machine', online: true, status: 'running', health: { level: 'ok' }, position: { x: 3, y: 7, yaw: 90 } };
  updateDevices(workshop, [machine], machine.id);
  const model = workshop.devices.get(machine.id);
  assert.ok(model instanceof THREE.Group);
  assert.deepEqual(model.position.toArray(), [3, 0, -7]);
  assert.equal(model.rotation.y, Math.PI / 2);
  assert.equal(model.userData.deviceId, machine.id);
  assert.equal(model.userData.selection.visible, true);
  const beacon = model.userData.beacon;
  assert.equal(beacon.material.color.getHexString(), '67c23a');
  updateDevices(workshop, [{ ...machine, status: 'down', health: { level: 'bad' } }], null);
  assert.equal(workshop.devices.get(machine.id), model);
  assert.equal(beacon.material.color.getHexString(), 'f56c6c');
  assert.equal(model.userData.selection.visible, false);
  let disposed = false;
  beacon.geometry.addEventListener('dispose', () => { disposed = true; });
  updateDevices(workshop, [], null);
  assert.equal(workshop.devices.size, 0);
  assert.equal(disposed, true);
  disposeWorkshop(workshop);
});

test('AGV 建模且忽略无效坐标，不把未知设备显示成机床', () => {
  const workshop = createWorkshop({ blue: '#409eff', ink: '#303133', bg: '#f5f7fa', line: '#e4e7ed', success: '#67c23a', warning: '#e6a23c', danger: '#f56c6c', muted: '#909399' });
  updateDevices(workshop, [
    { id: 'agv-01', kind: 'agv', online: true, position: { x: 8, y: 5, yaw: 0 } },
    { id: 'invalid', kind: 'machine', position: { x: NaN, y: 2 } },
    { id: 'other', kind: 'sensor', position: { x: 1, y: 1 } },
  ], null);
  assert.deepEqual([...workshop.devices.keys()], ['agv-01']);
  assert.deepEqual(workshop.devices.get('agv-01').position.toArray(), [8, 0, -5]);
  disposeWorkshop(workshop);
});

test('AGV 更新保留最近轨迹，重复快照不新增轨迹点', () => {
  const workshop = createWorkshop({ blue: '#409eff', ink: '#303133', bg: '#f5f7fa', line: '#e4e7ed', success: '#67c23a', warning: '#e6a23c', danger: '#f56c6c', muted: '#909399' });
  for (let x = 0; x < 15; x++) updateDevices(workshop, [{ id: 'agv', kind: 'agv', position: { x, y: 5 } }], null);
  updateDevices(workshop, [{ id: 'agv', kind: 'agv', position: { x: 14, y: 5 } }], null);
  const trail = workshop.devices.get('agv').userData.trail;
  assert.equal(trail.geometry.attributes.position.count, 12);
  assert.equal(trail.geometry.attributes.position.getX(0), 3);
  assert.equal(trail.geometry.attributes.position.getX(11), 14);
  assert.equal(trail.geometry.attributes.position.getZ(11), -5);
  disposeWorkshop(workshop);
});

test('车间使用混凝土材质，机床保留加工舱、观察窗和独立操作屏结构', () => {
  const workshop = createWorkshop({ blue: '#409eff', ink: '#303133', bg: '#f5f7fa', line: '#e4e7ed', success: '#67c23a', warning: '#e6a23c', danger: '#f56c6c', muted: '#909399' });
  assert.ok(workshop.root.userData.floor.material.map);
  updateDevices(workshop, [{ id: 'cnc-m01', kind: 'machine', online: true, position: { x: 3, y: 7 } }], null);
  const machine = workshop.devices.get('cnc-m01');
  assert.equal(machine.userData.parts.cabin.material.metalness > 0.2, true);
  assert.equal(machine.userData.parts.window.material.transparent, true);
  assert.equal(machine.userData.parts.panel.material.emissiveIntensity > 0, true);
  assert.ok(machine.userData.parts.vent instanceof THREE.Group);
  assert.ok(machine.userData.parts.guideRails instanceof THREE.Group);
  disposeWorkshop(workshop);
});

test('机床近景包含屏幕界面、设备铭牌和钣金紧固件', () => {
  const workshop = createWorkshop({ blue: '#409eff', ink: '#303133', bg: '#f5f7fa', line: '#e4e7ed', success: '#67c23a', warning: '#e6a23c', danger: '#f56c6c', muted: '#909399' });
  updateDevices(workshop, [{ id: 'cnc-m01', kind: 'machine', online: true, position: { x: 3, y: 7 } }], null);
  const { parts } = workshop.devices.get('cnc-m01').userData;
  assert.ok(parts.panel.material.map);
  assert.ok(parts.nameplate.material.map);
  assert.equal(parts.fasteners.children.length >= 8, true);
  assert.equal(parts.hinges.children.length, 3);
  disposeWorkshop(workshop);
});
