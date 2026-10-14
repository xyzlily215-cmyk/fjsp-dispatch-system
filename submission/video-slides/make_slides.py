#!/usr/bin/env python3
"""Generate the 1920x1080 opening and closing frames for the demo video."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


W, H = 1920, 1080
OUT_DIR = Path(__file__).resolve().parent
FONT_CN = "/System/Library/Fonts/Hiragino Sans GB.ttc"
FONT_LATIN = "/System/Library/Fonts/HelveticaNeue.ttc"

PAPER = "#F2F5F3"
INK = "#17282A"
MUTED = "#56696A"
RULE = "#CBD8D3"
TEAL = "#087D73"
PALE_TEAL = "#B9DCD1"
CORAL = "#DF5C43"
MINT = "#9DDCC9"


def cn(size, bold=False):
    return ImageFont.truetype(FONT_CN, size, index=1 if bold else 0)


def latin(size):
    return ImageFont.truetype(FONT_LATIN, size)


def text(d, xy, value, size, color, bold=False, anchor="lt"):
    d.text(xy, value, font=cn(size, bold), fill=color, anchor=anchor)


def mark(d, x, y, inverse=False):
    color = MINT if inverse else TEAL
    background = INK if inverse else PAPER
    d.rectangle((x, y, x + 38, y + 38), fill=color)
    d.rectangle((x + 10, y + 10, x + 28, y + 28), fill=background)
    d.rectangle((x + 22, y + 22, x + 38, y + 38), fill=color)


def header(d, dark=False):
    foreground = PAPER if dark else INK
    secondary = MINT if dark else MUTED
    rule = "#3C5755" if dark else RULE
    mark(d, 120, 89, inverse=dark)
    d.text((176, 92), "FJSP / AGH", font=latin(29), fill=foreground, anchor="lt")
    text(d, (1800, 96), "本科生组  /  U019", 27, secondary, anchor="rt")
    d.line((120, 159, 1800, 159), fill=rule, width=2)


def opening_schedule(d):
    # A deliberately unnumbered scheduling motif, not a result from the demo.
    d.line((120, 606, 1800, 606), fill=RULE, width=2)
    text(d, (120, 622), "事件驱动排程", 28, INK, bold=True)
    text(d, (1800, 628), "概念示意", 23, MUTED, anchor="rt")

    for x in (410, 640, 870, 1100, 1330, 1560, 1790):
        d.line((x, 688, x, 860), fill="#DDE6E1", width=2)

    rows = [
        (694, "M-01", [(410, 653, TEAL), (688, 1020, PALE_TEAL), (1178, 1522, TEAL)]),
        (762, "M-03", [(476, 826, PALE_TEAL), (862, 1052, CORAL), (1162, 1427, TEAL)]),
        (830, "M-05", [(410, 730, TEAL), (770, 1132, PALE_TEAL), (1190, 1717, TEAL)]),
    ]
    for y, machine, bars in rows:
        d.text((120, y - 3), machine, font=latin(30), fill=MUTED, anchor="lt")
        d.line((410, y + 38, 1800, y + 38), fill=RULE, width=2)
        for left, right, color in bars:
            d.rounded_rectangle((left, y, right, y + 28), radius=4, fill=color)

    d.line((1085, 683, 1085, 860), fill=CORAL, width=3)
    d.ellipse((1077, 676, 1093, 692), fill=CORAL)


def opening():
    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)
    header(d)

    d.rectangle((120, 237, 128, 470), fill=TEAL)
    text(d, (163, 226), "动态柔性车间", 95, INK, bold=True)
    text(d, (163, 350), "生产调度与仿真决策系统", 89, INK, bold=True)
    text(d, (163, 506), "AGH 智能体驱动的调度与异常处置", 34, MUTED)

    opening_schedule(d)

    d.line((120, 927, 1800, 927), fill=RULE, width=2)
    text(d, (120, 969), "熊英孜", 32, INK)
    d.text((1800, 976), "PROJECT DEMO  /  2026", font=latin(28), fill=TEAL, anchor="rt")
    img.save(OUT_DIR / "01-开头标题页.png")


def ending():
    img = Image.new("RGB", (W, H), INK)
    d = ImageDraw.Draw(img)
    header(d, dark=True)

    d.rectangle((120, 241, 128, 510), fill=MINT)
    text(d, (164, 225), "从设备告警，", 112, PAPER, bold=True)
    text(d, (164, 367), "到计划发布。", 112, PAPER, bold=True)
    text(d, (165, 550), "每一步有据可查。", 43, MINT)

    # These are chapter labels; the film itself supplies the actual evidence.
    d.line((133, 737, 1780, 737), fill="#49635E", width=3)
    steps = [
        (166, "01", "设备告警"),
        (654, "02", "约束重排"),
        (1142, "03", "人工审核"),
        (1630, "04", "计划发布"),
    ]
    for i, (x, number, name) in enumerate(steps):
        d.ellipse((x - 11, 726, x + 11, 748), fill=CORAL if i == 0 else MINT)
        d.text((x - 12, 676), number, font=latin(28), fill=MINT, anchor="lt")
        text(d, (x - 12, 772), name, 31, PAPER)

    d.line((120, 927, 1800, 927), fill="#49635E", width=2)
    d.text((120, 968), "github.com/xyzlily215-cmyk/fjsp-dispatch-system",
           font=latin(35), fill=PAPER, anchor="lt")
    text(d, (1800, 975), "源码与复现说明", 27, MINT, anchor="rt")
    img.save(OUT_DIR / "02-结尾页.png")


if __name__ == "__main__":
    opening()
    ending()
    print("Generated two 1920x1080 video slides")
