<template>
  <div ref="host" class="twin-stage" @pointerdown="rememberPointer" @pointerup="pick">
    <div v-if="!error" class="stage-tools" role="group" aria-label="三维车间视角" @pointerdown.stop @pointerup.stop>
      <button type="button" :disabled="!ready" @click="focusScene('campus')">厂区外景</button>
      <button type="button" :disabled="!ready" @click="focusScene('overview')">车间总览</button>
      <button type="button" :disabled="!ready || !devices.length" @click="focusDevice()">设备近景</button>
      <button type="button" :disabled="!ready" @click="focusScene('top')">俯视</button>
      <button type="button" :disabled="!ready || reducedMotion" :aria-pressed="touring" @click="toggleTour">{{ touring ? '停止巡检' : '自动巡检' }}</button>
    </div>
    <div v-if="touring" class="stage-tour" role="status">正在巡检 · {{ viewLabel }}<span>拖动场景可退出</span></div>
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
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { createDarkWorkshop, updateDarkDevices, animateDarkWorkshop, disposeDarkWorkshop } from './twinSceneDark';

const props = defineProps({
  devices: { type: Array, default: () => [] },
  metrics: { type: Object, default: () => ({}) },
  selectedId: { type: String, default: null },
  zones: { type: Array, default: () => [] },
  initialView: { type: String, default: 'overview' },
  /* 悬浮故障与 AGV 标签：大屏开启；加工中心以 labels 名牌识别设备。 */
  callouts: { type: Boolean, default: true },
  /* 设备名牌与区域标签：加工中心页需要与设备卡片联动点名，大屏用悬浮卡片已足够 */
  labels: { type: Boolean, default: false },
});
const emit = defineEmits(['select', 'view-change']);
const host = ref(null);
const error = ref('');
const ready = ref(false);
const touring = ref(false);
const reducedMotion = ref(false);
const viewLabel = ref('车间总览');
let renderer, labels, scene, camera, controls, composer, workshop, observer;
let motionPreference;
let nextTourAt = 0;
let tourIndex = 0;
let lastFrameTime = 0;
let callouts = [];
let showCallouts = true;
const labelMap = new Map();
let downPos = null;

/* 相机视角预设：页签切换时平滑飞过去 */
const SCENE_PRESETS = {
  overview: { pos: [20, 8.5, 13], target: [9.5, 1, -4.5], label: '车间总览' },
  zoneA: { pos: [14, 6.8, 5], target: [8, 1.1, -2.7], label: '加工区 A' },
  zoneB: { pos: [17, 9, -2], target: [8, 1.1, -7.3], label: '加工区 B' },
  aisle: { pos: [21, 4.8, -0.5], target: [7, 0.6, -5], label: '物流通道' },
  top: { pos: [10, 30, -4.99], target: [10, 0, -5], rotate: false },
  campus: { pos: [29.4, 23.8, 20.9], target: [10, 0, -2], label: '厂区外景' },
};
const TOUR_VIEWS = ['overview', 'zoneA', 'aisle', 'zoneB'];
let flight = null;

function setShellVisible(campus, top = false) {
  const roof = workshop?.root.getObjectByName('hall-roof');
  if (roof) roof.visible = !top;
  const surroundings = workshop?.root.getObjectByName('campus-context');
  if (surroundings) surroundings.visible = campus;
  const ground = workshop?.root.getObjectByName('workshop-ground');
  if (ground) ground.visible = !campus;
}

function stopTour() {
  touring.value = false;
}

function focusScene(key, automatic = false) {
  const preset = SCENE_PRESETS[key];
  if (!preset || !camera || !controls) return;
  if (!automatic) stopTour();
  emit('view-change', key);
  showCallouts = key === 'overview';
  for (const callout of callouts) callout.visible = showCallouts;
  viewLabel.value = preset.label || '俯视车间';
  flight = {
    pos: new THREE.Vector3(...preset.pos),
    target: new THREE.Vector3(...preset.target),
    rotate: false,
  };
  if (reducedMotion.value) {
    camera.position.copy(flight.pos);
    controls.target.copy(flight.target);
    flight = null;
  }
  controls.autoRotate = false;
  setShellVisible(key === 'campus', key === 'top' || key === 'zoneA' || key === 'zoneB');
}

function toggleTour() {
  if (touring.value) return stopTour();
  if (reducedMotion.value) return;
  touring.value = true;
  tourIndex = 0;
  focusScene(TOUR_VIEWS[0], true);
  nextTourAt = performance.now() + 6500;
}

/* 设备近景：优先选中设备，否则第一台在线机床（加工中心页「设备近景」按钮） */
function focusDevice(id) {
  if (!camera || !controls) return;
  const device = props.devices.find(d => d.id === (id ?? props.selectedId) && d.position)
    || props.devices.find(d => d.kind === 'machine' && d.online && d.position)
    || props.devices.find(d => d.kind === 'machine' && d.position);
  if (!device) return;
  stopTour();
  emit('view-change', 'device');
  showCallouts = false;
  for (const callout of callouts) callout.visible = false;
  const { x, y } = device.position;
  const yaw = (device.position.yaw || 0) * Math.PI / 180;
  const offset = new THREE.Vector3(3.3, 0, 4.3).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  flight = {
    pos: new THREE.Vector3(x + offset.x, 2.9, -y + offset.z),
    target: new THREE.Vector3(x, 1.35, -y),
    rotate: false,
  };
  controls.autoRotate = false;
  if (reducedMotion.value) {
    camera.position.copy(flight.pos);
    controls.target.copy(flight.target);
    flight = null;
  }
  setShellVisible(false, true);
}

defineExpose({ focusScene, focusDevice });

/* 点击拾取：加工中心页点选机床联动详情卡片；大屏未监听 select，行为不变 */
function rememberPointer(event) {
  downPos = [event.clientX, event.clientY];
}
function pick(event) {
  if (!renderer || !workshop || !downPos || Math.hypot(event.clientX - downPos[0], event.clientY - downPos[1]) > 5) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  ), camera);
  const hits = ray.intersectObjects([...workshop.devices.values()], true);
  let object = hits[0]?.object;
  while (object && !object.userData.deviceId) object = object.parent;
  const device = props.devices.find(d => d.id === object?.userData.deviceId);
  if (device?.kind === 'machine') emit('select', device);
}

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
  if (!props.callouts) return;
  const machines = props.devices.filter(d => d.kind === 'machine');
  const list = [];
  // 故障卡片由设备状态驱动（无坐标的设备无法锚定，跳过）
  for (const d of machines.filter(m => (m.status === 'down' || m.health?.level === 'bad') && m.online !== false && m.position).slice(0, 1)) {
    list.push({
      title: `${d.name || d.id} · 故障`,
      rows: [],
      pos: [d.position.x, 3.3, -d.position.y],
      danger: true,
    });
  }
  for (const item of list) {
    const obj = makeCallout(item);
    obj.visible = showCallouts;
    obj.position.set(...item.pos);
    workshop.root.add(obj);
    callouts.push(obj);
  }
  // AGV 卡片挂在运动模型上随车移动
  const agv = props.devices.find(d => d.kind === 'agv');
  const agvModel = agv && workshop.devices.get(agv.id);
  if (agvModel) {
    const agvStatus = !agv.online ? '离线'
      : ({ run: '物料配送中', running: '物料配送中', idle: '待机', down: '故障' }[agv.status] || '—');
    const obj = makeCallout({ title: `${(agv.name || agv.id).toUpperCase()} · ${agvStatus}`, rows: [] });
    obj.visible = showCallouts;
    obj.position.set(0, 1.1, 0);
    agvModel.add(obj);
    callouts.push(obj);
  }
}

/* 设备名牌 + 区域标签（labels 开启时，加工中心页用）：名牌底色跟随设备状态 */
function syncLabels() {
  for (const label of labelMap.values()) { label.removeFromParent(); label.element.remove(); }
  labelMap.clear();
  if (!workshop || !props.labels) return;
  for (const [id, model] of workshop.devices) {
    const device = props.devices.find(d => d.id === id);
    if (!device) continue;
    const element = document.createElement('span');
    element.className = 'twin-namelabel';
    element.textContent = id.startsWith('cnc-m') ? 'M-' + id.slice(5).toUpperCase() : id.toUpperCase();
    element.dataset.state = !device.online ? 'offline'
      : device.health?.level === 'bad' || device.status === 'down' ? 'bad' : 'ok';
    if (props.selectedId === id) element.dataset.selected = '1';
    const label = new CSS2DObject(element);
    label.position.set(0, device.kind === 'agv' ? 0.95 : 3.1, 0);
    model.add(label);
    labelMap.set(id, label);
  }
  for (const zone of props.zones) {
    const points = zone.points || [];
    if (!points.length) continue;
    const element = document.createElement('span');
    element.className = 'twin-zonelabel';
    element.textContent = zone.name || zone.id;
    const label = new CSS2DObject(element);
    label.position.set(points.reduce((s, p) => s + p[0], 0) / points.length, 0.08, -0.7);
    workshop.root.add(label);
    labelMap.set('zone-' + zone.id, label);
  }
}

function sync() {
  if (!workshop) return;
  updateDarkDevices(workshop, props.devices, props.selectedId);
  syncCallouts();
  syncLabels();
}

function cleanup() {
  ready.value = false;
  stopTour();
  observer?.disconnect();
  renderer?.setAnimationLoop(null);
  controls?.dispose();
  clearCallouts();
  for (const label of labelMap.values()) { label.removeFromParent(); label.element.remove(); }
  labelMap.clear();
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
  lastFrameTime = 0;
}

function initialize() {
  cleanup();
  error.value = '';
  const initialKey = Object.hasOwn(SCENE_PRESETS, props.initialView) ? props.initialView : 'overview';
  const initialPreset = SCENE_PRESETS[initialKey];
  showCallouts = initialKey === 'overview';
  viewLabel.value = initialPreset.label || '俯视车间';
  try {
    scene = new THREE.Scene();
    scene.background = new THREE.Color('#2c414f');
    scene.fog = new THREE.Fog('#2c414f', 28, 110);
    camera = new THREE.PerspectiveCamera(38, 1, 0.5, 180);
    camera.position.set(...initialPreset.pos);
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.85;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.35;
    pmrem.dispose();
    host.value.append(renderer.domElement);

    labels = new CSS2DRenderer();
    labels.domElement.className = 'twin-labels';
    host.value.append(labels.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(...initialPreset.target);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 3.5;
    controls.maxDistance = 75;
    controls.maxPolarAngle = Math.PI / 2.2;
    controls.autoRotate = false;
    controls.autoRotateSpeed = 0.45;
    controls.addEventListener('start', () => { stopTour(); flight = null; emit('view-change', 'custom'); });
    controls.update();

    /* 冷色环境补光 + 暖色工作照明，保留设备轮廓与地坪接触阴影。 */
    scene.add(new THREE.HemisphereLight(0xc6dce7, 0x35403b, 0.65));
    const sun = new THREE.DirectionalLight(0xffe6bf, 1.6);
    sun.position.set(-18, 32, 24);
    sun.target.position.set(9, 0, -3);
    scene.add(sun.target);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -23, right: 23, top: 23, bottom: -23 });
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 100;
    sun.shadow.bias = -0.00015;
    sun.shadow.normalBias = 0.025;
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xc1e0ee, 0.5);
    fill.position.set(-15, 12, -20);
    scene.add(fill);

    workshop = createDarkWorkshop();
    scene.add(workshop.root);
    setShellVisible(initialKey === 'campus', ['top', 'zoneA', 'zoneB'].includes(initialKey));
    sync();

    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    // 接触阴影把机床、管线和建筑落到地面，避免整体泛光冲淡材质。
    const occlusion = new GTAOPass(scene, camera, 960, 540, undefined, { radius: 0.65, thickness: 1, distanceFallOff: 0.7, scale: 1, samples: 8 });
    occlusion.blendIntensity = 0.8;
    composer.addPass(occlusion);
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(960, 540), 0.09, 0.3, 1.5));
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
    ready.value = true;
    emit('view-change', initialKey);

    let lastRender = 0;
    renderer.setAnimationLoop((time) => {
      if (document.hidden && lastRender) return;
      const delta = Math.min(0.1, Math.max(0, (time - (lastFrameTime || time)) / 1000));
      lastFrameTime = time;
      if (touring.value && time >= nextTourAt) {
        tourIndex = (tourIndex + 1) % TOUR_VIEWS.length;
        focusScene(TOUR_VIEWS[tourIndex], true);
        nextTourAt = time + 6500;
      }
      if (flight) {
        const step = 1 - Math.exp(-delta * 4);
        camera.position.lerp(flight.pos, step);
        controls.target.lerp(flight.target, step);
        if (camera.position.distanceTo(flight.pos) < 0.08) {
          controls.autoRotate = flight.rotate;
          flight = null;
        }
      }
      controls.update();
      if (time - lastRender < 33) return;
      lastRender = time;
      animateDarkWorkshop(workshop, time, reducedMotion.value);
      composer.render();
      labels.render(scene, camera);
    });
  } catch {
    cleanup();
    error.value = '无法初始化 WebGL，请开启浏览器硬件加速后重试。';
  }
}

watch(() => [props.devices, props.selectedId, props.zones, props.labels], () => {
  try {
    sync();
  } catch (e) {
    error.value = `设备渲染异常：${(e && e.message) || e}`;
  }
});
watch(() => [props.metrics, props.callouts], () => { if (workshop) syncCallouts(); });
function syncMotionPreference() {
  reducedMotion.value = motionPreference.matches;
  if (reducedMotion.value) {
    stopTour();
    if (flight) {
      camera?.position.copy(flight.pos);
      controls?.target.copy(flight.target);
      flight = null;
    }
  }
}
onMounted(() => {
  motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  syncMotionPreference();
  motionPreference.addEventListener('change', syncMotionPreference);
  initialize();
});
onBeforeUnmount(() => {
  motionPreference?.removeEventListener('change', syncMotionPreference);
  cleanup();
});
</script>

<style scoped>
.twin-stage {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: #2c414f;
  overflow: hidden;
}

.twin-stage :deep(canvas) { display: block; }
.stage-tools { position: absolute; z-index: 3; top: 14px; right: 14px; display: flex; gap: 4px; padding: 4px; background: #182329; border: 1px solid #4b5b61; border-radius: 4px; }
.stage-tools button { padding: 7px 10px; border: 0; border-radius: 2px; background: transparent; color: #e3eae8; font: inherit; font-size: 12px; cursor: pointer; }
.stage-tools button:hover { background: #344248; }
.stage-tools button[aria-pressed=true] { background: #dcc075; color: #172126; }
.stage-tools button:disabled { opacity: 0.45; cursor: default; }
.stage-tools button:focus-visible { outline: 2px solid #e5c46c; outline-offset: 1px; }
.stage-tour { position: absolute; z-index: 2; left: 18px; bottom: 58px; padding: 9px 12px; background: #1b282f; color: #f0d48c; font-size: 12px; }
.stage-tour span { margin-left: 12px; color: #c1cfcd; }
@media (max-width: 600px) {
  .stage-tools { top: auto; bottom: 60px; right: 8px; left: 8px; justify-content: center; }
  .stage-tools button { padding: 8px; }
  .stage-tour { bottom: 110px; left: 8px; }
}

.twin-stage :deep(.twin-labels) {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

/* 设备名牌 / 区域标签（labels 模式，加工中心页） */
.twin-stage :deep(.twin-namelabel) {
  padding: 3px 7px;
  border-radius: 4px;
  background: #172237;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.twin-stage :deep(.twin-namelabel[data-state=bad]) { background: #e5484d; }
.twin-stage :deep(.twin-namelabel[data-state=offline]) { background: #5f7a99; }
.twin-stage :deep(.twin-namelabel[data-selected]) { outline: 2px solid #00b8d9; }

.twin-stage :deep(.twin-zonelabel) {
  color: #d5ded8;
  font-size: 12px;
  font-weight: 600;
  text-shadow: 0 1px 3px #111a20;
}

/* 悬浮数据卡片：卡片 + 引线 + 锚点光斑 */
.twin-stage :deep(.twin-callout) {
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: none;
}

.twin-stage :deep(.tc-card) {
  padding: 7px 10px;
  background: #1c2b32;
  border: 1px solid #617477;
  border-radius: 3px;
  font-size: 11px;
  color: #c6d9ec;
}

.twin-stage :deep(.tc-card b) {
  display: block;
  font-size: 12px;
  color: #edf2e9;
  margin: 0;
}

.twin-stage :deep(.tc-row) {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  line-height: 1.7;
  white-space: nowrap;
}

.twin-stage :deep(.tc-row span) { color: #b4c4c6; }

.twin-stage :deep(.tc-row em) {
  font-style: normal;
  color: #eaf7ff;
  font-variant-numeric: tabular-nums;
}

.twin-stage :deep(.twin-callout.is-danger .tc-card) {
  background: #4d2728;
  border-color: rgba(255, 96, 110, 0.75);
}

.twin-stage :deep(.twin-callout.is-danger .tc-card b) { color: #ffb3ba; }

.twin-stage :deep(.twin-callout.is-danger .tc-row span) { color: #e89aa2; }

.twin-stage :deep(.tc-stem) {
  width: 1px;
  height: 20px;
  background: #8eaaa9;
}

.twin-stage :deep(.twin-callout.is-danger .tc-stem) {
  background: #e58a83;
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
