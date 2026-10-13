"""FJSP 车间虚拟机床：Agnes MHS 设备（默认 M-03，可一次拉起整个车间）。

    cd agnes-harness/packages/mhs/python
    uv run python ../../../mhs-devices/machine-m03.py ws://127.0.0.1:4180
    # 车间模式：一次接入多台机床（与业务系统设备清单 M-01~M-08 对齐），可追加 AGV-01
    uv run python ../../../mhs-devices/machine-m03.py ws://127.0.0.1:4180 M-01 M-02 M-03 M-04 M-05 M-06 M-07 M-08 AGV-01

模拟 CNC 机床：持续上报温度/振动/主轴负载（values 数据源），状态里维护
运行状态与当前任务，并把"状态面板画面"作为 image 数据源推送（状态灯 + 温度曲线，
相当于车间摄像头，对应官方火星基地案例的相机画面）。所有机床声明 placement
（localization=fixed，两排面对面朝向中间通道），落在共享的 workshop 车间地图上，
并各自携带同一份 grid 数据源（车间平面图：墙体与出入口），工作台 World 页据此画出
车间地面。AGV-01 是移动设备（localization=self），沿中间通道在上料区与检验区之间
往返，通过 pose 数据源实时上报位姿。工作台 Devices 面板显示车间布局与设备点位，
对应火星基地案例的世界地图。

默认健康运行；M-03 是约定的故障演示机：注入故障后温度爬升越过告警阈值、状态变
down，Agent 侧的 watch_device 条件成立即被唤醒，走 fjsp-dispatch 处置流程。

故障注入（仅 M-03，进程运行中任选其一）：
    kill -USR1 <pid>          # 立即开始故障序列
    touch /tmp/m03-fault      # 下一次循环检测到该文件即注入
恢复：kill -USR2 <pid>（或重启进程）。

panel 画面数据源依赖 Pillow（pip install pillow）；未安装时跳过该数据源，其余功能不受影响。

通过 mhs-check 的 Core / Perception / Streaming profile（单机 M-03 模式）：
    uv run python -m agnes_mhs.check --profile core,perception,streaming --no-motion
"""

from __future__ import annotations

import asyncio
import io
import math
import os
import signal
import sys
import time
from collections import deque
from typing import Any

from agnes_mhs import Device

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # 未安装 Pillow：不提供 panel 画面数据源
    Image = None

FAULT_MACHINE = "M-03"  # 约定的故障演示机
FAULT_TRIGGER_FILE = "/tmp/m03-fault"

# 故障序列参数：注入后经过 RAMP_SECONDS 温度从正常爬升到峰值
FAULT_RAMP_SECONDS = 20.0
TEMP_FAULT_PEAK = 96.0

# 车间地图：20m x 10m，机床两排布置；所有设备声明同一份定义（MAP-2：同名地图必须一致）。
# 区域用多边形（points）声明，工作台画成描边分区，设备坐标落入区域时自动标注区域名。
WORKSHOP_MAP = {
    "id": "workshop",
    "name": "一号车间",
    "bounds": [0, 0, 20, 10],
    "places": [
        {"id": "loading", "name": "上料区", "points": [[0, 0], [2.2, 0], [2.2, 10], [0, 10]]},
        {"id": "machining", "name": "加工区", "points": [[2.2, 0], [17.8, 0], [17.8, 10], [2.2, 10]]},
        {"id": "inspection", "name": "检验区", "points": [[17.8, 0], [20, 0], [20, 10], [17.8, 10]]},
    ],
}

# 车间平面图（grid 数据源）：PNG 灰度图，>200 为可通行地面、<60 为墙体；
# origin 是图片左下角的世界坐标，第 0 行像素对应地图最上方（y=10）。
GRID_RES = 0.05  # 米/像素，20m x 10m → 400x200
GRID_W, GRID_H = int(20 / GRID_RES), int(10 / GRID_RES)
WALL = 0.2  # 墙厚（米）


def render_grid() -> bytes:
    """车间平面图：外墙在左右两端留出 3m 宽的出入口，分区隔墙与 places 对齐、中间留通道口。"""
    img = Image.new("L", (GRID_W, GRID_H), 255)
    d = ImageDraw.Draw(img)

    def wall(x0: float, y0: float, x1: float, y1: float) -> None:
        d.rectangle(
            [int(x0 / GRID_RES), GRID_H - int(y1 / GRID_RES),
             int(x1 / GRID_RES), GRID_H - int(y0 / GRID_RES)],
            fill=0,
        )

    wall(0, 0, 20, WALL)                # 下墙
    wall(0, 10 - WALL, 20, 10)          # 上墙
    wall(0, 0, WALL, 3.5)               # 左墙下段（上料区入口开在 y 3.5~6.5）
    wall(0, 6.5, WALL, 10)              # 左墙上段
    wall(20 - WALL, 0, 20, 3.5)         # 右墙下段（检验区出口开在 y 3.5~6.5）
    wall(20 - WALL, 6.5, 20, 10)        # 右墙上段
    for wx in (2.2, 17.8):              # 分区隔墙，通道口对齐外墙出入口
        wall(wx - WALL / 2, 0, wx + WALL / 2, 3.5)
        wall(wx - WALL / 2, 6.5, wx + WALL / 2, 10)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


WORKSHOP_GRID = render_grid() if Image is not None else None

# panel 画面：640x360，温度曲线窗口覆盖 TEMP_HIST_MAX 个采样点
PANEL_W, PANEL_H = 640, 360
TEMP_HIST_MAX = 240  # 10 Hz 采样，约 24 秒，覆盖完整故障爬升过程

_FONT_PATHS = (
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
)
_FONTS: dict[str, Any] | None = None


def _fonts() -> dict[str, Any]:
    """面板字体：优先 macOS 中文字体（标签用中文），否则回退 Pillow 内置字体（英文标签）。"""
    global _FONTS
    if _FONTS is not None:
        return _FONTS
    for path in _FONT_PATHS:
        try:
            _FONTS = {
                "cjk": True,
                "huge": ImageFont.truetype(path, 64),
                "big": ImageFont.truetype(path, 30),
                "label": ImageFont.truetype(path, 18),
                "small": ImageFont.truetype(path, 14),
            }
            return _FONTS
        except OSError:
            continue
    def default(size: int) -> Any:
        try:
            return ImageFont.load_default(size)
        except TypeError:  # Pillow < 10.1 的 load_default 不支持 size
            return ImageFont.load_default()
    _FONTS = {"cjk": False, "huge": default(64), "big": default(30), "label": default(18), "small": default(14)}
    return _FONTS


def render_panel(title: str, hist: "deque[float]", vib: float, state: dict[str, Any]) -> bytes:
    """把当前状态渲染成一帧 640x360 JPEG：状态灯、大字温度、阈值线 + 温度曲线、负载条。"""
    fonts = _fonts()
    zh = fonts["cjk"]
    status_text = {"running": "运行中", "idle": "空闲", "down": "故障停机"} if zh else {"running": "RUNNING", "idle": "IDLE", "down": "DOWN"}
    label = (
        {"temp": "主轴温度", "vib": "振动", "load": "主轴负载", "job": "当前任务"}
        if zh else
        {"temp": "SPINDLE TEMP", "vib": "VIBRATION", "load": "SPINDLE LOAD", "job": "JOB"}
    )

    img = Image.new("RGB", (PANEL_W, PANEL_H), (14, 18, 26))
    d = ImageDraw.Draw(img)
    dim = (140, 148, 160)
    status = str(state.get("status") or "idle")
    color = {"running": (64, 200, 120), "idle": (230, 190, 70), "down": (235, 75, 75)}.get(status, dim)

    d.ellipse([24, 22, 60, 58], fill=color)
    d.text((76, 24), status_text.get(status, status), font=fonts["big"], fill=color)
    d.text((76, 62), title, font=fonts["small"], fill=dim)
    d.text((PANEL_W - 24, 28), time.strftime("%H:%M:%S"), font=fonts["small"], fill=dim, anchor="ra")

    temp = hist[-1] if hist else 0.0
    temp_color = (235, 75, 75) if temp >= 85 else (230, 190, 70) if temp >= 75 else (220, 226, 235)
    d.text((24, 92), label["temp"], font=fonts["label"], fill=dim)
    d.text((24, 116), f"{temp:.1f}°C", font=fonts["huge"], fill=temp_color)

    d.text((360, 92), label["vib"], font=fonts["label"], fill=dim)
    d.text((360, 116), f"{vib:.2f} mm/s", font=fonts["big"], fill=(220, 226, 235))
    d.text((360, 160), label["load"], font=fonts["label"], fill=dim)
    load = max(0, min(120, int(state.get("spindle_load") or 0)))
    d.rectangle([360, 186, PANEL_W - 24, 202], outline=(60, 66, 78))
    if load:
        d.rectangle([361, 187, 360 + (PANEL_W - 25 - 360) * load // 120, 201], fill=color)

    # 温度曲线：30..100 °C 映射到绘图区，画出 75/85 °C 两条告警阈值虚线
    top, bot = 226.0, 322.0
    lo, hi = 30.0, 100.0

    def ty(t: float) -> float:
        return bot - (min(max(t, lo), hi) - lo) / (hi - lo) * (bot - top)

    d.rectangle([24, top, PANEL_W - 24, bot], outline=(60, 66, 78))
    for thr, c in ((75, (120, 105, 45)), (85, (130, 50, 50))):
        y = ty(thr)
        for x in range(24, PANEL_W - 28, 8):
            d.line([x, y, x + 4, y], fill=c)
    if len(hist) > 1:
        dx = (PANEL_W - 48) / (TEMP_HIST_MAX - 1)
        pts = [(PANEL_W - 24 - (len(hist) - 1 - i) * dx, ty(t)) for i, t in enumerate(hist)]
        d.line(pts, fill=(90, 160, 235), width=2)

    job = state.get("current_job") or "—"
    d.text((24, 332), f"{label['job']}: {job}", font=fonts["label"], fill=(220, 226, 235))

    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=80)
    return buf.getvalue()


def make_machine(code: str, index: int) -> tuple[Device, "MachineSim"]:
    """一台机床：两排布置（每排 4 台），placement 落在共享的 workshop 地图上。"""
    x = 2.5 + (index % 4) * 5.0
    y = 2.5 + (index // 4) * 5.0
    yaw = 90 if index < 4 else 270  # 两排机床面对面朝向中间通道（yaw 逆时针，0 朝东）
    dev = Device(
        f"cnc-{code.lower().replace('-', '')}",  # M-03 → cnc-m03（与 fjsp-dispatch skill 的映射约定一致）
        "machine",
        name=f"CNC 机床 {code}",
        model="FJSP-SIM VMC-850",
        localization="fixed",  # 固定安装设备：placement 才会被 Hub 转成地图上的位置（REG-4）
        state={
            "status": {"type": "string", "enum": ["running", "idle", "down"], "description": "运行状态"},
            "current_job": {"type": "string", "description": "当前加工任务号"},
            "spindle_load": {"type": "integer", "unit": "%", "min": 0, "max": 120, "description": "主轴负载"},
        },
        maps=[WORKSHOP_MAP],
        placement={"map": "workshop", "x": x, "y": y, "yaw": yaw},
        ui={"primary": "panel"} if Image is not None else None,
    )
    sim = MachineSim(dev, code, index)
    return dev, sim


class MachineSim:
    def __init__(self, dev: Device, code: str, index: int) -> None:
        self.dev = dev
        self.code = code
        # 每台机床略有不同的健康基线，车间画面才有区分度；M-03 保持既有演示参数
        self.temp_base = 42.0 if code == FAULT_MACHINE else 38.0 + index
        self.rpm_base = 8000 + index * 120
        self.load_base = 63 if code == FAULT_MACHINE else min(90, 45 + index * 4)
        self.job = f"OP-2026-{1010 + index}"
        self.faulted = False
        self.fault_at = 0.0
        self.temp_hist: deque[float] = deque(maxlen=TEMP_HIST_MAX)
        self.panel = None
        self.grid = None
        if Image is not None:
            self.panel = dev.source(
                "panel",
                "image",
                "机床状态面板画面（状态灯 + 温度曲线）",
                mime="image/jpeg",
                hz=1,
                size=[PANEL_W, PANEL_H],
                fov_deg=[60, 34],
                mount={"xyz": [0.5, 0.0, 0.8], "rpy": [0, 0, 0]},
            )
            # 车间平面图：所有机床声明同一份，World 页取其中一台的作为地面底图
            self.grid = dev.source("grid", "grid", "车间平面图（墙体与出入口）", hz=0.2,
                                   model={"name": "fjsp-sim-layout", "version": "1"})
        self.metrics = dev.source(
            "metrics",
            "values",
            "主轴温度与振动",
            hz=2,
            default=True,
            fields={
                "temperature": {"type": "number", "unit": "°C", "min": 0, "max": 120, "role": "temperature", "alert": {"warn": 75, "bad": 85}},
                "vibration": {"type": "number", "unit": "x_mm_per_s", "min": 0, "max": 50, "alert": {"warn": 7, "bad": 12}},
                "spindle_rpm": {"type": "integer", "unit": "x_rpm", "min": 0, "max": 12000},
            },
        )
        self.dev.update(status="running", current_job=self.job, spindle_load=self.load_base)

    def inject_fault(self) -> None:
        if not self.faulted:
            self.faulted = True
            self.fault_at = time.time()
            print(f"[{self.code.lower()}] 故障注入：主轴过热序列开始", flush=True)

    def recover(self) -> None:
        if self.faulted:
            self.faulted = False
            self.dev.update(status="running", current_job=self.job, spindle_load=self.load_base)
            print(f"[{self.code.lower()}] 已恢复正常运行", flush=True)

    async def run(self) -> None:
        while True:
            now = time.time()
            if not self.faulted and self.code == FAULT_MACHINE and os.path.exists(FAULT_TRIGGER_FILE):
                try:
                    os.remove(FAULT_TRIGGER_FILE)
                except OSError:
                    pass
                self.inject_fault()

            if self.faulted:
                ramp = min(1.0, (now - self.fault_at) / FAULT_RAMP_SECONDS)
                temp = self.temp_base + (TEMP_FAULT_PEAK - self.temp_base) * ramp + math.sin(now * 3)
                vib = 2.0 + 13.0 * ramp + math.sin(now * 5)
                rpm = int(self.rpm_base * (1 - 0.7 * ramp))
                if ramp >= 1.0 and self.dev.state.get("status") != "down":
                    self.dev.update(status="down", current_job="", spindle_load=0)
                    print(f"[{self.code.lower()}] 温度越限，机床停机 status=down", flush=True)
                elif ramp < 1.0:
                    self.dev.update(spindle_load=max(0, int(self.load_base * (1 - ramp))))
            else:
                temp = self.temp_base + 2 * math.sin(now / 30)
                vib = 1.8 + 0.4 * math.sin(now / 7)
                rpm = self.rpm_base + int(200 * math.sin(now / 11))

            if self.metrics.wants():
                self.metrics.send({
                    "temperature": round(temp, 2),
                    "vibration": round(vib, 2),
                    "spindle_rpm": rpm,
                })
            self.temp_hist.append(round(temp, 2))
            if self.panel is not None and self.panel.wants():
                self.panel.send({"w": PANEL_W, "h": PANEL_H},
                                render_panel(f"CNC {self.code} · FJSP-SIM VMC-850", self.temp_hist, vib, self.dev.state))
            if self.grid is not None and self.grid.wants():
                self.grid.send({"id": "workshop", "resolution": GRID_RES, "origin": [0, 0]}, WORKSHOP_GRID)
            await asyncio.sleep(0.1)


def make_agv(code: str) -> tuple[Device, "AgvSim"]:
    """一台 AGV 搬运车：移动设备（localization=self），位姿由 pose 数据源实时上报。"""
    dev = Device(
        code.lower(),  # AGV-01 → agv-01
        "agv",
        name=f"AGV 搬运车 {code}",
        model="FJSP-SIM AGV-500",
        mobile=True,
        radius=0.4,
        localization="self",
        maps=[WORKSHOP_MAP],
        state={
            "status": {"type": "string", "enum": ["running", "idle"], "description": "运行状态"},
            "current_job": {"type": "string", "description": "当前搬运任务号"},
        },
    )
    return dev, AgvSim(dev, code)


class AgvSim:
    """沿中间通道（y=5）在上料区与检验区之间往返，5 Hz 上报位姿；到端点后掉头。"""

    SPEED = 1.2  # m/s
    X0, X1, Y = 1.1, 18.9, 5.0  # 通道中线，两端分别是上料区/检验区的中心

    def __init__(self, dev: Device, code: str) -> None:
        self.dev = dev
        self.code = code
        self.pose = dev.source("pose", "pose", "AGV 在车间地图上的实时位姿", hz=5, max_error_m=0.1,
                               model={"name": "fjsp-sim-truth", "version": "1"})
        self.dev.update(status="running", current_job="TR-2026-0301")

    async def run(self) -> None:
        x, direction = self.X0, 1
        while True:
            x += direction * self.SPEED * 0.1
            if x >= self.X1:
                x, direction = self.X1, -1
            elif x <= self.X0:
                x, direction = self.X0, 1
            if self.pose.wants():
                self.pose.send({
                    "map": "workshop",
                    "x": round(x, 3),
                    "y": self.Y,
                    "yaw": 0 if direction > 0 else 180,
                    "ok": True,
                })
            await asyncio.sleep(0.1)


async def main(url: str, codes: list[str]) -> None:
    sims = []
    for i, code in enumerate(codes):
        if code.upper().startswith("AGV"):
            dev, sim = make_agv(code.upper())
        else:
            dev, sim = make_machine(code, i)
        sims.append(sim)

    fault_sim = next((s for s in sims if s.code == FAULT_MACHINE), None)
    if fault_sim is not None:
        loop = asyncio.get_running_loop()
        loop.add_signal_handler(signal.SIGUSR1, fault_sim.inject_fault)
        loop.add_signal_handler(signal.SIGUSR2, fault_sim.recover)

    ticking = [asyncio.ensure_future(s.run()) for s in sims]
    try:
        await asyncio.gather(*(s.dev.run(url) for s in sims))
    finally:
        for t in ticking:
            t.cancel()


if __name__ == "__main__":
    hub_url = sys.argv[1] if len(sys.argv) > 1 else "ws://127.0.0.1:4180"
    machine_codes = sys.argv[2:] or [FAULT_MACHINE]
    asyncio.run(main(hub_url, machine_codes))
