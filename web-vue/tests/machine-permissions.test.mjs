import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@vue/compiler-sfc';

test('设备行写操作仅对管理员渲染', () => {
  const source = readFileSync(new URL('../src/views/MachinesView.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(source);
  const actions = [];
  function visit(node) {
    if (node.tag === 'button' && node.props.some(p => p.type === 6 && p.name === 'class' && p.value?.content.includes('table-action'))) actions.push(node);
    for (const child of node.children || []) visit(child);
  }
  visit(descriptor.template.ast);
  assert.equal(actions.length, 3);
  for (const action of actions) {
    const role = action.props.find(p => p.type === 7 && p.name === 'role');
    assert.ok(role, '设备行写操作缺少角色限制');
    assert.equal(role.exp.content, "['ADMIN']");
  }
});
