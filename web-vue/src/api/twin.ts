/* 数字孪生（MHS 设备）访问层：经 agent-bff 的 AgnesHub 代理。 */
import { AGENT_API_BASE } from './agent';

/** 设备健康摘要（AgnesHub 计算） */
export interface DeviceHealth {
  level: 'ok' | 'attention' | 'bad';
  reasons: string[];
}

export interface DeviceMetrics {
  temperature: number | null;
  vibration: number | null;
  spindleRpm: number | null;
  time?: number | null;
}

export interface DevicePosition {
  trust: string;
  map: string;
  x: number;
  y: number;
  yaw: number;
  fixed?: boolean;
  zone?: string;
  age?: number;
}

export interface TwinDevice {
  id: string;
  kind: 'machine' | 'agv' | string;
  name: string;
  model?: string;
  online: boolean;
  available: boolean;
  status: 'running' | 'idle' | 'down' | null;
  currentJob: string | null;
  spindleLoad: number | null;
  health: DeviceHealth;
  position: DevicePosition | null;
  metrics: DeviceMetrics | null;
}

export interface TwinWorld {
  map: string;
  name: string;
  bounds: [number, number, number, number];
  places: { id: string; name?: string; points?: [number, number][] }[];
  entities: unknown[];
}

export interface SimStatus {
  running: boolean;
  pids?: number[];
  managed?: boolean;
}

export interface TwinSnapshot {
  hub: 'connected' | 'connecting' | 'unavailable';
  time: number;
  devices: TwinDevice[];
  world: TwinWorld | null;
  sim: SimStatus | null;
}

export function twinSnapshot(): Promise<TwinSnapshot> {
  return fetch(AGENT_API_BASE + '/twin/snapshot')
    .then((r) => r.json())
    .catch(() => ({ hub: 'unavailable', time: 0, devices: [], world: null, sim: null }) as TwinSnapshot);
}

/* SSE 1Hz 设备快照流；返回关闭函数。 */
export function openTwinStream(onSnapshot: (snap: TwinSnapshot) => void): () => void {
  const source = new EventSource(`${AGENT_API_BASE}/twin/stream`);
  source.addEventListener('twin', (ev) => {
    try { onSnapshot(JSON.parse((ev as MessageEvent).data)); } catch { /* 忽略坏帧 */ }
  });
  return () => source.close();
}

export function twinPanelUrl(deviceId: string, ts?: number): string {
  return `${AGENT_API_BASE}/twin/device/${encodeURIComponent(deviceId)}/panel${ts ? `?t=${ts}` : ''}`;
}

export function twinGridUrl(): string {
  return `${AGENT_API_BASE}/twin/grid`;
}

function postAction(path: string) {
  return fetch(AGENT_API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }).then((r) => r.json());
}

export function twinInjectFault(deviceId: string) {
  return postAction(`/twin/device/${encodeURIComponent(deviceId)}/fault`);
}

export function twinRecover(deviceId: string) {
  return postAction(`/twin/device/${encodeURIComponent(deviceId)}/recover`);
}

export function twinSimStart() {
  return postAction('/twin/sim/start');
}

export function twinSimStop() {
  return postAction('/twin/sim/stop');
}
