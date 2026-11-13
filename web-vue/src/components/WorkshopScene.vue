<template>
  <div class="workshop">
    <div class="scene-controls" role="group" aria-label="车间视角">
      <button type="button" class="btn small" @click="focusDevice">设备近景</button>
      <button type="button" class="btn small" @click="resetView(false)">立体视角</button>
      <button type="button" class="btn small" @click="resetView(true)">俯视车间</button>
    </div>
    <div ref="host" class="scene-canvas" @pointerdown="rememberPointer" @pointerup="pick" />
    <div v-if="error" class="scene-message" role="alert"><b>三维车间暂不可用</b><p>{{ error }}</p><button class="btn" @click="initialize">重新加载</button></div>
    <div v-else-if="!devices.length" class="scene-empty">等待设备上线 · 模型将按实时坐标显示</div>
    <div class="scene-footer"><span>拖动旋转 · 滚轮缩放 · 点击设备查看详情</span><span>20 × 10 m · 程序化模型</span></div>
    <div class="device-access" aria-label="车间设备选择">
      <button v-for="d in devices.filter(d => d.kind === 'machine')" :key="d.id" type="button" :aria-pressed="selectedId === d.id" @click="$emit('select', d)">{{ d.name || d.id }}</button>
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
import { createWorkshop, updateDevices, disposeWorkshop } from './twinScene';

const props = defineProps({ devices: { type: Array, default: () => [] }, selectedId: { type: String, default: null }, zones: { type: Array, default: () => [] } });
const emit = defineEmits(['select']);
const host = ref(null);
const error = ref('');
let renderer, labels, scene, camera, controls, workshop, observer, composer;
let down = null;
const labelMap = new Map();

function resetView(top) {
  if (!camera) return;
  camera.position.set(top ? 10 : 26, top ? 28 : 11, top ? -4.99 : 17);
  controls.target.set(10, top ? 0 : 1.1, -5);
  controls.update();
}
function focusDevice() {
  if (!camera) return;
  const device = props.devices.find(d => d.id === props.selectedId && d.kind === 'machine')
    || props.devices.find(d => d.kind === 'machine' && d.online) || props.devices.find(d => d.kind === 'machine');
  if (!device?.position) return;
  const { x, y } = device.position;
  camera.position.set(x + 3.3, 2.9, -y + 4.3);
  controls.target.set(x, 1.35, -y);
  controls.update();
}
function rememberPointer(event) { down = [event.clientX, event.clientY]; }
function pick(event) {
  if (!renderer || !down || Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 5) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
  const hits = ray.intersectObjects([...workshop.devices.values()], true);
  let object = hits[0]?.object;
  while (object && !object.userData.deviceId) object = object.parent;
  const device = props.devices.find(d => d.id === object?.userData.deviceId);
  if (device?.kind === 'machine') emit('select', device);
}
function sync() {
  if (!workshop) return;
  updateDevices(workshop, props.devices, props.selectedId);
  for (const label of labelMap.values()) { label.removeFromParent(); label.element.remove(); }
  labelMap.clear();
  for (const [id, model] of workshop.devices) {
    const device = props.devices.find(d => d.id === id);
    const element = document.createElement('span');
    element.className = 'workshop-label';
    element.textContent = id.startsWith('cnc-m') ? 'M-' + id.slice(5).toUpperCase() : id.toUpperCase();
    element.dataset.state = !device.online ? 'offline' : device.health?.level === 'bad' || device.status === 'down' ? 'bad' : 'ok';
    const label = new CSS2DObject(element);
    label.position.set(0, device.kind === 'agv' ? 0.95 : 3.02, 0);
    model.add(label);
    labelMap.set(id, label);
  }
  for (const zone of props.zones) {
    const points = zone.points || [];
    if (!points.length) continue;
    const element = document.createElement('span');
    element.className = 'workshop-zone';
    element.textContent = zone.name || zone.id;
    const label = new CSS2DObject(element);
    label.position.set(points.reduce((s, p) => s + p[0], 0) / points.length, 0.08, -0.7);
    workshop.root.add(label);
    labelMap.set('zone-' + zone.id, label);
  }
}
function cleanup() {
  observer?.disconnect();
  renderer?.setAnimationLoop(null);
  controls?.dispose();
  if (workshop) disposeWorkshop(workshop);
  scene?.environment?.dispose();
  for (const label of labelMap.values()) label.element.remove();
  labelMap.clear();
  for (const pass of composer?.passes || []) pass.dispose?.();
  composer?.dispose();
  renderer?.dispose();
  host.value?.replaceChildren();
  workshop = null;
  renderer = null;
  composer = null;
}
function initialize() {
  cleanup();
  error.value = '';
  try {
    const style = getComputedStyle(host.value);
    const colors = Object.fromEntries(['blue', 'ink', 'bg', 'line', 'success', 'warning', 'danger', 'muted'].map(key => [key, style.getPropertyValue('--' + key).trim()]));
    scene = new THREE.Scene();
    scene.background = new THREE.Color(colors.bg);
    camera = new THREE.PerspectiveCamera(40, 1, 0.1, 150);
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.92;
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.65;
    pmrem.dispose();
    renderer.domElement.setAttribute('aria-label', '实时三维车间，设备也可通过下方卡片选择');
    host.value.append(renderer.domElement);
    labels = new CSS2DRenderer();
    labels.domElement.className = 'scene-labels';
    host.value.append(labels.domElement);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.minDistance = 3.5;
    controls.maxDistance = 45;
    controls.maxPolarAngle = Math.PI / 2.12;
    resetView(false);
    scene.add(new THREE.HemisphereLight(0xffffff, colors.muted, 0.9));
    const light = new THREE.DirectionalLight(0xffffff, 2.2);
    light.position.set(4, 12, 7);
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    Object.assign(light.shadow.camera, { left: -25, right: 25, top: 25, bottom: -25 });
    light.shadow.bias = -0.001;
    scene.add(light);
    workshop = createWorkshop(colors);
    scene.add(workshop.root);
    sync();
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const ao = new GTAOPass(scene, camera, 512, 512, undefined, { radius: 0.45, thickness: 0.8, distanceFallOff: 0.6, scale: 1, samples: 8 });
    ao.blendIntensity = 0.75;
    composer.addPass(ao);
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
      controls.update();
      if (time - lastRender < 33) return;
      lastRender = time;
      composer.render();
      labels.render(scene, camera);
    });
  } catch {
    cleanup();
    error.value = '无法初始化 WebGL，请开启浏览器硬件加速后重试。设备状态与下方卡片仍可使用。';
  }
}
watch(() => [props.devices, props.selectedId, props.zones], sync);
onMounted(initialize);
onBeforeUnmount(cleanup);
</script>

<style scoped>
.workshop { position:relative; background:var(--bg); overflow:hidden; }
.scene-canvas { position:relative; width:100%; height:clamp(380px, 44vw, 570px); cursor:grab; }
.scene-canvas:active { cursor:grabbing; }
.scene-canvas :deep(canvas) { display:block; }
.scene-canvas :deep(.scene-labels) { position:absolute; inset:0; pointer-events:none; }
.scene-canvas :deep(.workshop-label) { padding:3px 7px; border-radius:4px; background:var(--ink); color:var(--el-color-white); font-size:11px; font-weight:600; white-space:nowrap; }
.scene-canvas :deep(.workshop-label[data-state=bad]) { background:var(--danger); }
.scene-canvas :deep(.workshop-label[data-state=offline]) { background:var(--muted); }
.scene-canvas :deep(.workshop-zone) { color:var(--ink); font-size:12px; font-weight:600; }
.scene-controls { position:absolute; z-index:2; top:14px; right:14px; display:flex; gap:6px; }
.scene-footer { display:flex; justify-content:space-between; gap:12px; padding:11px 16px; border-top:1px solid var(--line); color:var(--ink); font-size:11px; }
.scene-message { position:absolute; inset:80px 20px; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; background:var(--bg); color:var(--ink); }
.scene-message p { max-width:42ch; }
.scene-empty { position:absolute; bottom:60px; left:0; right:0; text-align:center; color:var(--ink); font-size:12px; pointer-events:none; }
.device-access { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
.device-access:focus-within { width:auto; height:auto; clip-path:none; bottom:45px; left:10px; z-index:3; }
button:focus-visible { outline:2px solid var(--blue); outline-offset:3px; }
</style>
