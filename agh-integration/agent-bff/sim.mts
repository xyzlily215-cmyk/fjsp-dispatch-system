// sim: lifecycle control of the MHS virtual-workshop process (machine-m03.py),
// so the demo no longer needs shell scripts — the twin page buttons call these.
// The device process is whoever is running `machine-m03.py` (start-demo.sh or us);
// we locate it with pgrep and drive fault/recover via its SIGUSR1/SIGUSR2 handlers.
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const MHS_DIR = new URL('../mhs-devices/', import.meta.url).pathname
const AGH_HOME = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const HUB_WS = (process.env.AGNES_HUB_URL ?? 'ws://127.0.0.1:4180/ws/hub').replace(/\/ws\/hub$/, '')
const PYTHON = `${MHS_DIR}.venv/bin/python`
const DEFAULT_MACHINES = ['M-01', 'M-02', 'M-03', 'M-04', 'M-05', 'M-06', 'M-07', 'M-08', 'AGV-01']

let child: ReturnType<typeof spawn> | null = null

async function findPids(): Promise<number[]> {
  try {
    const { stdout } = await execFileP('pgrep', ['-f', 'machine-m03.py'])
    return stdout.split('\n').map((s) => Number(s.trim())).filter((n) => n > 0)
  } catch {
    return []
  }
}

export async function simStatus() {
  const pids = await findPids()
  return { running: pids.length > 0, pids, managed: child !== null }
}

export async function simStart(machines?: string[]) {
  const pids = await findPids()
  if (pids.length > 0) return { started: false, reason: 'already_running', pids }
  const list = machines?.length ? machines : DEFAULT_MACHINES
  const { openSync } = await import('node:fs')
  const logFd = openSync('/tmp/mhs-sim.log', 'a')
  child = spawn(PYTHON, [`${MHS_DIR}machine-m03.py`, HUB_WS, ...list], {
    cwd: AGH_HOME,
    detached: true,
    // 与 scripts/start-demo.sh 一致：agnes_mhs 从源码树引入（未装进 .venv）
    env: { ...process.env, PYTHONPATH: 'agnes-harness/packages/mhs/python/src' },
    stdio: ['ignore', logFd, logFd],
  })
  child.on('exit', () => { child = null })
  child.unref()
  return { started: true, pid: child.pid, machines: list }
}

export async function simStop() {
  const pids = await findPids()
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  }
  child = null
  return { stopped: pids.length, pids }
}

export async function simSignal(signal: 'SIGUSR1' | 'SIGUSR2') {
  const pids = await findPids()
  if (pids.length === 0) return { signaled: false, reason: 'not_running' }
  for (const pid of pids) {
    try { process.kill(pid, signal) } catch { /* ignore */ }
  }
  return { signaled: true, signal, pids }
}
