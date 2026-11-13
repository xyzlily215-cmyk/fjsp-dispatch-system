import test from 'node:test';
import assert from 'node:assert/strict';
import { agentLayoutMode, expandedPanelWidth, initialAgentPanelOpen } from '../src/stores/agentPanel.ts';

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

test('展开为多会话工作台时一律浮层，宽度随视口收敛', () => {
  assert.equal(agentLayoutMode(1920, true, true), 'expanded');
  assert.equal(agentLayoutMode(1280, true, true), 'expanded');
  assert.equal(agentLayoutMode(1920, false, true), 'closed');
  assert.equal(expandedPanelWidth(1920), 1080);
  assert.equal(expandedPanelWidth(1280), 1080);
  assert.equal(expandedPanelWidth(900), 852);
  assert.equal(expandedPanelWidth(300), 320);
});
