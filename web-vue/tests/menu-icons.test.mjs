import test from 'node:test';
import assert from 'node:assert/strict';
import { iconPaths } from '../src/utils/menuIcons.js';

test('应用外壳使用的图标都有统一 SVG 路径', () => {
  const names = ['board', 'twin', 'database', 'schedule', 'warning', 'analysis', 'review', 'execution', 'users', 'dictionary', 'timeline', 'agent', 'refresh', 'plus', 'menu', 'back'];
  for (const name of names) {
    const paths = iconPaths(name);
    assert.ok(paths.length > 0, `${name} 缺少图标`);
    for (const path of paths) assert.match(path, /^M/);
  }
});

test('未注册图标使用默认方块且不回传可变内部数组', () => {
  const fallback = iconPaths('missing');
  assert.deepEqual(fallback, iconPaths('fallback'));
  fallback[0] = 'broken';
  assert.notEqual(iconPaths('fallback')[0], 'broken');
});
