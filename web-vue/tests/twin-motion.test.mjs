import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { advanceDeviceMotion, isDeviceRunning, syncDeviceMotion } from '../src/components/twinMotion.js';

const agv = (x, yaw = 0, extra = {}) => ({ kind: 'agv', online: true, status: 'running', position: { x, y: 5, yaw }, ...extra });
const near = (value, expected) => assert.ok(Math.abs(value - expected) < 1e-8, `${value} != ${expected}`);

test('AGV 首次上线使用真实位置，后续快照平滑到达目标且不越过目标', () => {
  const model = new THREE.Group();
  syncDeviceMotion(model, agv(2), 0);
  assert.deepEqual(model.position.toArray(), [2, 0, -5]);
  syncDeviceMotion(model, agv(4), 1000);
  near(model.position.x, 2);
  advanceDeviceMotion(model, 1500);
  near(model.position.x, 3);
  advanceDeviceMotion(model, 3000);
  near(model.position.x, 4);
});

test('重复设备快照或选择更新不重启动画，新目标从当前显示位置接续', () => {
  const model = new THREE.Group();
  syncDeviceMotion(model, agv(2), 0);
  syncDeviceMotion(model, agv(4), 1000);
  advanceDeviceMotion(model, 1400);
  const movement = model.userData.motion;
  syncDeviceMotion(model, agv(4), 1400);
  assert.equal(model.userData.motion, movement);
  syncDeviceMotion(model, agv(5), 1500);
  near(model.position.x, 3);
  advanceDeviceMotion(model, 1750);
  near(model.position.x, 4);
});

test('朝向跨过 0 度时取最短转角，减少动态效果时直接显示最新坐标', () => {
  const model = new THREE.Group();
  syncDeviceMotion(model, agv(2, 350), 0);
  syncDeviceMotion(model, agv(3, 10), 1000);
  advanceDeviceMotion(model, 1500);
  near(model.rotation.y, Math.PI * 2);
  advanceDeviceMotion(model, 1600, true);
  near(model.position.x, 3);
  near(Math.sin(model.rotation.y), Math.sin(Math.PI / 18));
});

test('故障、离线、待机立即停止插值，大幅坐标修正直接同步，不穿越车间', () => {
  for (const state of [{ status: 'down' }, { online: false }, { status: 'idle' }, { health: { level: 'bad' } }]) {
    const model = new THREE.Group();
    syncDeviceMotion(model, agv(2), 0);
    syncDeviceMotion(model, agv(4), 1000);
    syncDeviceMotion(model, agv(3, 0, state), 1200);
    advanceDeviceMotion(model, 5000);
    near(model.position.x, 3);
  }
  const model = new THREE.Group();
  syncDeviceMotion(model, agv(2), 0);
  syncDeviceMotion(model, agv(18), 1000);
  near(model.position.x, 18);
});

test('加工动作只匹配显式运行态，兼容演示 run 与设备 running', () => {
  assert.equal(isDeviceRunning({ status: 'run', online: true }), true);
  assert.equal(isDeviceRunning({ status: 'running', online: true }), true);
  for (const state of [
    { status: 'idle' }, { status: 'down' }, { status: 'maintain' }, {},
    { status: 'running', online: false }, { status: 'run', health: { level: 'bad' } },
  ]) assert.equal(isDeviceRunning(state), false);
});
