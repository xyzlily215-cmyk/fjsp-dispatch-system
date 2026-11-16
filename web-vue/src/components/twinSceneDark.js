/* 工业车间：支持剖切生产现场与园区外景，由调用页选择初始视角。
 * 设备坐标与状态来自调用页，动画只表现已经收到的运行状态。 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createPanelTexture } from './twinTextures.js';
import { advanceDeviceMotion, isDeviceRunning, syncDeviceMotion } from './twinMotion.js';
import concreteUrl from '../assets/screen/concrete-diffuse.jpg';
import grassUrl from '../assets/screen/grass-diffuse.jpg';

const TONE = {
  body: '#63716f',
  bodyLight: '#a2aaa5',
  edge: '#798682',
  dark: '#1c2529',
  steel: '#a9bac6',
  cyan: '#00B8D9',
  blue: '#2D8CFF',
  green: '#22B07D',
  amber: '#E89C1A',
  red: '#E5484D',
  muted: '#5F7A99',
};

function paint(color, metalness = 0.2, roughness = 0.6) {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness });
}

// 有固定种子的表面纹理：缩放到米制尺寸，避免每块建筑像纯色积木。
function surfaceTexture(kind, repeatX = 1, repeatY = 1) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const base = { asphalt: [73, 76, 75], concrete: [182, 179, 167], roof: [139, 151, 152], wall: [210, 211, 202] }[kind];
  const pixels = ctx.createImageData(256, 256);
  let seed = 41;
  for (let i = 0; i < pixels.data.length; i += 4) {
    seed = seed * 16807 % 2147483647;
    const noise = (seed / 2147483647 - 0.5) * (kind === 'asphalt' ? 34 : 14);
    for (let c = 0; c < 3; c++) pixels.data[i + c] = base[c] + noise;
    pixels.data[i + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  ctx.fillStyle = 'rgba(36,44,43,0.18)';
  if (kind === 'roof' || kind === 'wall') {
    for (let x = 0; x < 256; x += 32) ctx.fillRect(x, 0, 2, 256);
  } else if (kind === 'concrete') {
    ctx.fillRect(0, 0, 256, 1);
    ctx.fillRect(0, 0, 1, 256);
  }
  const map = kind === 'concrete'
    ? new THREE.TextureLoader().load(concreteUrl)
    : new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(repeatX, repeatY);
  map.anisotropy = 8;
  return map;
}

function glow(color, intensity = 1.2) {
  return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: 0.4, metalness: 0.1 });
}

function box(parent, size, position, surface, rounded = false) {
  const material = surface?.isMaterial ? surface : paint(surface);
  const geometry = rounded ? new RoundedBoxGeometry(...size, 2, 0.025) : new THREE.BoxGeometry(...size);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  mesh.castShadow = !material.transparent;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function cylinder(parent, radius, height, position, surface, rotation = null) {
  const material = surface?.isMaterial ? surface : paint(surface, 0.5, 0.4);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 40), material);
  mesh.position.set(...position);
  mesh.castShadow = !material.transparent;
  mesh.receiveShadow = true;
  if (rotation) mesh.rotation.set(...rotation);
  parent.add(mesh);
  return mesh;
}

function tube(parent, points, radius, material) {
  const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, radius, 8, false), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function release(object) {
  object.traverse((node) => {
    node.geometry?.dispose?.();
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const m of materials) {
      if (!m) continue;
      for (const key of ['map', 'emissiveMap', 'alphaMap']) m[key]?.dispose?.();
      m.dispose?.();
    }
  });
}

/* ── 主厂房内部地面：世界坐标 → 贴图画布坐标。地面：x -0.25..20.25，纵深 y 0..10（场景 z = -y） ── */
const FLOOR_W = 1024;
const FLOOR_H = 512;
const fx = x => (x + 0.25) / 20.5 * FLOOR_W;
const fy = y => y / 10.5 * FLOOR_H;

/* 石墨色环氧地坪，黄线只标识物流边界与机位。 */
function createFloorTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = FLOOR_W;
  canvas.height = FLOOR_H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#313b3d';
  ctx.fillRect(0, 0, FLOOR_W, FLOOR_H);

  ctx.strokeStyle = 'rgba(180, 192, 188, 0.08)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= FLOOR_W; x += 64) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, FLOOR_H); ctx.stroke(); }
  for (let y = 0; y <= FLOOR_H; y += 64) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(FLOOR_W, y); ctx.stroke(); }

  ctx.fillStyle = 'rgba(132, 152, 141, 0.09)';
  ctx.fillRect(fx(0.5), fy(0.8), fx(15) - fx(0.5), fy(4.2) - fy(0.8));
  ctx.fillRect(fx(0.5), fy(5.8), fx(15) - fx(0.5), fy(9.2) - fy(5.8));
  ctx.fillStyle = 'rgba(216, 169, 40, 0.12)';
  ctx.fillRect(fx(15.4), fy(0.8), fx(19.9) - fx(15.4), fy(9.2) - fy(0.8));

  ctx.strokeStyle = 'rgba(224, 183, 72, 0.65)';
  ctx.lineWidth = 3;
  ctx.setLineDash([]);
  ctx.strokeRect(fx(0.5), fy(0.8), fx(15) - fx(0.5), fy(4.2) - fy(0.8));
  ctx.strokeRect(fx(0.5), fy(5.8), fx(15) - fx(0.5), fy(9.2) - fy(5.8));
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(200, 160, 60, 0.5)';
  ctx.strokeRect(fx(15.4), fy(0.8), fx(19.9) - fx(15.4), fy(9.2) - fy(0.8));

  ctx.fillStyle = '#b8c7c4';
  ctx.font = '600 26px sans-serif';
  ctx.fillText('加工区 A', fx(1), fy(1.6));
  ctx.fillText('加工区 B', fx(1), fy(6.6));
  ctx.fillStyle = '#d9b85c';
  ctx.fillText('缓 存 区', fx(16.2), fy(1.6));
  ctx.fillStyle = '#a9b9b5';
  ctx.font = '600 22px sans-serif';
  ctx.fillText('物 流 通 道', fx(6.4), fy(5.32));

  // 通道黄色边线 + 中央虚线
  ctx.strokeStyle = '#d8a928';
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(fx(0.5), fy(4.45)); ctx.lineTo(fx(15), fy(4.45)); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(fx(0.5), fy(5.55)); ctx.lineTo(fx(15), fy(5.55)); ctx.stroke();
  ctx.setLineDash([20, 16]);
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(fx(0.5), fy(5)); ctx.lineTo(fx(15), fy(5)); ctx.stroke();
  ctx.setLineDash([]);

  const xs = [3.4, 6.6, 9.8, 13.2];
  const ys = [2.7, 7.3];
  let n = 0;
  for (const y of ys) {
    for (const x of xs) {
      n += 1;
      ctx.strokeStyle = 'rgba(222, 184, 76, 0.55)';
      ctx.lineWidth = 2;
      ctx.strokeRect(fx(x - 1.7), fy(y - 1.35), fx(x + 1.7) - fx(x - 1.7), fy(y + 1.35) - fy(y - 1.35));
      ctx.fillStyle = '#becbc8';
      ctx.font = '600 18px sans-serif';
      ctx.fillText('M-0' + n, fx(x - 1.55), fy(y - 1.05));
    }
  }

  // PlaneGeometry 顶面 UV 的 v 方向与画布行序相反，垂直翻转一次补偿
  const flipped = document.createElement('canvas');
  flipped.width = FLOOR_W;
  flipped.height = FLOOR_H;
  const fctx = flipped.getContext('2d');
  fctx.translate(0, FLOOR_H);
  fctx.scale(1, -1);
  fctx.drawImage(canvas, 0, 0);
  const map = new THREE.CanvasTexture(flipped);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  return map;
}

/* 实拍 CC0 草地纹理随构建打包，无运行时外部依赖。来源见 assets/screen/CREDITS.md。 */
function createGrassTexture() {
  const map = new THREE.TextureLoader().load(grassUrl);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(54, 54);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  return map;
}

function addInteriorFloor(root, effects) {
  const base = box(root, [20.5, 0.12, 10.5], [10, -0.02, -5],
    new THREE.MeshStandardMaterial({ color: '#252d30', metalness: 0.2, roughness: 0.6 }));
  base.receiveShadow = true;

  const map = createFloorTexture();
  const overlay = new THREE.Mesh(
    new THREE.PlaneGeometry(20.5, 10.5),
    new THREE.MeshStandardMaterial({ map, roughness: 0.42, metalness: 0.24 }),
  );
  overlay.rotation.x = -Math.PI / 2;
  overlay.position.set(10, 0.045, -5);
  overlay.receiveShadow = true;
  root.add(overlay);

  // AGV 引导线：蓝色虚线贴图滚动
  const laneCanvas = document.createElement('canvas');
  laneCanvas.width = 256;
  laneCanvas.height = 16;
  const lctx = laneCanvas.getContext('2d');
  lctx.fillStyle = 'rgba(222, 188, 89, 0.8)';
  for (let x = 0; x < 256; x += 32) lctx.fillRect(x, 5, 18, 6);
  const laneMap = new THREE.CanvasTexture(laneCanvas);
  laneMap.wrapS = THREE.RepeatWrapping;
  laneMap.repeat.set(10, 1);
  const lane = new THREE.Mesh(
    new THREE.PlaneGeometry(13.6, 0.3),
    new THREE.MeshBasicMaterial({ map: laneMap, transparent: true, opacity: 0.7, depthWrite: false }),
  );
  lane.rotation.x = -Math.PI / 2;
  lane.position.set(7.8, 0.06, -5);
  root.add(lane);
  effects.flowLane = laneMap;
}

/* 连续地面承接车间剖切边缘，远处由场景雾自然收束。 */
function addWorkshopGround(parent) {
  const ground = new THREE.Group();
  ground.name = 'workshop-ground';
  parent.add(ground);
  const field = new THREE.Mesh(
    new THREE.PlaneGeometry(320, 320),
    new THREE.MeshStandardMaterial({ color: '#465f70', map: surfaceTexture('concrete', 100, 100), roughness: 0.95, metalness: 0 }),
  );
  field.rotation.x = -Math.PI / 2;
  field.position.set(10, -0.16, -5);
  field.receiveShadow = true;
  ground.add(field);

  const paving = new THREE.MeshStandardMaterial({ color: '#7c8d95', map: surfaceTexture('concrete', 8, 5), roughness: 0.9, metalness: 0.05 });
  box(ground, [26.5, 0.1, 16.5], [10, -0.105, -5], paving);
}

/* 开放前立面，让总览和设备近景都能看清生产现场。 */
function addHall(parent) {
  const root = new THREE.Group();
  root.name = 'hall-shell';
  parent.add(root);
  const wall = new THREE.MeshStandardMaterial({ color: '#414d4d', map: surfaceTexture('wall', 4, 1), roughness: 0.78 });
  const column = paint('#283235', 0.7, 0.4);
  const window = new THREE.MeshStandardMaterial({ color: '#608d9d', emissive: '#355a6c', emissiveIntensity: 0.35, metalness: 0.4, roughness: 0.24 });
  const yellow = paint('#d5ae46', 0.35, 0.4);
  const H = 4.8;
  box(root, [20.6, H, 0.18], [10, H / 2, -10.2], wall);
  box(root, [0.18, H, 10.4], [-0.2, H / 2, -5], wall);
  box(root, [20.6, 0.5, 0.12], [10, 0.25, -10.04], column);
  for (const x of [2.5, 7.5, 12.5, 17.5]) {
    box(root, [3.6, 1.05, 0.04], [x, 3.45, -10.08], window);
    for (const dx of [-1.8, -0.6, 0.6, 1.8]) box(root, [0.045, 1.1, 0.07], [x + dx, 3.45, -10.02], column);
    for (const y of [2.9, 3.45, 4]) box(root, [3.65, 0.045, 0.07], [x, y, -10.02], column);
    box(root, [0.36, 0.24, 0.16], [x, 2.55, -9.98], column);
    box(root, [0.28, 0.07, 0.12], [x, 2.44, -9.87], glow('#ffdaa2', 2.4));
  }
  const roof = new THREE.Group();
  roof.name = 'hall-roof';
  for (const x of [0, 5, 10, 15, 20]) {
    box(root, [0.22, H, 0.28], [x, H / 2, -10], column);
    box(root, [0.26, 0.65, 0.3], [x, 0.33, -9.98], yellow);
    for (const y of [H, H - 0.42]) box(roof, [0.12, 0.1, 10.2], [x, y, -5], column);
    for (let z = -9.1; z < 0; z += 1.8) {
      const brace = box(roof, [0.07, 0.07, 1.86], [x, H - 0.21, z], column);
      brace.rotation.x = Math.sin(z) > 0 ? 0.23 : -0.23;
    }
  }
  box(roof, [20.5, 0.15, 0.17], [10, H, -10], column);
  root.add(roof);
  // 开口护栏与货架保持在物流主通道之外。
  for (const z of [-0.35, -9.6]) {
    for (const x of [1, 4, 7, 10, 13, 15]) cylinder(root, 0.035, 0.85, [x, 0.45, z], yellow);
    for (const y of [0.48, 0.87]) cylinder(root, 0.025, 14, [8, y, z], yellow, [0, 0, Math.PI / 2]);
  }
  for (const x of [3.4, 9.8, 16.4]) {
    box(roof, [2.5, 0.09, 0.3], [x, H - 0.2, -5], column);
    box(roof, [2.35, 0.025, 0.22], [x, H - 0.26, -5], glow('#ffe4b8', 3));
    const light = new THREE.PointLight('#ffe0ad', 20, 10, 2);
    light.position.set(x, H - 0.4, -5);
    parent.add(light);
  }
}

/* ── 园区配套：草地、环形道路、油罐车、行道树、路灯 ── */
function addTruck(root, x, z, yaw, cabColor) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = yaw;
  root.add(g);
  const white = paint('#eef1f3', 0.3, 0.4);
  const cab = paint(cabColor, 0.3, 0.5);
  const dark = paint('#39434d', 0.4, 0.6);
  box(g, [1.1, 0.9, 1.5], [0, 0.75, 1.9], cab, true);           // 车头
  box(g, [1.0, 0.35, 0.06], [0, 0.95, 1.14], glass2());          // 风挡
  cylinder(g, 0.52, 3.4, [0, 0.85, -0.4], white, [Math.PI / 2, 0, 0]); // 罐体
  box(g, [0.9, 0.18, 3.6], [0, 0.3, 0], dark);                   // 底盘
  for (const wz of [1.5, 0.2, -1.2]) for (const wx of [-0.5, 0.5]) cylinder(g, 0.24, 0.16, [wx, 0.24, wz], dark, [0, 0, Math.PI / 2]);
}

function glass2() {
  return new THREE.MeshPhysicalMaterial({ color: '#7f9cad', metalness: 0.3, roughness: 0.15, transparent: true, opacity: 0.7, clearcoat: 1 });
}

function addCampus(root) {
  const grass = new THREE.Mesh(
    new THREE.PlaneGeometry(320, 320),
    new THREE.MeshStandardMaterial({ color: '#809773', map: createGrassTexture(), roughness: 0.95, metalness: 0 }),
  );
  grass.rotation.x = -Math.PI / 2;
  grass.position.set(11, -0.08, -6);
  grass.receiveShadow = true;
  root.add(grass);

  // 环形道路（灰色沥青）+ 白色虚线
  const asphalt = new THREE.MeshStandardMaterial({ map: surfaceTexture('asphalt', 8, 3), metalness: 0, roughness: 0.96 });
  const dash = paint('#e8e8e6', 0, 0.8);
  const ROAD_Y = -0.04;
  const roadH = (x1, z1, x2, z2) => {
    const w = Math.abs(x2 - x1);
    const d = Math.abs(z2 - z1);
    const mesh = box(root, [w || 2.8, 0.06, d || 2.8], [(x1 + x2) / 2, ROAD_Y, (z1 + z2) / 2], asphalt);
    mesh.receiveShadow = true;
    const cx = (x1 + x2) / 2;
    const cz = (z1 + z2) / 2;
    if (w > d) {
      for (let x = Math.min(x1, x2) + 0.8; x < Math.max(x1, x2) - 0.5; x += 1.6) box(root, [0.7, 0.02, 0.09], [x, 0.005, cz], dash);
    } else {
      for (let z = Math.min(z1, z2) + 0.8; z < Math.max(z1, z2) - 0.5; z += 1.6) box(root, [0.09, 0.02, 0.7], [cx, 0.005, z], dash);
    }
  };
  const paving = new THREE.MeshStandardMaterial({ map: surfaceTexture('concrete', 12, 8), roughness: 0.95 });
  box(root, [28, 0.08, 18], [10, -0.055, -5], paving);
  const curb = paint('#a5a99e', 0, 0.95);
  for (const z of [-13.5, 3.5]) box(root, [27, 0.16, 0.16], [10, 0.015, z], curb);
  for (const x of [-3.5, 23.5]) box(root, [0.16, 0.16, 17], [x, 0.015, -5], curb);
  roadH(-3.4, -13.4, 23.4, -10.6);
  roadH(-3.4, 0.6, 23.4, 3.4);
  roadH(-3.4, -13.4, -0.6, 3.4);
  roadH(20.6, -13.4, 23.4, 3.4);
  roadH(8.6, 3.4, 11.4, 19);

  // 油罐车（参考图特征：一辆停东侧路、一辆在入场路）
  addTruck(root, 22, -8.2, Math.PI / 2, '#c9483c');
  addTruck(root, 10, 8.6, 0, '#3c6e9f');

  // 行道树
  const trunk = paint('#5a4a38', 0, 0.9);
  const leafA = paint('#3f6b2f', 0, 0.9);
  const leafB = paint('#2f5428', 0, 0.9);
  let seed = 23;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const tree = (x, z) => {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const s = 0.85 + rand() * 0.4;
    g.scale.setScalar(s);
    cylinder(g, 0.08, 0.55, [0, 0.27, 0], trunk);
    // 多簇不规则树冠，避免重复的圆锥造型。
    const crownGeometry = new THREE.IcosahedronGeometry(0.48, 2);
    const vertices = crownGeometry.attributes.position;
    for (let i = 0; i < vertices.count; i++) {
      const x = vertices.getX(i), y = vertices.getY(i), z = vertices.getZ(i);
      const scale = 1 + 0.14 * Math.sin(x * 37 + z * 23) * Math.cos(y * 31);
      vertices.setXYZ(i, x * scale, y * scale, z * scale);
    }
    for (let i = 0; i < 7; i++) {
      const crown = new THREE.Mesh(crownGeometry, i % 2 ? leafA : leafB);
      crown.position.set((rand() - 0.5) * 0.75, 0.95 + rand() * 0.8, (rand() - 0.5) * 0.75);
      crown.scale.set(0.8 + rand() * 0.5, 0.85 + rand() * 0.5, 0.8 + rand() * 0.5);
      crown.castShadow = crown.receiveShadow = true;
      g.add(crown);
    }
    root.add(g);
  };
  for (let z = -14.8; z <= 4.5; z += 3.1) { tree(-5.2 + rand() * 0.5, z); tree(25.2 - rand() * 0.5, z + 1.2); }
  for (let x = -3.5; x <= 23; x += 4.2) { tree(x, -15.4 + rand() * 0.4); }
  for (let x = -3.5; x <= 23; x += 4.2) { if (x > 7 && x < 13.5) continue; tree(x, 5.4 - rand() * 0.4); }
  for (let z = 6.5; z <= 17; z += 3.2) { tree(6.4 + rand() * 0.4, z); tree(13.6 - rand() * 0.4, z + 1); }

  // 路灯（白昼，灯头不发光）
  const pole = paint('#6a737a', 0.6, 0.4);
  for (const [x, z] of [[-2, -9.8], [4, -9.8], [10, -9.8], [16, -9.8], [22, -9.8], [-2, 0.2], [4, 0.2], [16, 0.2], [22, 0.2], [-2, -5], [22, -5]]) {
    cylinder(root, 0.045, 2.7, [x, 1.35, z], pole);
    box(root, [0.34, 0.08, 0.16], [x, 2.74, z], paint('#c9ced2', 0.4, 0.5));
  }
}

/* 办公楼：浅色立面 + 蓝灰窗格（白昼不发光） */
function createFacadeTexture(floors, cols) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e9edf0';
  ctx.fillRect(0, 0, 256, 256);
  let seed = 5;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const ww = 236 / cols;
  const wh = 236 / floors;
  for (let f = 0; f < floors; f++) {
    for (let c = 0; c < cols; c++) {
      const lit = rand();
      ctx.fillStyle = lit > 0.5 ? '#7fa3b8' : '#a9bfcb';
      ctx.fillRect(10 + c * ww + 2, 10 + f * wh + 2, ww - 5, wh - 6);
    }
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  return map;
}

function addOutbuildings(root) {
  // 办公楼（东北角）
  const facade = createFacadeTexture(4, 6);
  const officeMat = new THREE.MeshStandardMaterial({ map: facade, roughness: 0.7, metalness: 0.1 });
  const office = box(root, [6, 4.6, 4.2], [28, 2.3, -3.5], officeMat);
  office.castShadow = true;
  box(root, [6.3, 0.18, 4.5], [28, 4.7, -3.5], paint('#94a4b0', 0.3, 0.6));
  box(root, [2.2, 0.1, 1.1], [26.2, 2.5, -1.15], paint('#9fabb5', 0.4, 0.5));

  // 仓库（东南）
  const wh = box(root, [5.4, 3.1, 4.6], [27.6, 1.55, -10], paint('#dfe4e8', 0.15, 0.65));
  wh.castShadow = true;
  box(root, [5.5, 0.14, 4.7], [27.6, 3.18, -10], paint('#6f8697', 0.35, 0.55));
  const door = paint('#9aa7b1', 0.3, 0.6);
  box(root, [2.4, 2.2, 0.08], [27.6, 1.1, -7.66], door);
  for (let y = 0.4; y < 2.1; y += 0.28) box(root, [2.3, 0.03, 0.02], [27.6, y, -7.61], paint('#7f8c96', 0.4, 0.55));

  // 白色储气罐（西北角，参考图特征）
  const tank = paint('#dce0db', 0.48, 0.48);
  for (const z of [-7.6, -9.5]) {
    const body = cylinder(root, 0.95, 2.3, [-5.8, 1.15, z], tank);
    body.castShadow = true;
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.95, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), tank);
    cap.position.set(-5.8, 2.3, z);
    cap.castShadow = true;
    root.add(cap);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.03, 8, 32), paint('#9fb0bc', 0.5, 0.4));
    rim.rotation.x = Math.PI / 2;
    rim.position.set(-5.8, 1.7, z);
    root.add(rim);
    cylinder(root, 1.08, 0.15, [-5.8, 0.075, z], paint('#9b9d93', 0, 0.95));
    for (const y of [0.45, 1.1, 2.3]) {
      const seam = rim.clone();
      seam.position.y = y;
      root.add(seam);
    }
    for (const dx of [-0.2, 0.2]) cylinder(root, 0.025, 2.7, [-5.8 + dx, 1.4, z + 0.96], paint('#687c85', 0.7, 0.42));
    for (let y = 0.25; y < 2.8; y += 0.24) box(root, [0.4, 0.025, 0.035], [-5.8, y, z + 0.97], paint('#687c85', 0.7, 0.42));
  }
  const pipe = paint('#9eafb0', 0.8, 0.36);
  for (const x of [-5.5, 0, 5.5, 11, 16.5, 22]) {
    for (const z of [-11.2, -10.7]) box(root, [0.12, 2.8, 0.12], [x, 1.4, z], paint('#477f88', 0.6, 0.55));
    box(root, [0.16, 0.16, 1], [x, 2.8, -10.95], pipe);
  }
  for (const z of [-11.2, -10.9, -10.6]) cylinder(root, 0.065, 28, [8.3, 2.9, z], pipe, [0, 0, Math.PI / 2]);
  tube(root, [[-4.9, 0.5, -8.5], [-3, 0.4, -7], [-0.4, 0.4, -6.2]], 0.06, paint('#8b99a5', 0.5, 0.45));
}

function addBufferZone(root) {
  const rack = paint('#5a6a78', 0.5, 0.5);
  const crate = paint('#9fb0bc', 0.15, 0.7);
  const stripe = paint('#d8a928', 0.1, 0.7);
  for (const x of [16.4, 18.7]) {
    for (const z of [-2.6, -7.4]) {
      for (const dx of [-0.85, 0.85]) for (const dz of [-0.5, 0.5]) box(root, [0.08, 2.1, 0.08], [x + dx, 1.05, z + dz], rack);
      for (const y of [0.5, 1.15, 1.8]) {
        box(root, [1.8, 0.06, 1.1], [x, y, z], rack);
        box(root, [1.8, 0.02, 0.06], [x, y + 0.05, z + 0.55], stripe);
      }
      for (const y of [0.68, 1.33]) {
        box(root, [0.7, 0.32, 0.9], [x - 0.42, y, z], crate, true);
        box(root, [0.7, 0.32, 0.9], [x + 0.42, y, z], crate, true);
      }
    }
  }
}

/* ── 通用工业建筑：浅色墙体 + 女儿墙压顶 + 侧窗带 + 大门 ── */
function industrialBuilding(root, { x, z, w, d, h, wall = '#dde3e7', roof = '#6f8697', doorFace = 'N' }) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  root.add(g);
  const wallMat = new THREE.MeshStandardMaterial({ color: wall, map: surfaceTexture('wall', w / 2, 1), metalness: 0.08, roughness: 0.84 });
  const body = box(g, [w, h, d], [0, h / 2, 0], wallMat);
  body.castShadow = true;
  const roofMat = new THREE.MeshStandardMaterial({ color: roof, map: surfaceTexture('roof', w / 3, d / 3), metalness: 0.45, roughness: 0.65 });
  box(g, [w + 0.3, 0.22, d + 0.3], [0, h + 0.1, 0], roofMat);
  for (const side of [-1, 1]) {
    box(g, [0.1, 0.14, d + 0.3], [side * (w / 2 + 0.1), h + 0.2, 0], roofMat);
    for (const z of [-d / 2 + 0.25, d / 2 - 0.25]) cylinder(g, 0.045, h, [side * (w / 2 + 0.08), h / 2, z], paint('#829090', 0.5, 0.55));
  }
  for (const x of [-w * 0.23, w * 0.23]) {
    box(g, [1.1, 0.4, 0.8], [x, h + 0.4, 0], paint('#b9c0bc', 0.45, 0.55));
    for (let n = 0; n < 5; n++) box(g, [0.8, 0.025, 0.04], [x, h + 0.35 + n * 0.06, 0.41], paint('#5b6768', 0.5, 0.55));
  }
  box(g, [w + 0.34, 0.3, 0.12], [0, h + 0.15, d / 2 + 0.1], paint(roof, 0.35, 0.55));
  box(g, [w + 0.34, 0.3, 0.12], [0, h + 0.15, -d / 2 - 0.1], paint(roof, 0.35, 0.55));
  // 侧窗带（两层长条窗）
  const win = glass2();
  for (const y of [h * 0.45, h * 0.72]) {
    for (let wx = -w / 2 + 0.8; wx < w / 2 - 0.6; wx += 1.6) {
      box(g, [1.1, 0.5, 0.04], [wx, y, d / 2 + 0.02], win);
      box(g, [1.1, 0.5, 0.04], [wx, y, -d / 2 - 0.02], win);
    }
  }
  // 大门（朝向环路一侧）
  const door = paint('#9aa7b1', 0.3, 0.6);
  const dz = doorFace === 'N' ? -d / 2 - 0.03 : d / 2 + 0.03;
  box(g, [2.6, 2.4, 0.08], [0, 1.2, dz], door);
  for (let y = 0.5; y < 2.3; y += 0.3) box(g, [2.5, 0.03, 0.02], [0, y, dz + (doorFace === 'N' ? -0.04 : 0.04)], paint('#7f8c96', 0.4, 0.55));
  return g;
}

function addCar(root, x, z, yaw, color) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = yaw;
  root.add(g);
  box(g, [0.92, 0.32, 1.9], [0, 0.3, 0], paint(color, 0.5, 0.3), true);
  box(g, [0.8, 0.3, 1.0], [0, 0.6, -0.1], glass2(), true);
  for (const [wx, wz] of [[-0.42, 0.62], [0.42, 0.62], [-0.42, -0.62], [0.42, -0.62]]) {
    cylinder(g, 0.15, 0.1, [wx, 0.15, wz], paint('#161d23', 0.1, 0.8), [0, 0, Math.PI / 2]);
  }
}

/* ── 更多园区建筑：南侧厂房群、背景厂房、动力中心、门卫道闸、停车场、旗杆 ── */
function addMoreBuildings(root) {
  // 南侧：装配车间 + 检测中心（入场路两侧）
  industrialBuilding(root, { x: 3.6, z: 9.6, w: 7, d: 8, h: 4.6, wall: '#dde3e7', roof: '#698092', doorFace: 'N' });
  industrialBuilding(root, { x: 17.4, z: 9.6, w: 7, d: 8, h: 4.2, wall: '#e4e8eb', roof: '#6f8697', doorFace: 'N' });
  // 北侧背景厂房群（压低饱和度作远景）
  industrialBuilding(root, { x: 3.5, z: -18.6, w: 10.5, d: 6.5, h: 4.6, wall: '#c9d1d6', roof: '#667c89', doorFace: 'S' });
  industrialBuilding(root, { x: 17, z: -19.2, w: 9, d: 6, h: 4, wall: '#c4ccd2', roof: '#5f727e', doorFace: 'S' });
  industrialBuilding(root, { x: -8.5, z: -17.5, w: 6.5, d: 5.5, h: 3.8, wall: '#c9d1d6', roof: '#667c89', doorFace: 'S' });

  // 西侧动力中心：主楼 + 变压器 + 冷却塔
  industrialBuilding(root, { x: -8.8, z: -1.2, w: 4.5, d: 5, h: 3.4, wall: '#d5dce0', roof: '#6f8697', doorFace: 'S' });
  const transformer = paint('#4a5a66', 0.5, 0.5);
  for (const z of [-3.9, -4.9]) {
    box(root, [1.1, 1.3, 0.9], [-5.6, 0.65, z], transformer, true);
    cylinder(root, 0.05, 0.5, [-5.6, 1.55, z], paint('#8b99a5', 0.6, 0.4));
  }
  const cooling = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.45, 2.8, 24), paint('#e2e7ea', 0.15, 0.6));
  cooling.position.set(-11.5, 1.4, -7.5);
  cooling.castShadow = true;
  root.add(cooling);
  box(root, [2.4, 0.14, 0.1], [-11.5, 2.6, -7.5], paint('#9fb0bc', 0.4, 0.5));

  // 门卫室 + 道闸（入场路口）
  box(root, [1.9, 2.5, 1.7], [12.9, 1.25, 4.8], paint('#e4e8eb', 0.15, 0.6), true).castShadow = true;
  box(root, [2.1, 0.16, 1.9], [12.9, 2.58, 4.8], paint('#6f8697', 0.35, 0.55));
  box(root, [1.2, 0.7, 0.05], [12.9, 1.5, 3.94], glass2());
  cylinder(root, 0.07, 0.9, [8.4, 0.45, 4.6], paint('#6a737a', 0.5, 0.5));
  for (let i = 0; i < 6; i++) box(root, [0.55, 0.12, 0.08], [8.85 + i * 0.56, 0.92, 4.6], paint(i % 2 ? '#e8e8e6' : '#c9483c', 0.2, 0.6));

  // 停车场（东南角）：车位线 + 几辆小车
  const lot = box(root, [7.6, 0.05, 3.4], [17, -0.03, 16.6], paint('#4c5257', 0.05, 0.9));
  lot.receiveShadow = true;
  const stall = paint('#e8e8e6', 0, 0.8);
  for (let x = 13.8; x <= 20.2; x += 1.35) box(root, [0.06, 0.02, 2.8], [x, 0.01, 16.6], stall);
  addCar(root, 14.5, 16.6, Math.PI / 2, '#e8ecef');
  addCar(root, 16.6, 16.6, Math.PI / 2, '#3c6e9f');
  addCar(root, 18.5, 16.6, Math.PI / 2, '#c9483c');
  addCar(root, 19.9, 16.6, Math.PI / 2, '#8a949c');

  // 旗杆（办公楼前）
  cylinder(root, 0.05, 6.2, [24.6, 3.1, 0.6], paint('#c9ced2', 0.7, 0.3));
  const flag = box(root, [1.05, 0.62, 0.02], [25.2, 5.7, 0.6], paint('#c0392b', 0.1, 0.7));
  flag.castShadow = true;
}

/* CNC 加工中心：独立主轴、夹具与工件，供运行态动画驱动。 */
function createMachine(group) {
  const body = paint(TONE.body, 0.3, 0.45);
  const bodyLight = paint(TONE.bodyLight, 0.35, 0.4);
  const edge = paint(TONE.edge, 0.6, 0.35);
  const dark = paint(TONE.dark, 0.45, 0.45);
  const steel = paint(TONE.steel, 0.8, 0.28);
  const rubber = paint('#161d23', 0.05, 0.85);
  const accent = paint('#d8ae46', 0.4, 0.38);
  const glass = new THREE.MeshPhysicalMaterial({ color: '#93b6b4', transparent: true, opacity: 0.15, metalness: 0.15, roughness: 0.15, depthWrite: false });
  const panelMap = createPanelTexture();
  const screen = new THREE.MeshStandardMaterial({ map: panelMap, emissiveMap: panelMap, emissive: '#ffffff', emissiveIntensity: 0.5, roughness: 0.25 });

  for (const x of [-0.84, 0.84]) for (const z of [-0.58, 0.58]) cylinder(group, 0.13, 0.1, [x, 0.06, z], rubber);
  box(group, [2.15, 0.22, 1.6], [0, 0.18, 0], dark, true);
  box(group, [2.02, 0.7, 1.48], [0, 0.58, 0], body, true);
  box(group, [1.86, 0.04, 0.025], [0, 0.68, 0.754], dark);
  box(group, [0.025, 0.53, 0.025], [0, 0.51, 0.755], dark);
  box(group, [2.03, 0.05, 0.03], [0, 0.9, 0.75], accent);
  box(group, [1.94, 1.52, 0.42], [0, 1.64, -0.53], body, true);
  for (const x of [-0.88, 0.88]) box(group, [0.28, 1.45, 1.22], [x, 1.62, 0], bodyLight, true);
  box(group, [1.5, 1.15, 0.12], [0, 1.55, -0.28], dark, true);
  box(group, [2.04, 0.32, 1.5], [0, 2.37, 0], bodyLight, true);
  box(group, [1.64, 0.08, 0.05], [0, 2.22, 0.77], accent);
  box(group, [1.43, 0.13, 0.85], [0, 1.03, 0.19], steel);
  const guideRails = new THREE.Group();
  group.add(guideRails);
  for (const x of [-0.45, 0.45]) cylinder(guideRails, 0.045, 0.72, [x, 1.15, 0.34], steel, [Math.PI / 2, 0, 0]);
  for (let x = -0.55; x <= 0.56; x += 0.22) box(guideRails, [0.09, 0.025, 0.64], [x, 1.12, 0.29], dark);
  const toolHead = new THREE.Group();
  group.add(toolHead);
  cylinder(toolHead, 0.17, 0.55, [0, 1.85, 0.12], steel);
  const spindle = cylinder(toolHead, 0.065, 0.28, [0, 1.46, 0.12], dark);
  box(spindle, [0.03, 0.18, 0.07], [0.045, 0, 0], steel);
  const workpiece = new THREE.Group();
  group.add(workpiece);
  box(workpiece, [0.7, 0.08, 0.55], [0, 1.17, 0.12], dark);
  cylinder(workpiece, 0.2, 0.12, [0, 1.27, 0.12], steel);
  for (const x of [-0.3, 0.3]) box(workpiece, [0.09, 0.13, 0.43], [x, 1.25, 0.12], steel);
  for (const x of [-0.72, 0.49]) box(group, [0.07, 0.96, 0.05], [x, 1.66, 0.69], dark);
  for (const y of [1.18, 2.14]) box(group, [1.28, 0.065, 0.05], [-0.12, y, 0.69], dark);
  box(group, [1.06, 0.73, 0.025], [-0.12, 1.66, 0.692], glass, true);
  const workLight = box(group, [1.1, 0.035, 0.1], [0, 2.12, 0.22], glow('#c9ebef', 1.5));
  tube(group, [[0.47, 1.35, 0.75], [0.52, 1.4, 0.78], [0.52, 1.72, 0.78], [0.47, 1.77, 0.75]], 0.022, steel);
  const panelGroup = new THREE.Group();
  panelGroup.position.set(1.1, 1.55, 0.72);
  panelGroup.rotation.y = -0.18;
  group.add(panelGroup);
  tube(group, [[0.9, 2.05, -0.1], [1.18, 2.05, 0.1], [1.22, 1.8, 0.63]], 0.045, dark);
  box(panelGroup, [0.48, 0.68, 0.2], [0, 0, 0], dark, true);
  box(panelGroup, [0.4, 0.58, 0.035], [0, 0, 0.115], edge, true);
  box(panelGroup, [0.31, 0.24, 0.018], [0, 0.12, 0.14], screen, true);
  for (const [x, color] of [[-0.11, TONE.green], [0, TONE.blue], [0.11, TONE.red]]) cylinder(panelGroup, 0.027, 0.025, [x, -0.16, 0.15], paint(color, 0.2, 0.5), [Math.PI / 2, 0, 0]);
  const vent = new THREE.Group();
  group.add(vent);
  box(vent, [0.025, 0.72, 0.63], [1.028, 1.32, -0.25], dark);
  for (let n = 0; n < 9; n++) box(vent, [0.035, 0.025, 0.54], [1.049, 1.04 + n * 0.07, -0.25], edge);
  tube(group, [[1.02, 0.92, -0.45], [1.26, 0.62, -0.5], [1.25, 0.15, -0.4], [0.7, 0.1, -0.6]], 0.035, rubber);
  for (const x of [-0.86, 0.86]) for (const y of [0.4, 0.78, 2.3, 2.46]) cylinder(group, 0.018, 0.018, [x, y, 0.776], steel, [Math.PI / 2, 0, 0]);
  // 独立警示灯塔，沿用设备状态语义。
  cylinder(group, 0.04, 0.3, [0.68, 2.68, -0.15], dark);
  const beacon = new THREE.Mesh(
    new THREE.CylinderGeometry(0.075, 0.075, 0.34, 16),
    glow(TONE.green, 0.9),
  );
  beacon.position.set(0.68, 2.98, -0.15);
  group.add(beacon);
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 16, 12),
    new THREE.MeshBasicMaterial({ color: TONE.green, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  halo.position.copy(beacon.position);
  group.add(halo);
  return { beacon, halo, spindle, toolHead, workpiece, workLight };
}

function createAgv(group) {
  const dark = paint(TONE.dark, 0.5, 0.45);
  const blue = paint('#d9b248', 0.3, 0.45);
  const steel = paint(TONE.steel, 0.75, 0.3);
  box(group, [1.05, 0.24, 0.72], [0, 0.23, 0], dark, true);
  box(group, [1.08, 0.1, 0.74], [0, 0.39, 0], blue, true);
  box(group, [0.82, 0.08, 0.58], [0, 0.48, 0], steel, true);
  for (const x of [-0.37, 0.37]) for (const z of [-0.34, 0.34]) cylinder(group, 0.13, 0.09, [x, 0.15, z], paint('#161d23', 0.1, 0.8), [Math.PI / 2, 0, 0]);
  cylinder(group, 0.13, 0.12, [0.28, 0.56, 0], dark);
  cylinder(group, 0.1, 0.03, [0.28, 0.64, 0], paint(TONE.cyan, 0.3, 0.4));
  const lamp = glow('#e0f4ef', 1.5);
  for (const z of [-0.22, 0.22]) box(group, [0.03, 0.07, 0.13], [0.54, 0.3, z], lamp, true);
  box(group, [0.52, 0.28, 0.42], [-0.12, 0.67, 0], '#9fb0bc', true);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.09, 14, 10), glow(TONE.cyan, 0.9));
  beacon.position.set(0.28, 0.78, 0);
  group.add(beacon);
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(0.15, 14, 10),
    new THREE.MeshBasicMaterial({ color: TONE.cyan, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  halo.position.copy(beacon.position);
  group.add(halo);
  return { beacon, halo };
}

function statusColor(device) {
  if (device.online === false) return TONE.muted;
  if (device.status === 'down' || device.health?.level === 'bad') return TONE.red;
  if (device.status === 'maintain' || device.health?.level === 'attention') return TONE.amber;
  if (device.status === 'idle') return TONE.blue;
  return TONE.green;
}

function createDevice(workshop, device) {
  const group = new THREE.Group();
  const parts = device.kind === 'agv' ? createAgv(group) : createMachine(group);
  // 状态光环（呼吸脉冲在 animateDarkWorkshop 中驱动）
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.3, 1.45, 48),
    new THREE.MeshBasicMaterial({ color: TONE.green, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  if (device.kind === 'agv') {
    ring.scale.setScalar(0.62);
    ring.position.y = 0.07;
  }
  group.add(ring);
  // 自然光阴影：实体网格投影，光环/光晕/Additive 材质不参与
  group.traverse((node) => {
    if (node.isMesh && node !== ring && !node.material?.transparent && node.material?.blending !== THREE.AdditiveBlending) node.castShadow = true;
  });
  group.userData = { deviceId: device.id, kind: device.kind, ring, ...parts, phase: Math.random() * Math.PI * 2, machiningTime: 0 };
  workshop.root.add(group);
  return group;
}

export function createDarkWorkshop() {
  const root = new THREE.Group();
  const effects = {};
  addWorkshopGround(root);
  addInteriorFloor(root, effects);
  addHall(root);
  addBufferZone(root);
  const surroundings = new THREE.Group();
  surroundings.name = 'campus-context';
  surroundings.visible = false;
  root.add(surroundings);
  addCampus(surroundings);
  addOutbuildings(surroundings);
  addMoreBuildings(surroundings);
  return { root, devices: new Map(), effects };
}

export function updateDarkDevices(workshop, devices, selectedId = null, now = performance.now()) {
  const active = new Set();
  for (const device of devices) {
    if (!['machine', 'agv'].includes(device.kind) || !Number.isFinite(device.position?.x) || !Number.isFinite(device.position?.y)) continue;
    active.add(device.id);
    let model = workshop.devices.get(device.id);
    if (!model) {
      model = createDevice(workshop, device);
      workshop.devices.set(device.id, model);
    }
    if (device.kind === 'agv') {
      const points = model.userData.points || (model.userData.points = []);
      const last = points[points.length - 1];
      if (!last || last.x !== device.position.x || last.z !== -device.position.y) {
        points.push(new THREE.Vector3(device.position.x, 0.07, -device.position.y));
        if (points.length > 16) points.shift();
        if (!model.userData.trail) {
          model.userData.trail = new THREE.Line(
            new THREE.BufferGeometry(),
            new THREE.LineBasicMaterial({ color: TONE.blue, transparent: true, opacity: 0.55 }),
          );
          workshop.root.add(model.userData.trail);
        }
        model.userData.trail.geometry.dispose();
        model.userData.trail.geometry = new THREE.BufferGeometry().setFromPoints(points);
      }
    }
    syncDeviceMotion(model, device, now);
    model.userData.running = isDeviceRunning(device);
    model.userData.alarm = device.online !== false && (device.status === 'down' || device.health?.level === 'bad');
    const color = statusColor(device);
    const selected = device.id === selectedId;
    model.userData.beacon.material.color.set(color);
    model.userData.beacon.material.emissive.set(color);
    model.userData.halo.material.color.set(color);
    // 选中设备：光环换青色并放大一圈（呼吸动画每帧重写 opacity，选中态只靠颜色与尺寸表达）
    model.userData.ring.material.color.set(selected ? TONE.cyan : color);
    model.userData.ring.scale.setScalar((device.kind === 'agv' ? 0.62 : 1) * (selected ? 1.25 : 1));
    model.userData.ring.visible = selected || model.userData.alarm;
    if (model.userData.workLight) model.userData.workLight.material.emissiveIntensity = model.userData.running ? 1.8 : 0.12;
  }
  for (const [id, model] of workshop.devices) {
    if (!active.has(id)) {
      if (model.userData.trail) {
        model.userData.trail.removeFromParent();
        release(model.userData.trail);
      }
      workshop.root.remove(model);
      release(model);
      workshop.devices.delete(id);
    }
  }
}

/* 时间差驱动：主轴/工作台随运行态启停，AGV 只在已收到的坐标之间平滑移动。 */
export function animateDarkWorkshop(workshop, time, reducedMotion = false) {
  const t = time / 1000;
  const dt = Math.min(0.1, Math.max(0, (time - (workshop.lastFrame ?? time)) / 1000));
  workshop.lastFrame = time;
  if (workshop.effects.flowLane && !reducedMotion) workshop.effects.flowLane.offset.x = -t * 0.18;
  for (const model of workshop.devices.values()) {
    advanceDeviceMotion(model, time, reducedMotion);
    const { ring, halo, phase, spindle, toolHead, workpiece, running, alarm } = model.userData;
    if (running && !reducedMotion && spindle) {
      model.userData.machiningTime += dt;
      spindle.rotation.y += dt * 12;
      toolHead.position.x = Math.sin(model.userData.machiningTime * 0.8 + phase) * 0.13;
      workpiece.position.z = Math.sin(model.userData.machiningTime * 0.6 + phase) * 0.08;
    }
    if (ring) ring.material.opacity = reducedMotion ? 0.3 : 0.2 + 0.12 * (Math.sin(t * 2.2 + phase) * 0.5 + 0.5);
    model.userData.beacon.material.emissiveIntensity = alarm && !reducedMotion ? 0.7 + 1.2 * (Math.sin(t * 5) * 0.5 + 0.5) : 0.65;
    if (halo) {
      const s = reducedMotion ? 1 : 1 + 0.12 * Math.sin(t * 3 + phase);
      halo.scale.setScalar(s);
      halo.material.opacity = alarm ? 0.2 : 0.06;
    }
  }
}

export function disposeDarkWorkshop(workshop) {
  release(workshop.root);
  workshop.devices.clear();
}
