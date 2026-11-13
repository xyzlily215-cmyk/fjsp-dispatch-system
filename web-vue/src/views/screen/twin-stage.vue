<template>
  <div ref="host" class="twin-stage">
    <div v-if="error" class="twin-stage__message" role="alert">
      <b>三维车间暂不可用</b>
      <p>{{ error }}</p>
      <button class="twin-stage__retry" @click="initialize">重新加载</button>
    </div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createDarkWorkshop, updateDarkDevices, animateDarkWorkshop, disposeDarkWorkshop } from './twinSceneDark';

const props = defineProps({
  devices: { type: Array, default: () => [] },
  metrics: { type: Object, default: () => ({}) },
});
const host = ref(null);
const error = ref('');
let renderer, labels, scene, camera, controls, composer, workshop, observer;
let callouts = [];

/* 相机视角预设：页签切换时平滑飞过去 */
const SCENE_PRESETS = {
  overview: { pos: [21, 12, 14], target: [9, 1, -3], rotate: false },
  zoneA: { pos: [8, 9, 14], target: [8, 1.1, -2.7], rotate: false },
  zoneB: { pos: [8, 9, -24], target: [8, 1.1, -7.3], rotate: false },
  aisle: { pos: [23, 9, 6], target: [5.5, 0.5, -5], rotate: false },
};
let flight = null;

function focusScene(key) {
  const preset = SCENE_PRESETS[key];
  if (!preset || !camera || !controls) return;
  flight = {
    pos: new THREE.Vector3(...preset.pos),
    target: new THREE.Vector3(...preset.target),
    rotate: preset.rotate,
  };
  controls.autoRotate = false;
  const shell = workshop?.root.getObjectByName('hall-shell');
  if (shell) shell.visible = key === 'overview';
  const surroundings = workshop?.root.getObjectByName('campus-context');
  if (surroundings) surroundings.visible = key === 'overview';
}

defineExpose({ focusScene });

function esc(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/* 悬浮数据卡片：底部光点锚定场景点位（center 设到底边中点），引线连接卡片 */
function makeCallout({ title, rows, danger = false }) {
  const el = document.createElement('div');
  el.className = 'twin-callout' + (danger ? ' is-danger' : '');
  const rowsHtml = rows.map(([k, v]) => `<div class="tc-row"><span>${esc(k)}</span><em>${esc(v)}</em></div>`).join('');
  el.innerHTML = `<div class="tc-card"><b>${esc(title)}</b>${rowsHtml}</div><i class="tc-stem"></i><i class="tc-dot"></i>`;
  const obj = new CSS2DObject(el);
  obj.center.set(0.5, 1);
  return obj;
}

function clearCallouts() {
  for (const c of callouts) { c.removeFromParent(); c.element.remove(); }
  callouts = [];
}

function syncCallouts() {
  if (!workshop) return;
  clearCallouts();
  const machines = props.devices.filter(d => d.kind === 'machine');
  const running = machines.filter(d => d.online && d.status === 'run').length;
  const list = [
    {
      title: '主厂房 · 加工区',
      rows: [['运行设备', `${running}/${machines.length || 8}`], ['综合利用率', `${props.metrics.utilization ?? '—'}%`]],
      pos: [12, 4.3, -9.2],
    },
    {
      title: '缓存区',
      rows: [['在制物料', '126 件'], ['今日出库', '42 批']],
      pos: [18.4, 3.2, -6.8],
    },
    {
      title: '空压站',
      rows: [['运行状态', '正常'], ['管网压力', '0.62 MPa']],
      pos: [-4.6, 2.0, -8.0],
    },
  ];
  for (const d of machines.filter(m => m.status === 'down' || !m.online).slice(0, 2)) {
    list.push({
      title: `${d.name || d.id} · 故障`,
      rows: [['主轴温度报警', ''], ['已自动触发重调度', '']],
      pos: [d.position.x, 3.5, -d.position.y],
      danger: true,
    });
  }
  for (const item of list) {
    const obj = makeCallout(item);
    obj.position.set(...item.pos);
    workshop.root.add(obj);
    callouts.push(obj);
  }
  // AGV 卡片挂在运动模型上随车移动
  const agv = props.devices.find(d => d.kind === 'agv');
  const agvModel = agv && workshop.devices.get(agv.id);
  if (agvModel) {
    const obj = makeCallout({ title: 'AGV-01', rows: [['状态', '物料配送中']] });
    obj.position.set(0, 1.5, 0);
    agvModel.add(obj);
    callouts.push(obj);
  }
}

function sync() {
  if (!workshop) return;
  updateDarkDevices(workshop, props.devices);
  syncCallouts();
}

function cleanup() {
  observer?.disconnect();
  renderer?.setAnimationLoop(null);
  controls?.dispose();
  clearCallouts();
  if (workshop) disposeDarkWorkshop(workshop);
  scene?.environment?.dispose();
  for (const pass of composer?.passes || []) pass.dispose?.();
  composer?.dispose();
  renderer?.dispose();
  host.value?.querySelectorAll('canvas, .twin-labels')?.forEach(el => el.remove());
  workshop = null;
  renderer = null;
  composer = null;
  flight = null;
}

function initialize() {
  cleanup();
  error.value = '';
  try {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xb9c9cf);
    scene.fog = new THREE.Fog(0xb9c9cf, 65, 150);
    camera = new THREE.PerspectiveCamera(38, 1, 0.5, 180);
    camera.position.set(...SCENE_PRESETS.overview.pos);
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.45;
    pmrem.dispose();
    host.value.append(renderer.domElement);

    labels = new CSS2DRenderer();
    labels.domElement.className = 'twin-labels';
    host.value.append(labels.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(...SCENE_PRESETS.overview.target);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 10;
    controls.maxDistance = 75;
    controls.maxPolarAngle = Math.PI / 2.2;
    controls.autoRotate = false;
    controls.autoRotateSpeed = 0.45;
    controls.update();

    /* 白昼自然光：半球天光 + 太阳平行光（投影） + 反向补光 */
    scene.add(new THREE.HemisphereLight(0xdbe9f2, 0x706c55, 0.85));
    const sun = new THREE.DirectionalLight(0xfff0d4, 2.5);
    sun.position.set(-18, 32, 24);
    sun.target.position.set(9, 0, -3);
    scene.add(sun.target);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    Object.assign(sun.shadow.camera, { left: -38, right: 38, top: 38, bottom: -38 });
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 100;
    sun.shadow.bias = -0.00015;
    sun.shadow.normalBias = 0.025;
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xdfeaf5, 0.35);
    fill.position.set(-15, 12, -20);
    scene.add(fill);

    workshop = createDarkWorkshop();
    scene.add(workshop.root);
    sync();

    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    // 接触阴影把机床、管线和建筑落到地面，避免整体泛光冲淡材质。
    const occlusion = new GTAOPass(scene, camera, 960, 540, undefined, { radius: 0.65, thickness: 1, distanceFallOff: 0.7, scale: 1, samples: 8 });
    occlusion.blendIntensity = 0.8;
    composer.addPass(occlusion);
    composer.addPass(new OutputPass());

    observer = new ResizeObserver(() => {
      const { clientWidth: width, clientHeight: height } = host.value;
      if (!width || !height) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      composer.setSize(width, height);
      labels.setSize(width, height);
    });
    observer.observe(host.value);

    let lastRender = 0;
    renderer.setAnimationLoop((time) => {
      if (document.hidden) return;
      if (flight) {
        camera.position.lerp(flight.pos, 0.07);
        controls.target.lerp(flight.target, 0.07);
        if (camera.position.distanceTo(flight.pos) < 0.08) {
          controls.autoRotate = flight.rotate;
          flight = null;
        }
      }
      controls.update();
      if (time - lastRender < 33) return;
      lastRender = time;
      animateDarkWorkshop(workshop, time);
      composer.render();
      labels.render(scene, camera);
    });
  } catch {
    cleanup();
    error.value = '无法初始化 WebGL，请开启浏览器硬件加速后重试。';
  }
}

watch(() => props.devices, () => {
  try {
    sync();
  } catch (e) {
    error.value = `设备渲染异常：${(e && e.message) || e}`;
  }
});
watch(() => props.metrics, () => { if (workshop) syncCallouts(); });
onMounted(initialize);
onBeforeUnmount(cleanup);
</script>

<style scoped>
.twin-stage {
  width: 100%;
  height: 100%;
  min-height: 0;
  background: linear-gradient(180deg, #a9c2da 0%, #d4dfe7 42%, #b3c0ba 100%);
  overflow: hidden;
}

.twin-stage :deep(canvas) { display: block; }

.twin-stage :deep(.twin-labels) {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

/* 悬浮数据卡片：卡片 + 引线 + 锚点光斑 */
.twin-stage :deep(.twin-callout) {
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: none;
}

.twin-stage :deep(.tc-card) {
  min-width: 150px;
  padding: 8px 12px;
  background: linear-gradient(160deg, rgba(18, 74, 140, 0.88), rgba(10, 40, 92, 0.85));
  border: 1px solid rgba(64, 180, 255, 0.7);
  border-radius: 5px;
  box-shadow: 0 0 16px rgba(45, 140, 255, 0.35), inset 0 0 14px rgba(0, 180, 255, 0.12);
  font-size: 11px;
  color: #c6d9ec;
}

.twin-stage :deep(.tc-card b) {
  display: block;
  font-size: 12px;
  color: #aee2ff;
  margin-bottom: 5px;
  letter-spacing: 1px;
}

.twin-stage :deep(.tc-row) {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  line-height: 1.7;
  white-space: nowrap;
}

.twin-stage :deep(.tc-row span) { color: #8fb8e0; }

.twin-stage :deep(.tc-row em) {
  font-style: normal;
  color: #eaf7ff;
  font-variant-numeric: tabular-nums;
}

.twin-stage :deep(.twin-callout.is-danger .tc-card) {
  background: linear-gradient(160deg, rgba(122, 22, 32, 0.9), rgba(70, 12, 20, 0.88));
  border-color: rgba(255, 96, 110, 0.75);
  box-shadow: 0 0 16px rgba(255, 77, 94, 0.4), inset 0 0 14px rgba(255, 77, 94, 0.12);
}

.twin-stage :deep(.twin-callout.is-danger .tc-card b) { color: #ffb3ba; }

.twin-stage :deep(.twin-callout.is-danger .tc-row span) { color: #e89aa2; }

.twin-stage :deep(.tc-stem) {
  width: 1px;
  height: 34px;
  background: linear-gradient(180deg, rgba(64, 180, 255, 0.85), rgba(64, 180, 255, 0.2));
}

.twin-stage :deep(.twin-callout.is-danger .tc-stem) {
  background: linear-gradient(180deg, rgba(255, 77, 94, 0.7), rgba(255, 77, 94, 0.15));
}

.twin-stage :deep(.tc-dot) {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #40b4ff;
  box-shadow: 0 0 8px 2px rgba(64, 180, 255, 0.75);
}

.twin-stage :deep(.twin-callout.is-danger .tc-dot) {
  background: #ff4d5e;
  box-shadow: 0 0 8px 2px rgba(255, 77, 94, 0.7);
}

.twin-stage__message {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: #8fb8d8;
  font-size: 13px;
}

.twin-stage__retry {
  padding: 6px 18px;
  background: rgba(0, 229, 255, 0.12);
  border: 1px solid rgba(0, 229, 255, 0.5);
  border-radius: 4px;
  color: #00e5ff;
  cursor: pointer;
}
</style>
