import test from 'node:test';
import assert from 'node:assert/strict';
import { agentLayoutMode, initialAgentPanelOpen } from '../src/stores/agentPanel.ts';

test('AI 面板仅在宽屏且展开时停靠，窄屏使用抽屉', () => {
  assert.equal(agentLayoutMode(1440, true), 'docked');
  assert.equal(agentLayoutMode(1920, true), 'docked');
  assert.equal(agentLayoutMode(1439, true), 'drawer');
  assert.equal(agentLayoutMode(768, true), 'drawer');
  assert.equal(agentLayoutMode(1440, false), 'closed');
  assert.equal(agentLayoutMode(1280, false), 'closed');
});

test('首次打开按屏幕宽度决定，已保存的用户选择优先', () => {
  assert.equal(initialAgentPanelOpen(1440, null), true);
  assert.equal(initialAgentPanelOpen(1280, null), false);
  assert.equal(initialAgentPanelOpen(1440, '0'), false);
  assert.equal(initialAgentPanelOpen(1280, '1'), true);
});
