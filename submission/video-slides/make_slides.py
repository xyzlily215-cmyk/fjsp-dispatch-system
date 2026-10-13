#!/usr/bin/env python3
"""生成演示视频的开头标题页与结尾页（1920x1080 PNG）。"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1920, 1080
OUT_DIR = os.path.dirname(os.path.abspath(__file__))

FONT_GB = "/System/Library/Fonts/Hiragino Sans GB.ttc"  # index 0=W3, 1=W6


def font(size, bold=False):
    return ImageFont.truetype(FONT_GB, size, index=1 if bold else 0)


# ---------- 背景 ----------

def make_bg():
    # 竖向深蓝渐变
    base = Image.new("RGB", (W, H))
    px = base.load()
    top, bottom = (8, 14, 34), (14, 30, 74)
    for y in range(H):
        t = y / (H - 1)
        row = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(W):
            px[x, y] = row
    base = base.convert("RGBA")

    # 中央偏上的蓝色光晕
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([W / 2 - 700, 140, W / 2 + 700, 940], fill=(48, 110, 220, 90))
    glow = glow.filter(ImageFilter.GaussianBlur(220))
    base.alpha_composite(glow)

    # 细网格
    grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gr = ImageDraw.Draw(grid)
    for x in range(0, W + 1, 96):
        gr.line([(x, 0), (x, H)], fill=(140, 180, 240, 10))
    for y in range(0, H + 1, 96):
        gr.line([(0, y), (W, y)], fill=(140, 180, 240, 10))
    base.alpha_composite(grid)

    # 底部甘特条装饰（呼应排程主题）
    gantt = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gt = ImageDraw.Draw(gantt)
    rows = [
        (970, [(120, 420), (520, 760), (900, 1180), (1300, 1560)]),
        (1002, [(260, 560), (660, 940), (1060, 1340), (1460, 1800)]),
        (1034, [(80, 300), (420, 700), (820, 1160), (1260, 1480), (1560, 1860)]),
    ]
    palette = [(56, 130, 246, 38), (34, 190, 200, 32), (120, 160, 255, 30)]
    for i, (y, bars) in enumerate(rows):
        for j, (x0, x1) in enumerate(bars):
            gt.rounded_rectangle([x0, y, x1, y + 16], radius=8,
                                 fill=palette[(i + j) % 3])
    base.alpha_composite(gantt)

    # 四角暗角
    mask = Image.new("L", (W, H), 0)
    md = ImageDraw.Draw(mask)
    md.ellipse([-W * 0.25, -H * 0.35, W * 1.25, H * 1.35], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(180))
    dark = Image.new("RGBA", (W, H), (0, 0, 0, 110))
    base = Image.composite(base, Image.alpha_composite(base, dark), mask)

    d = ImageDraw.Draw(base)

    # 四角括号装饰线
    m, ln, w_, col = 56, 72, 3, (96, 165, 250, 130)
    for sx, sy, dx, dy in [(m, m, 1, 1), (W - m, m, -1, 1),
                           (m, H - m, 1, -1), (W - m, H - m, -1, -1)]:
        d.line([(sx, sy), (sx + dx * ln, sy)], fill=col, width=w_)
        d.line([(sx, sy), (sx, sy + dy * ln)], fill=col, width=w_)

    return base, d


# ---------- 文字工具 ----------

def text_center(d, cx, cy, text, f, fill, shadow=True):
    if shadow:
        d.text((cx, cy + 3), text, font=f, fill=(0, 0, 0, 70),
               anchor="mm")
    d.text((cx, cy), text, font=f, fill=fill, anchor="mm")


def text_spaced(d, cx, cy, text, f, fill, spacing):
    widths = [d.textlength(ch, font=f) for ch in text]
    total = sum(widths) + spacing * (len(text) - 1)
    x = cx - total / 2
    for ch, w in zip(text, widths):
        d.text((x, cy), ch, font=f, fill=fill, anchor="lm")
        x += w + spacing


def accent_bar(d, cx, y, width=560, height=6):
    x0 = int(cx - width / 2)
    c0, c1 = (34, 190, 200), (88, 140, 255)
    for i in range(width):
        t = i / max(width - 1, 1)
        col = tuple(int(c0[k] + (c1[k] - c0[k]) * t) for k in range(3))
        d.line([(x0 + i, y), (x0 + i, y + height)], fill=col)
    d.rounded_rectangle([x0, y, x0 + width, y + height],
                        radius=height // 2, outline=None)


def badge(d, cx, cy, text, f):
    pad_x, pad_y = 34, 14
    tw = d.textlength(text, font=f)
    th = f.size
    x0, y0 = cx - tw / 2 - pad_x, cy - th / 2 - pad_y
    x1, y1 = cx + tw / 2 + pad_x, cy + th / 2 + pad_y
    d.rounded_rectangle([x0, y0, x1, y1], radius=(y1 - y0) / 2,
                        outline=(110, 175, 250, 160), width=2,
                        fill=(30, 60, 120, 90))
    d.text((cx, cy - 2), text, font=f, fill=(170, 205, 250), anchor="mm")


# ---------- 两张页面 ----------

def opening():
    img, d = make_bg()
    cx = W / 2

    badge(d, cx, 218, "作 品 演 示 视 频", font(34))

    text_spaced(d, cx, 300, "AGH AGENT-DRIVEN FJSP SCHEDULING & SIMULATION",
                font(26), (110, 160, 225), 6)

    text_center(d, cx, 492, "动态柔性车间生产调度", font(104, bold=True),
                (255, 255, 255))
    text_center(d, cx, 636, "与仿真决策系统", font(104, bold=True),
                (255, 255, 255))

    accent_bar(d, cx, 732, width=520, height=6)

    # 参赛信息行：菱形分隔
    y = 816
    parts = ["本科生组", "U019", "暴躁的兔子", "熊英孜"]
    f = font(42)
    gap = 26
    dia = 9
    widths = [d.textlength(p, font=f) for p in parts]
    total = sum(widths) + (len(parts) - 1) * (gap * 2 + dia * 2)
    x = cx - total / 2
    for i, (p, w) in enumerate(zip(parts, widths)):
        col = (140, 200, 255) if p == "U019" else (205, 220, 242)
        d.text((x, y), p, font=f, fill=col, anchor="lm")
        x += w
        if i < len(parts) - 1:
            x += gap
            cy = y
            d.polygon([(x + dia, cy - dia), (x + 2 * dia, cy),
                       (x + dia, cy + dia), (x, cy)],
                      fill=(90, 150, 235, 200))
            x += dia * 2 + gap

    img.convert("RGB").save(os.path.join(OUT_DIR, "01-开头标题页.png"))


def ending():
    img, d = make_bg()
    cx = W / 2

    text_spaced(d, cx, 250, "THANKS FOR WATCHING", font(28),
                (110, 160, 225), 10)

    text_center(d, cx, 400, "感谢各位评委", font(112, bold=True),
                (255, 255, 255))

    accent_bar(d, cx, 506, width=420, height=6)

    text_center(d, cx, 592, "代码已开源，欢迎复核", font(46, bold=False),
                (200, 216, 240), shadow=False)

    # 仓库地址卡片
    url = "github.com/xyzlily215-cmyk/fjsp-dispatch-system"
    f_url = font(44, bold=True)
    tw = d.textlength(url, font=f_url)
    card_w, card_h = int(tw) + 150, 116
    x0, y0 = cx - card_w / 2, 668
    x1, y1 = cx + card_w / 2, 668 + card_h
    # 卡片微投影
    d.rounded_rectangle([x0 + 4, y0 + 8, x1 + 4, y1 + 8], radius=24,
                        fill=(0, 0, 0, 90))
    d.rounded_rectangle([x0, y0, x1, y1], radius=24, fill=(238, 244, 253))
    d.ellipse([x0 + 42, y0 + card_h / 2 - 9, x0 + 60, y0 + card_h / 2 + 9],
              fill=(34, 190, 200))
    d.text((cx + 14, y0 + card_h / 2 - 2), url, font=f_url,
           fill=(18, 42, 88), anchor="mm")

    text_center(d, cx, 878, "完整复现说明见提交包《03 可运行作品与复现说明》",
                font(38), (160, 190, 228), shadow=False)

    img.convert("RGB").save(os.path.join(OUT_DIR, "02-结尾页.png"))


if __name__ == "__main__":
    opening()
    ending()
    print("done")
