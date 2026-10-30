// mhs: AgnesHub north-API client for the digital-twin page.
// One WebSocket to ws://<hub>/ws/hub (role ui, same as the Devices panel):
// caches device entries (hub/devices + hub/changed + hub/state) and the world
// map, polls `hub/read` for the newest metrics item per device, and proxies
// panel/grid images with short caches. Uses Node's built-in WebSocket — no deps.
const HUB_URL = process.env.AGNES_HUB_URL ?? 'ws://127.0.0.1:4180/ws/hub'
const METRICS_POLL_MS = 1000
const PANEL_CACHE_MS = 1500
const GRID_CACHE_MS = 3600_000
const RECONNECT_MS = 3000

type Json = Record<string, unknown>
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class MhsHub {
  private ws: WebSocket | null = null
  private rpcSeq = 0
  private pending = new Map<string, Pending>()
  private devices = new Map<string, Json>()
  private worlds: Json[] = []
  private metrics = new Map<string, Json>()
  private panelCache = new Map<string, { at: number; jpeg: Buffer }>()
  private gridCache: { at: number; png: Buffer; meta: Json } | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  connected = false

  start() {
    this.connect()
  }

  private connect() {
    const ws = new WebSocket(HUB_URL)
    this.ws = ws
    ws.addEventListener('open', () => {
      void (async () => {
        try {
          await this.call('hub/hello', { role: 'ui', client: { name: 'fjsp-agent-bff', version: '0.1' } })
          const [devicesRes, worldRes] = await Promise.all([
            this.call('hub/devices', {}) as Promise<{ devices?: Json[] }>,
            this.call('hub/world', {}) as Promise<{ worlds?: Json[] }>,
          ])
          this.devices.clear()
          for (const d of devicesRes.devices ?? []) this.devices.set(String(d.id), d)
          this.worlds = worldRes.worlds ?? []
          this.connected = true
          this.startPolling()
          console.log(`[mhs] hub connected: ${this.devices.size} devices, ${this.worlds.length} worlds`)
        } catch (err) {
          console.warn('[mhs] handshake failed:', err)
          ws.close()
        }
      })()
    })
    ws.addEventListener('message', (ev) => this.onMessage(String(ev.data)))
    ws.addEventListener('close', () => {
      this.connected = false
      this.ws = null
      this.stopPolling()
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('hub connection closed'))
      }
      this.pending.clear()
      setTimeout(() => this.connect(), RECONNECT_MS)
    })
    ws.addEventListener('error', () => {
      ws.close()
    })
  }

  private onMessage(raw: string) {
    let msg: Json
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof msg.id === 'string' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)))
      else p.resolve(msg.result)
      return
    }
    const method = msg.method as string | undefined
    const params = (msg.params ?? {}) as Json
    if (method === 'hub/changed') {
      for (const d of (params.devices as Json[]) ?? []) this.devices.set(String(d.id), d)
      for (const id of (params.removed as string[]) ?? []) this.devices.delete(id)
    } else if (method === 'hub/state') {
      const dev = this.devices.get(String(params.device))
      const state = dev?.state as { values?: Json } | undefined
      if (state?.values) Object.assign(state.values, params.values as Json)
    } else if (method === 'hub/world') {
      this.worlds = (params.worlds as Json[]) ?? this.worlds
    }
  }

  private call(method: string, params: Json): Promise<unknown> {
    const ws = this.ws
    if (!ws || ws.readyState !== ws.OPEN) return Promise.reject(new Error('hub not connected'))
    const id = String(++this.rpcSeq)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`hub call timeout: ${method}`))
      }, 8000)
      this.pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  private startPolling() {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => void this.pollMetrics(), METRICS_POLL_MS)
  }

  private stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  // Newest metrics item per device. `metrics` is a default-on values source, so the
  // hub already holds fresh items; hub/read never disturbs the device.
  private async pollMetrics() {
    if (!this.connected) return
    for (const id of this.devices.keys()) {
      try {
        const res = (await this.call('hub/read', { device: id, sources: ['metrics'] })) as { items?: Json[] }
        const item = res.items?.[0]
        if (item && !item.error) this.metrics.set(id, item)
      } catch {
        /* device may have no metrics source (AGV) — skip */
      }
    }
  }

  private async readImage(device: string, source: string): Promise<{ b64: string; mime: string; meta: Json } | null> {
    const res = (await this.call('hub/read', { device, sources: [source] })) as { items?: Json[] }
    const item = res.items?.[0]
    if (!item || item.error || typeof item.b64 !== 'string') return null
    return { b64: item.b64, mime: String(item.mime ?? 'image/jpeg'), meta: (item.data as Json) ?? {} }
  }

  async panel(device: string): Promise<Buffer | null> {
    const hit = this.panelCache.get(device)
    if (hit && Date.now() - hit.at < PANEL_CACHE_MS) return hit.jpeg
    const img = await this.readImage(device, 'panel').catch(() => null)
    if (!img) return hit?.jpeg ?? null
    const jpeg = Buffer.from(img.b64, 'base64')
    this.panelCache.set(device, { at: Date.now(), jpeg })
    return jpeg
  }

  async grid(): Promise<{ png: Buffer; meta: Json } | null> {
    if (this.gridCache && Date.now() - this.gridCache.at < GRID_CACHE_MS) return this.gridCache
    const first = [...this.devices.keys()].find((id) => id.startsWith('cnc-'))
    if (!first) return this.gridCache
    const img = await this.readImage(first, 'grid').catch(() => null)
    if (!img) return this.gridCache
    this.gridCache = { at: Date.now(), png: Buffer.from(img.b64, 'base64'), meta: img.meta }
    return this.gridCache
  }

  snapshot() {
    const devices = [...this.devices.values()].map((d) => {
      const state = (d.state as { values?: Json } | undefined)?.values ?? {}
      const m = this.metrics.get(String(d.id))
      const mData = (m?.data ?? m) as Json | undefined
      return {
        id: d.id,
        kind: d.kind,
        name: d.name,
        model: d.model,
        online: !!d.online,
        available: !!d.available,
        status: state.status ?? null,
        currentJob: state.current_job ?? null,
        spindleLoad: state.spindle_load ?? null,
        health: d.health ?? { level: 'ok', reasons: [] },
        position: d.position ?? null,
        metrics: mData
          ? {
              temperature: mData.temperature ?? null,
              vibration: mData.vibration ?? null,
              spindleRpm: mData.spindle_rpm ?? null,
              time: m?.time ?? null,
            }
          : null,
      }
    })
    devices.sort((a, b) => String(a.id).localeCompare(String(b.id)))
    const world = this.worlds[0]
      ? {
          map: this.worlds[0].map,
          name: this.worlds[0].name,
          bounds: this.worlds[0].bounds,
          places: this.worlds[0].places ?? [],
          entities: this.worlds[0].entities ?? [],
        }
      : null
    return { hub: this.connected ? 'connected' : 'connecting', time: Date.now() / 1000, devices, world }
  }
}

export const mhsHub = new MhsHub()
