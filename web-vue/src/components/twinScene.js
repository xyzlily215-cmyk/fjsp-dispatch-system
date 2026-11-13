import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createNameplateTexture, createPanelTexture, createWarningTexture } from './twinTextures.js';

function paint(color, metalness = 0.15, roughness = 0.5) {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness });
}

function box(parent, size, position, surface, rounded = false) {
  const material = surface?.isMaterial ? surface : paint(surface);
  const geometry = rounded ? new RoundedBoxGeometry(...size, 2, 0.025) : new THREE.BoxGeometry(...size);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function cylinder(parent, radius, height, position, surface, rotation = null) {
  const material = surface?.isMaterial ? surface : paint(surface, 0.65, 0.32);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 20), material);
  mesh.position.set(...position);
  if (rotation) mesh.rotation.set(...rotation);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function tube(parent, points, radius, material) {
  const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, radius, 8, false), material);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function decal(parent, size, position, map) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(...size), new THREE.MeshStandardMaterial({ map, transparent: true, roughness: 0.45, metalness: 0.08 }));
  mesh.position.set(...position);
  parent.add(mesh);
  return mesh;
}

function concreteTexture() {
  const size = 256;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const grain = Math.sin(x * 91.7 + y * 47.3) * 43758.5453;
      const noise = (grain - Math.floor(grain)) * 18;
      const broad = Math.sin(x / 31) * Math.cos(y / 43) * 5;
      const value = 167 + noise + broad;
      pixels[i] = value;
      pixels[i + 1] = value + 2;
      pixels[i + 2] = value + 3;
      pixels[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(5, 2.5);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function release(root) {
  root.traverse((object) => {
    object.geometry?.dispose();
    if (object.material) {
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        material.map?.dispose();
        material.dispose();
      }
    }
  });
}

function addFactoryShell(root, c) {
  const wall = paint('#d9dde0', 0.05, 0.88);
  const steel = paint('#65727c', 0.72, 0.36);
  const trim = paint(c.muted, 0.6, 0.4);
  const white = paint('#f1f3f4', 0.3, 0.45);
  const glass = new THREE.MeshPhysicalMaterial({ color: '#afc5d1', transparent: true, opacity: 0.32, roughness: 0.18, metalness: 0.05 });
  box(root, [20.3, 4.5, 0.18], [10, 2.2, -10.15], wall);
  box(root, [0.18, 4.5, 10.2], [-0.15, 2.2, -5], wall);
  box(root, [20.2, 0.85, 0.12], [10, 0.4, -10.02], c.muted);
  for (const x of [0, 5, 10, 15, 20]) {
    box(root, [0.22, 4.6, 0.3], [x, 2.25, -9.94], steel);
    box(root, [0.52, 0.12, 0.58], [x, 0.06, -9.94], trim);
    box(root, [0.18, 0.2, 10.2], [x, 4.45, -5], steel);
    for (const z of [-7.5, -2.5]) {
      const diagonal = box(root, [0.09, 0.09, 5.2], [x, 4.15, z], trim);
      diagonal.rotation.x = z === -7.5 ? -0.12 : 0.12;
    }
  }
  box(root, [20.2, 0.22, 0.24], [10, 4.45, -0.05], steel);
  box(root, [20.2, 0.22, 0.24], [10, 4.45, -9.95], steel);
  for (const x of [2.5, 7.5, 12.5, 17.5]) {
    box(root, [3.5, 1.05, 0.04], [x, 3.15, -10.03], glass);
    box(root, [3.65, 0.07, 0.08], [x, 2.6, -9.99], white);
    box(root, [3.65, 0.07, 0.08], [x, 3.7, -9.99], white);
    box(root, [0.07, 1.1, 0.08], [x, 3.15, -9.99], white);
  }
  for (const x of [2.5, 7.5, 12.5, 17.5]) {
    const light = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 1.6, roughness: 0.35 });
    box(root, [2.7, 0.07, 0.34], [x, 4.25, -4.7], trim);
    box(root, [2.5, 0.035, 0.25], [x, 4.2, -4.7], light);
  }
  const duct = cylinder(root, 0.19, 19.5, [10, 3.98, -9.5], trim, [0, 0, Math.PI / 2]);
  duct.castShadow = false;
  for (const x of [1.4, 18.5]) {
    box(root, [0.95, 0.95, 0.3], [x, 2.1, -9.85], white, true);
    cylinder(root, 0.35, 0.04, [x, 2.1, -9.66], c.ink, [Math.PI / 2, 0, 0]);
    for (let n = -3; n <= 3; n++) box(root, [0.62, 0.025, 0.03], [x, 2.1 + n * 0.085, -9.62], trim);
  }
}

function addFloor(root) {
  const map = concreteTexture();
  const material = new THREE.MeshStandardMaterial({ color: '#d2d5d6', map, roughness: 0.64, metalness: 0.08 });
  const floor = box(root, [20.5, 0.16, 10.5], [10, -0.1, -5], material);
  floor.castShadow = false;
  root.userData.floor = floor;
  const seam = new THREE.MeshBasicMaterial({ color: '#8e969b', transparent: true, opacity: 0.24 });
  for (const x of [5, 10, 15]) box(root, [0.012, 0.006, 10], [x, -0.012, -5], seam);
  for (const z of [-2.5, -5, -7.5]) box(root, [20, 0.006, 0.012], [10, -0.012, z], seam);
  const lane = paint('#e5bd32', 0.02, 0.8);
  for (const z of [-3.85, -6.15]) box(root, [19.2, 0.009, 0.055], [10, -0.005, z], lane);
  for (let x = 0.8; x < 20; x += 1.25) box(root, [0.62, 0.009, 0.07], [x, -0.004, -3.55], lane);
}

function addLogistics(root, c) {
  const rack = paint(c.ink, 0.65, 0.4);
  const crate = paint('#8796a2', 0.08, 0.76);
  const pallet = paint('#9c8060', 0, 0.9);
  for (const x of [0.75, 19.2]) {
    for (const z of [-1.2, -8.75]) {
      box(root, [0.95, 0.12, 1.15], [x, 0.08, z], pallet);
      for (const y of [0.28, 0.68]) {
        box(root, [0.85, 0.34, 0.95], [x, y, z], crate, true);
        box(root, [0.87, 0.045, 0.97], [x, y + 0.18, z], c.ink);
        for (let n = -2; n <= 2; n++) box(root, [0.04, 0.25, 0.02], [x + n * 0.14, y, z + 0.49], rack);
      }
    }
  }
  const cart = new THREE.Group();
  cart.position.set(16.6, 0, -8.85);
  root.add(cart);
  box(cart, [1.05, 0.12, 0.65], [0, 0.25, 0], c.blue, true);
  for (const x of [-0.42, 0.42]) for (const z of [-0.23, 0.23]) cylinder(cart, 0.09, 0.08, [x, 0.12, z], c.ink, [Math.PI / 2, 0, 0]);
  tube(cart, [[0.48, 0.25, -0.28], [0.48, 0.9, -0.28], [-0.48, 0.9, -0.28], [-0.48, 0.25, -0.28]], 0.025, rack);
}

export function createWorkshop(colors) {
  const root = new THREE.Group();
  addFloor(root);
  addFactoryShell(root, colors);
  addLogistics(root, colors);
  return { root, devices: new Map(), colors };
}

function createMachine(group, c) {
  const white = paint('#e5e8e9', 0.38, 0.36);
  const edge = paint('#b7c0c7', 0.65, 0.32);
  const dark = paint(c.ink, 0.5, 0.38);
  const rubber = paint('#171d23', 0.05, 0.82);
  const steel = paint('#b8c3ca', 0.88, 0.2);
  const blue = paint(c.blue, 0.35, 0.36);
  const yellow = paint('#d8ad29', 0.25, 0.45);
  const glass = new THREE.MeshPhysicalMaterial({ color: '#486574', metalness: 0.25, roughness: 0.12, transparent: true, opacity: 0.58, clearcoat: 1 });
  const panelMap = createPanelTexture();
  const screen = new THREE.MeshStandardMaterial({ map: panelMap, emissiveMap: panelMap, emissive: '#ffffff', emissiveIntensity: 0.45, roughness: 0.18 });
  for (const x of [-0.84, 0.84]) for (const z of [-0.58, 0.58]) cylinder(group, 0.13, 0.1, [x, 0.06, z], rubber);
  box(group, [2.15, 0.22, 1.6], [0, 0.18, 0], dark, true);
  box(group, [2.02, 0.7, 1.48], [0, 0.58, 0], white, true);
  box(group, [1.86, 0.04, 0.025], [0, 0.68, 0.754], dark);
  box(group, [0.025, 0.53, 0.025], [0, 0.51, 0.755], dark);
  for (const x of [-0.89, 0.89]) box(group, [0.07, 0.07, 0.04], [x, 0.32, 0.77], edge, true);
  box(group, [1.94, 1.52, 0.42], [0, 1.64, -0.53], white, true);
  for (const x of [-0.88, 0.88]) box(group, [0.28, 1.45, 1.22], [x, 1.62, 0], white, true);
  const cabin = box(group, [1.5, 1.15, 0.12], [0, 1.55, -0.28], dark, true);
  box(group, [2.04, 0.32, 1.5], [0, 2.37, 0], white, true);
  box(group, [1.64, 0.08, 0.05], [0, 2.19, 0.77], blue);
  box(group, [1.43, 0.13, 0.85], [0, 1.03, 0.19], steel);
  const guideRails = new THREE.Group();
  group.add(guideRails);
  for (const x of [-0.45, 0.45]) cylinder(guideRails, 0.045, 0.72, [x, 1.15, 0.34], steel, [Math.PI / 2, 0, 0]);
  for (let x = -0.55; x <= 0.56; x += 0.22) box(guideRails, [0.09, 0.025, 0.64], [x, 1.12, 0.29], dark);
  cylinder(group, 0.17, 0.55, [0, 1.85, 0.12], steel);
  cylinder(group, 0.065, 0.28, [0, 1.46, 0.12], dark);
  box(group, [1.22, 0.9, 0.035], [-0.12, 1.66, 0.665], dark, true);
  const window = box(group, [1.06, 0.73, 0.025], [-0.12, 1.66, 0.692], glass, true);
  for (let n = -2; n <= 2; n++) box(group, [0.025, 0.7, 0.015], [-0.12 + n * 0.19, 1.66, 0.71], dark);
  for (const y of [1.38, 1.91]) box(group, [1.05, 0.025, 0.02], [-0.12, y, 0.71], dark);
  tube(group, [[0.47, 1.35, 0.75], [0.52, 1.4, 0.78], [0.52, 1.72, 0.78], [0.47, 1.77, 0.75]], 0.022, steel);
  const panelGroup = new THREE.Group();
  panelGroup.position.set(1.1, 1.55, 0.72);
  panelGroup.rotation.y = -0.18;
  group.add(panelGroup);
  tube(group, [[0.9, 2.05, -0.1], [1.18, 2.05, 0.1], [1.22, 1.8, 0.63]], 0.045, dark);
  box(panelGroup, [0.48, 0.68, 0.2], [0, 0, 0], dark, true);
  box(panelGroup, [0.4, 0.58, 0.035], [0, 0, 0.115], edge, true);
  const panel = box(panelGroup, [0.31, 0.24, 0.018], [0, 0.12, 0.14], screen, true);
  for (const [x, color] of [[-0.11, c.success], [0, c.ink], [0.11, c.danger]]) cylinder(panelGroup, 0.027, 0.025, [x, -0.16, 0.15], color, [Math.PI / 2, 0, 0]);
  cylinder(panelGroup, 0.048, 0.018, [0.11, -0.16, 0.135], yellow, [Math.PI / 2, 0, 0]);
  const vent = new THREE.Group();
  group.add(vent);
  box(vent, [0.025, 0.72, 0.63], [1.028, 1.32, -0.25], dark);
  for (let n = 0; n < 9; n++) box(vent, [0.035, 0.025, 0.54], [1.049, 1.04 + n * 0.07, -0.25], edge);
  tube(group, [[1.02, 0.92, -0.45], [1.26, 0.62, -0.5], [1.25, 0.15, -0.4], [0.7, 0.1, -0.6]], 0.035, rubber);
  const nameplate = decal(group, [0.5, 0.155], [-0.38, 2.37, 0.773], createNameplateTexture());
  decal(group, [0.16, 0.16], [0.66, 0.51, 0.773], createWarningTexture());
  box(group, [0.05, 0.17, 0.04], [0.09, 0.49, 0.785], edge, true);
  cylinder(group, 0.024, 0.025, [0.09, 0.53, 0.815], dark, [Math.PI / 2, 0, 0]);
  const fasteners = new THREE.Group();
  group.add(fasteners);
  for (const x of [-0.82, 0.82]) for (const y of [0.34, 0.76, 2.28, 2.45]) cylinder(fasteners, 0.017, 0.015, [x, y, 0.774], steel, [Math.PI / 2, 0, 0]);
  for (const x of [-0.88, 0.88]) for (const y of [1.15, 2.03]) cylinder(fasteners, 0.017, 0.015, [x, y, 0.626], steel, [Math.PI / 2, 0, 0]);
  const hinges = new THREE.Group();
  group.add(hinges);
  for (const y of [1.4, 1.66, 1.91]) box(hinges, [0.055, 0.11, 0.04], [-0.76, y, 0.72], edge, true);
  cylinder(group, 0.035, 0.25, [0.68, 2.65, -0.15], dark);
  cylinder(group, 0.055, 0.08, [0.68, 2.73, -0.15], c.danger);
  cylinder(group, 0.055, 0.08, [0.68, 2.79, -0.15], c.warning);
  return { cabin, window, panel, vent, guideRails, nameplate, fasteners, hinges };
}

function createAgv(group, c) {
  const dark = paint(c.ink, 0.65, 0.4);
  const blue = paint(c.blue, 0.35, 0.36);
  const steel = paint('#b8c3ca', 0.85, 0.25);
  box(group, [1.05, 0.24, 0.72], [0, 0.23, 0], dark, true);
  box(group, [1.08, 0.1, 0.74], [0, 0.39, 0], blue, true);
  box(group, [0.82, 0.08, 0.58], [0, 0.48, 0], steel, true);
  for (const x of [-0.37, 0.37]) for (const z of [-0.34, 0.34]) cylinder(group, 0.13, 0.09, [x, 0.15, z], c.ink, [Math.PI / 2, 0, 0]);
  cylinder(group, 0.13, 0.12, [0.28, 0.56, 0], dark);
  cylinder(group, 0.1, 0.025, [0.28, 0.63, 0], c.blue);
  const lamp = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 1.2 });
  for (const z of [-0.22, 0.22]) box(group, [0.025, 0.06, 0.12], [0.535, 0.3, z], lamp, true);
  box(group, [0.52, 0.28, 0.42], [-0.12, 0.67, 0], '#8796a2', true);
}

function contactShadow(group, width, depth) {
  const size = 64;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const distance = Math.hypot((x - 31.5) / 31.5, (y - 31.5) / 31.5);
    pixels[i + 3] = Math.max(0, 1 - distance) ** 2 * 150;
  }
  const map = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
  map.needsUpdate = true;
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.003;
  shadow.raycast = () => {};
  group.add(shadow);
}

function createDevice(workshop, device) {
  const group = new THREE.Group();
  contactShadow(group, device.kind === 'agv' ? 1.8 : 3.2, device.kind === 'agv' ? 1.3 : 2.4);
  const parts = device.kind === 'agv' ? createAgv(group, workshop.colors) : createMachine(group, workshop.colors);
  const beacon = cylinder(group, 0.055, 0.12, [0.68, device.kind === 'agv' ? 0.7 : 2.82, -0.15], workshop.colors.success);
  const selection = new THREE.Mesh(new THREE.RingGeometry(1.18, 1.23, 64), new THREE.MeshBasicMaterial({ color: workshop.colors.blue, side: THREE.DoubleSide, transparent: true, opacity: 0.75 }));
  selection.rotation.x = -Math.PI / 2;
  selection.position.y = 0.012;
  group.add(selection);
  group.userData = { deviceId: device.id, beacon, selection, parts };
  workshop.root.add(group);
  return group;
}

export function updateDevices(workshop, devices, selectedId) {
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
        points.push(new THREE.Vector3(device.position.x, 0.015, -device.position.y));
        if (points.length > 12) points.shift();
        if (!model.userData.trail) {
          model.userData.trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: workshop.colors.blue, transparent: true, opacity: 0.45 }));
          workshop.root.add(model.userData.trail);
        }
        model.userData.trail.geometry.dispose();
        model.userData.trail.geometry = new THREE.BufferGeometry().setFromPoints(points);
      }
    }
    model.position.set(device.position.x, 0, -device.position.y);
    model.rotation.y = (device.position.yaw || 0) * Math.PI / 180;
    const color = !device.online ? workshop.colors.muted
      : device.health?.level === 'bad' || device.status === 'down' ? workshop.colors.danger
        : device.health?.level === 'attention' || device.status === 'idle' ? workshop.colors.warning : workshop.colors.success;
    model.userData.beacon.material.color.set(color);
    model.userData.beacon.material.emissive.set(color);
    model.userData.beacon.material.emissiveIntensity = 0.6;
    model.userData.selection.visible = selectedId === device.id;
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

export function disposeWorkshop(workshop) {
  release(workshop.root);
  workshop.devices.clear();
}
