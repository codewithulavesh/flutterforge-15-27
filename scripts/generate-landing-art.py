#!/usr/bin/env python3
"""Generates original FlutterForge landing artwork.

Outputs brand-consistent UI mockups and editorial compositions into
public/landing-v2/. Everything is drawn locally with Pillow, so the art is
reproducible and needs no external image service.

Run:  python3 scripts/generate-landing-art.py
"""

from __future__ import annotations

import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).resolve().parents[1] / "public" / "landing-v2"

INK = (0, 16, 30)
INK_2 = (5, 22, 36)
PANEL = (9, 24, 37)
PANEL_2 = (13, 31, 45)
PANEL_3 = (18, 40, 55)
LINE = (38, 58, 72)
LIME = (197, 250, 117)
PINK = (245, 184, 232)
WHITE = (248, 255, 248)
MUTED = (116, 142, 160)
DIM = (74, 96, 112)
BLUE = (125, 211, 252)
AMBER = (252, 211, 77)
RED = (251, 113, 133)
GREEN = (52, 211, 153)

AVENIR = "/System/Library/Fonts/Avenir Next.ttc"
MONO = "/System/Library/Fonts/SFNSMono.ttf"

_WEIGHTS = {"regular": 7, "medium": 5, "demi": 2, "bold": 0, "italic": 4}


def font(size: float, weight: str = "regular", mono: bool = False) -> ImageFont.FreeTypeFont:
    if mono:
        return ImageFont.truetype(MONO, max(1, int(round(size))))
    return ImageFont.truetype(AVENIR, max(1, int(round(size))), index=_WEIGHTS[weight])


class Art:
    """Small scaled drawing surface (base coordinates, supersampled canvas)."""

    def __init__(self, width: int, height: int, scale: int = 3, bg=(0, 0, 0, 0)):
        self.scale = scale
        self.w = width
        self.h = height
        self.img = Image.new("RGBA", (width * scale, height * scale), bg)
        self.d = ImageDraw.Draw(self.img)

    def p(self, value: float) -> int:
        return int(round(value * self.scale))

    def _solid(self, color, x, y):
        """Pre-blends translucent ink against the local background.

        ImageDraw writes RGBA tuples verbatim instead of compositing them, so a
        fill of (255,255,255,8) would become a near-transparent white box. The
        art is almost entirely flat panels, so sampling the pixel beneath the
        shape gives a faithful opaque equivalent.
        """
        if not (isinstance(color, tuple) and len(color) == 4 and color[3] < 255):
            return color
        px = max(0, min(self.img.width - 1, int(x * self.scale)))
        py = max(0, min(self.img.height - 1, int(y * self.scale)))
        br, bg, bb, ba = self.img.getpixel((px, py))
        if ba == 0:
            return color  # transparent canvas: keep real alpha
        a = color[3] / 255
        return (
            int(color[0] * a + br * (1 - a)),
            int(color[1] * a + bg * (1 - a)),
            int(color[2] * a + bb * (1 - a)),
            255,
        )

    def rr(self, x, y, w, h, r=0, fill=None, outline=None, width=1):
        fill = self._solid(fill, x + w / 2, y + h / 2) if fill else None
        outline = self._solid(outline, x + w / 2, y + h / 2) if outline else None
        self.d.rounded_rectangle(
            [self.p(x), self.p(y), self.p(x + w), self.p(y + h)],
            radius=self.p(r),
            fill=fill,
            outline=outline,
            width=max(1, self.p(width)) if outline else 1,
        )

    def rect(self, x, y, w, h, fill):
        self.d.rectangle(
            [self.p(x), self.p(y), self.p(x + w), self.p(y + h)],
            fill=self._solid(fill, x + w / 2, y + h / 2),
        )

    def ellipse(self, x, y, w, h, fill=None, outline=None, width=1):
        fill = self._solid(fill, x + w / 2, y + h / 2) if fill else None
        outline = self._solid(outline, x + w / 2, y + h / 2) if outline else None
        self.d.ellipse(
            [self.p(x), self.p(y), self.p(x + w), self.p(y + h)],
            fill=fill,
            outline=outline,
            width=max(1, self.p(width)) if outline else 1,
        )

    def line(self, pts, fill, width=1):
        mx = sum(x for x, _ in pts) / len(pts)
        my = sum(y for _, y in pts) / len(pts)
        self.d.line(
            [(self.p(x), self.p(y)) for x, y in pts],
            fill=self._solid(fill, mx, my),
            width=max(1, self.p(width)),
            joint="curve",
        )

    def text(self, x, y, value, size=12, weight="regular", fill=WHITE, anchor="la", mono=False, spacing=2):
        self.d.text(
            (self.p(x), self.p(y)),
            value,
            font=font(size * self.scale, weight, mono),
            fill=self._solid(fill, x, y),
            anchor=anchor,
            spacing=self.p(spacing),
        )

    def chart(self, x, y, w, h, color=LIME, fill_alpha=48, grid=True, seed=3):
        if grid:
            for i in range(1, 5):
                gy = y + h * i / 5
                self.line([(x, gy), (x + w, gy)], (255, 255, 255, 12), 1)
        rnd = random.Random(seed)
        pts = []
        base = [0.62, 0.48, 0.57, 0.36, 0.44, 0.24, 0.31, 0.18]
        for i in range(28):
            t = i / 27
            wobble = math.sin(t * math.pi * 3.1 + seed) * 0.05 + rnd.uniform(-0.025, 0.025)
            level = base[min(len(base) - 1, int(t * len(base)))] + wobble
            pts.append((x + t * w, y + h - max(0.06, min(0.94, level)) * h))
        poly = [(x, y + h)] + pts + [(x + w, y + h)]
        fill = self._solid(color + (fill_alpha,), x + w / 2, y + h / 2)
        self.d.polygon([(self.p(px), self.p(py)) for px, py in poly], fill=fill)
        self.line(pts, color, 2.2)
        last = pts[-1]
        self.ellipse(last[0] - 4, last[1] - 4, 8, 8, fill=color)
        self.ellipse(last[0] - 8, last[1] - 8, 16, 16, outline=color + (110,), width=1.5)

    def check(self, cx, cy, r, color=LIME, bg=INK):
        self.ellipse(cx - r, cy - r, r * 2, r * 2, fill=bg, outline=color, width=max(1.4, r * 0.16))
        self.line(
            [(cx - r * 0.42, cy + r * 0.02), (cx - r * 0.1, cy + r * 0.34), (cx + r * 0.46, cy - r * 0.34)],
            color,
            max(1.4, r * 0.22),
        )

    def pill(self, x, y, w, h, label, bg, fg, size=8.5, weight="demi"):
        self.rr(x, y, w, h, h / 2, fill=bg)
        self.text(x + w / 2, y + h / 2, label, size=size, weight=weight, fill=fg, anchor="mm")

    def spinner(self, cx, cy, r, color=LIME, width=2):
        self.d.arc(
            [self.p(cx - r), self.p(cy - r), self.p(cx + r), self.p(cy + r)],
            start=35,
            end=320,
            fill=color,
            width=max(1, self.p(width)),
        )

    def save(self, name: str, jpeg=False):
        img = self.img.resize((self.w, self.h), Image.LANCZOS)
        OUT.mkdir(parents=True, exist_ok=True)
        path = OUT / name
        if jpeg:
            img.convert("RGB").save(path, quality=92, subsampling=0)
        else:
            img.save(path)
        print("wrote", path.relative_to(OUT.parents[1]))


# ─── shared pieces ──────────────────────────────────────────────────────────


def phone_shell(a: Art, x, y, w, h, radius=46, screen_pad=11):
    """Draws a phone frame and returns the inner screen box (x, y, w, h)."""
    # Soft, blurred cast shadow lifts the device off the lime page.
    shadow = Image.new("RGBA", (a.img.width, a.img.height), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle(
        [a.p(x + 2), a.p(y + 14), a.p(x + w + 2), a.p(y + h + 14)],
        radius=a.p(radius),
        fill=(0, 10, 18, 78),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(a.p(10)))
    a.img.alpha_composite(shadow)

    # Layered metal rail with a light top-left rim and darker inner bezel.
    a.rr(x, y, w, h, radius, fill=(17, 25, 34))
    a.rr(x + 1.4, y + 1.4, w - 2.8, h - 2.8, radius - 1.4, fill=(46, 59, 72))
    a.rr(x + 3.6, y + 3.6, w - 7.2, h - 7.2, radius - 3.2, fill=(9, 17, 24))
    a.rr(x + 4.6, y + 4.6, w - 9.2, h - 9.2, radius - 4.2, outline=(148, 168, 180, 90), width=0.8)
    sx, sy = x + screen_pad, y + screen_pad
    sw, sh = w - screen_pad * 2, h - screen_pad * 2
    a.rr(sx, sy, sw, sh, radius - screen_pad, fill=INK)
    a.rr(sx, sy, sw, sh, radius - screen_pad, outline=(96, 116, 130, 70), width=0.7)
    # Side buttons sit flush against the rail.
    a.rr(x - 2.0, y + h * 0.20, 2.8, h * 0.075, 1.4, fill=(58, 73, 86))
    a.rr(x - 2.0, y + h * 0.31, 2.8, h * 0.115, 1.4, fill=(58, 73, 86))
    a.rr(x + w - 0.8, y + h * 0.27, 2.8, h * 0.10, 1.4, fill=(58, 73, 86))
    return sx, sy, sw, sh


def phone_status(a: Art, box):
    """Draws the hardware island and status row over the rendered screen."""
    sx, sy, sw, _ = box
    # Dynamic island
    a.rr(sx + sw / 2 - 38, sy + 6, 76, 21, 10.5, fill=(0, 0, 0))
    a.ellipse(sx + sw / 2 + 22, sy + 13, 6, 6, fill=(13, 25, 37))
    a.ellipse(sx + sw / 2 + 24, sy + 14.5, 2.2, 2.2, fill=(42, 70, 96))
    # Time
    a.text(sx + 24, sy + 11.5, "9:41", 7.6, "demi", (236, 244, 240))
    # Signal bars
    bars = [(0, 3.2), (3.4, 5), (6.8, 6.8), (10.2, 8.6)]
    for bx, bh in bars:
        a.rr(sx + sw - 79 + bx, sy + 20 - bh, 2.4, bh, 1, fill=(212, 224, 226))
    # Wi-Fi arcs
    wx, wy = sx + sw - 52, sy + 20
    for r in (7.4, 5.2, 3.0):
        a.d.arc(
            [a.p(wx - r), a.p(wy - r * 0.64), a.p(wx + r), a.p(wy + r * 1.36)],
            start=222, end=318, fill=(212, 224, 226), width=a.p(1.1),
        )
    a.ellipse(wx - 1.4, wy - 3.2, 2.8, 2.8, fill=(212, 224, 226))
    # Battery
    a.rr(sx + sw - 35, sy + 11.5, 19, 9, 2.6, outline=(212, 224, 226), width=0.8)
    a.rr(sx + sw - 33.2, sy + 13.2, 12.2, 5.6, 1.5, fill=(212, 224, 226))
    a.rr(sx + sw - 14.6, sy + 14, 1.8, 4, 0.9, fill=(160, 178, 184))


def screen_glass(a: Art, box):
    """Very light diagonal sheen so the screen reads as glass, not a flat fill."""
    sx, sy, sw, sh = box
    glass = Image.new("RGBA", (a.img.width, a.img.height), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glass)
    gd.polygon(
        [
            (a.p(sx), a.p(sy)),
            (a.p(sx + sw * 0.46), a.p(sy)),
            (a.p(sx + sw * 0.18), a.p(sy + sh)),
            (a.p(sx), a.p(sy + sh * 0.74)),
        ],
        fill=(255, 255, 255, 7),
    )
    gd.polygon(
        [
            (a.p(sx + sw * 0.58), a.p(sy)),
            (a.p(sx + sw * 0.66), a.p(sy)),
            (a.p(sx + sw * 0.32), a.p(sy + sh)),
            (a.p(sx + sw * 0.24), a.p(sy + sh)),
        ],
        fill=(255, 255, 255, 4),
    )
    glass = glass.filter(ImageFilter.GaussianBlur(a.p(18)))
    mask = Image.new("L", (a.img.width, a.img.height), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle(
        [a.p(sx), a.p(sy), a.p(sx + sw), a.p(sy + sh)],
        radius=a.p(35),
        fill=255,
    )
    a.img.alpha_composite(Image.composite(glass, Image.new("RGBA", glass.size, (0, 0, 0, 0)), mask))



def paste_screen(a: Art, box, painter):
    sx, sy, sw, sh = box
    screen = Art(int(sw), int(sh), a.scale, (0, 0, 0, 0))
    painter(screen, sw, sh)
    mask = Image.new("L", (screen.img.width, screen.img.height), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle(
        [0, 0, screen.img.width - 1, screen.img.height - 1],
        radius=screen.p(36),
        fill=255,
    )
    a.img.paste(screen.img, (a.p(sx), a.p(sy)), mask)


def screen_bg(a: Art, w, h):
    a.rect(0, 0, w, h, INK)
    # soft lime glow top-right + pink glow bottom-left
    glow = Image.new("RGBA", (a.img.width, a.img.height), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([a.p(w * 0.52), a.p(-h * 0.16), a.p(w * 1.42), a.p(h * 0.34)], fill=LIME + (52,))
    gd.ellipse([a.p(-w * 0.42), a.p(h * 0.70), a.p(w * 0.50), a.p(h * 1.22)], fill=PINK + (34,))
    glow = glow.filter(ImageFilter.GaussianBlur(a.p(52)))
    a.img.alpha_composite(glow)


def top_bar(a: Art, w, title, subtitle=None, status=None, status_color=LIME):
    a.text(18, 24, title, 15, "bold", WHITE)
    if subtitle:
        a.ellipse(18, 45, 5, 5, fill=status_color)
        a.text(29, 43.5, subtitle, 7.2, "demi", MUTED)
    if status:
        pill_w = 8 + len(status) * 5.1
        a.pill(w - pill_w - 16, 22, pill_w, 16, status, (255, 255, 255, 14), WHITE, 7)


def avatar(a: Art, cx, cy, r, color, label="A"):
    a.ellipse(cx - r, cy - r, r * 2, r * 2, fill=color)
    a.text(cx, cy + 0.3, label, r * 0.9, "bold", INK, anchor="mm")


def kpi(a: Art, x, y, w, h, label, value, delta, accent=LIME):
    a.rr(x, y, w, h, 13, fill=PANEL_2, outline=LINE, width=0.8)
    a.text(x + 11, y + 9, label, 7, "medium", MUTED)
    a.text(x + 11, y + 20, value, 17, "bold", WHITE)
    a.text(x + 11, y + h - 14, delta, 7, "demi", accent)


def role_badge(a: Art, x, y, label, bg, fg, w=42):
    a.pill(x, y, w, 15, label, bg, fg, 7)


# ─── hero: AI builder ───────────────────────────────────────────────────────


def hero_builder(a: Art, w, h):
    screen_bg(a, w, h)
    top_bar(a, w, "AI Builder", "Working · 42s", status=None)

    # user prompt bubble
    a.rr(16, 70, w - 32, 60, 14, fill=PANEL_2, outline=LINE, width=0.8)
    a.text(26, 80, "Build a dark admin dashboard", 8.4, "demi", WHITE)
    a.text(26, 92.5, "with roles, audit logs and", 8.4, "demi", WHITE)
    a.text(26, 105, "analytics.", 8.4, "demi", WHITE)
    avatar(a, w - 32, 84, 9, LIME, "A")

    # agent card
    card_y = 142
    card_h = 300
    a.rr(14, card_y, w - 28, card_h, 16, fill=(8, 21, 33), outline=(255, 255, 255, 22), width=0.9)
    a.rr(14, card_y, w - 28, 40, 16, fill=(255, 255, 255, 8))
    a.text(26, card_y + 12, "FlutterForge Agent", 9, "bold", WHITE)
    a.text(26, card_y + 25, "nemotron · fast", 6.6, "medium", MUTED)
    a.pill(w - 82, card_y + 12, 52, 15, "working", (52, 211, 153, 34), (110, 231, 183), 6.6)

    # stepper
    a.text(26, card_y + 52, "Step 7 of 13", 7.4, "demi", MUTED)
    a.text(w - 28, card_y + 52, "Architecture", 7.4, "medium", LIME, anchor="ra")
    segments = 13
    gap = 2
    seg_w = (w - 52 - gap * (segments - 1)) / segments
    for i in range(segments):
        color = LIME if i < 6 else (LIME if i == 6 else (255, 255, 255, 22))
        a.rr(26 + i * (seg_w + gap), card_y + 64, seg_w, 4.5, 2.2, fill=color)

    rows = [
        ("Product Intake", True, ""),
        ("UX Research", True, ""),
        ("Design System", True, ""),
        ("Architecture", False, "4/13"),
        ("Database Schema", None, ""),
    ]
    ry = card_y + 82
    for label, done, meta in rows:
        if done is True:
            a.check(34, ry + 7, 5.2, LIME, INK)
            a.text(46, ry, label, 8, "medium", (255, 255, 255, 190))
        elif done is False:
            a.spinner(34, ry + 7, 5.2, LIME, 1.5)
            a.text(46, ry, label, 8, "demi", WHITE)
            a.text(w - 28, ry + 0.5, meta, 6.4, "medium", MUTED, anchor="ra")
        else:
            a.ellipse(29, ry + 2, 10, 10, outline=(255, 255, 255, 28), width=1)
            a.text(46, ry, label, 8, "medium", DIM)
        ry += 26

    # written files
    a.rr(24, card_y + 218, 94, 18, 9, fill=(255, 255, 255, 9))
    a.text(32, card_y + 222.5, "theme.dart  new", 6.3, "medium", MUTED)
    a.rr(124, card_y + 218, 88, 18, 9, fill=(255, 255, 255, 9))
    a.text(132, card_y + 222.5, "router.dart  new", 6.3, "medium", MUTED)

    # live log line
    a.rr(24, card_y + 246, w - 48, 40, 10, fill=(0, 0, 0, 90), outline=(255, 255, 255, 16), width=0.7)
    a.text(32, card_y + 253, "Live logs · 10 lines", 6.2, "medium", DIM)
    a.text(32, card_y + 265, "$ flutter analyze", 6.6, "regular", LIME, mono=True)
    a.text(w - 32, card_y + 265, "no issues", 6.6, "regular", GREEN, anchor="ra", mono=True)

    # assistant summary
    a.rr(16, 456, w - 32, 74, 14, fill=PANEL_2, outline=LINE, width=0.8)
    a.text(28, 466, "I've scaffolded the dashboard, roles,", 7.6, "demi", WHITE)
    a.text(28, 478, "audit log and analytics. Next I can", 7.6, "demi", WHITE)
    a.text(28, 490, "wire role guards and CSV export.", 7.6, "demi", WHITE)
    a.pill(w - 96, 504, 66, 15, "3 files", (197, 250, 117, 26), LIME, 6.2)

    # build plan
    a.rr(16, 542, w - 32, 184, 14, fill=(8, 21, 33), outline=(255, 255, 255, 22), width=0.8)
    a.text(28, 552, "Build plan", 8.4, "bold", WHITE)
    a.pill(w - 76, 549, 48, 15, "5 / 8", (255, 255, 255, 10), MUTED, 6.2)
    plan = [
        ("Dashboard shell", True),
        ("Role-based access", True),
        ("Audit log table", True),
        ("Analytics reports", False),
        ("System health", False),
    ]
    py = 574
    for label, done in plan:
        a.rr(28, py - 2, 10, 10, 3, fill=LIME if done else None, outline=None if done else LINE, width=0.8)
        if done:
            a.line([(30, py + 2.6), (32.4, py + 5), (36, py - 0.2)], INK, 1.4)
        a.text(44, py - 1, label, 7.2, "medium", WHITE if done else MUTED)
        py += 21

    # quick actions
    a.text(18, 744, "Quick actions", 6.6, "demi", DIM)
    qx = 18
    for label in ["Add screen", "Fix build", "Export"]:
        cw = 26 + len(label) * 2.8
        a.rr(qx, 758, cw, 20, 10, fill=(255, 255, 255, 8), outline=(255, 255, 255, 22), width=0.7)
        a.text(qx + cw / 2, 768, label, 6.2, "medium", MUTED, anchor="mm")
        qx += cw + 8

    # suggested next
    a.rr(16, 790, w - 32, 74, 14, fill=PANEL_2, outline=LINE, width=0.8)
    a.text(28, 798, "Suggested next", 7.6, "demi", WHITE)
    a.text(w - 28, 799, "AI", 6.2, "demi", LIME, anchor="ra")
    for i, label in enumerate(["Wire role guards", "Add CSV export"]):
        a.rr(28, 814 + i * 24, w - 56, 20, 8, fill=(255, 255, 255, 5), outline=(255, 255, 255, 12), width=0.6)
        a.text(38, 819 + i * 24, "→", 7, "regular", LIME)
        a.text(52, 819 + i * 24, label, 7, "medium", MUTED)

    # composer
    a.rr(14, h - 74, w - 28, 54, 18, fill=(0, 10, 18, 210), outline=(255, 255, 255, 30), width=0.9)
    a.text(28, h - 59, "Describe a change…", 8.4, "regular", MUTED)
    a.ellipse(w - 54, h - 62, 32, 32, fill=LIME)
    a.line([(w - 41, h - 47), (w - 32, h - 47)], INK, 2)
    a.line([(w - 36, h - 52), (w - 31, h - 47)], INK, 2)
    a.line([(w - 36, h - 42), (w - 31, h - 47)], INK, 2)
    a.text(w / 2, h - 12, "Enter to send · Shift+Enter for a new line", 5.8, "medium", DIM, anchor="mm")


# ─── hero: live preview ─────────────────────────────────────────────────────


def hero_preview(a: Art, w, h):
    screen_bg(a, w, h)
    top_bar(a, w, "ApexAdmin", "Live preview", status=None)
    a.pill(w - 74, 22, 58, 16, "● live", (197, 250, 117, 28), LIME, 6.6)
    avatar(a, w - 22, 50, 9, PINK, "J")

    kpi(a, 16, 66, (w - 44) / 2, 55, "TOTAL USERS", "12.4k", "+8.2% this week")
    kpi(a, 16 + (w - 44) / 2 + 12, 66, (w - 44) / 2, 55, "SESSIONS", "8.2k", "+3.1% today", PINK)

    a.rr(16, 132, w - 32, 132, 14, fill=PANEL_2, outline=LINE, width=0.8)
    a.text(26, 142, "Activity", 8.6, "demi", WHITE)
    a.text(w - 28, 142, "Last 7 days", 6.4, "medium", MUTED, anchor="ra")
    a.chart(28, 160, w - 56, 82, LIME, 40, seed=7)
    for i, label in enumerate(["M", "T", "W", "T", "F", "S", "S"]):
        a.text(30 + (w - 60) * i / 6, 246, label, 5.6, "medium", DIM, anchor="ma")

    a.rr(16, 274, w - 32, 116, 14, fill=PANEL_2, outline=LINE, width=0.8)
    a.text(26, 284, "Roles & access", 8.6, "demi", WHITE)
    a.text(w - 28, 284, "Manage", 6.4, "demi", LIME, anchor="ra")
    role_badge(a, 26, 302, "Admin", LIME, INK, 48)
    role_badge(a, 80, 302, "Editor", PINK, INK, 46)
    role_badge(a, 132, 302, "Viewer", BLUE, INK, 48)
    a.text(w - 28, 303, "3 roles", 6.6, "medium", MUTED, anchor="ra")

    rows = [("Maya Chen", "Admin", LIME), ("Noah Park", "Editor", PINK), ("Iris Vale", "Viewer", BLUE)]
    ry = 326
    for name, role, color in rows:
        avatar(a, 32, ry + 6, 7, color, name[0])
        a.text(44, ry + 1.5, name, 7.4, "medium", (255, 255, 255, 200))
        a.pill(w - 76, ry, 48, 13, role, (255, 255, 255, 12), color, 6)
        ry += 20

    # system health
    a.rr(16, 402, w - 32, 112, 14, fill=PANEL_2, outline=LINE, width=0.8)
    a.text(26, 412, "System health", 8.6, "demi", WHITE)
    a.pill(w - 72, 409, 44, 15, "99.9%", (52, 211, 153, 24), (110, 231, 183), 6.2)
    health = [("API", 0.94, GREEN), ("Database", 0.88, LIME), ("Workers", 0.76, AMBER)]
    hy = 436
    for label, value, color in health:
        a.text(26, hy, label, 6.2, "medium", MUTED)
        a.text(w - 28, hy, f"{int(value * 100)}%", 6.2, "demi", color, anchor="ra")
        a.rr(26, hy + 9, w - 54, 4, 2, fill=(255, 255, 255, 16))
        a.rr(26, hy + 9, (w - 54) * value, 4, 2, fill=color)
        hy += 22

    # audit log
    a.rr(16, 526, w - 32, 196, 14, fill=(8, 21, 33), outline=(255, 255, 255, 22), width=0.8)
    a.text(26, 536, "Audit log", 8.6, "demi", WHITE)
    a.text(w - 28, 537, "View all", 6.2, "demi", LIME, anchor="ra")
    audits = [
        ("09:42", "Maya Chen", "Updated role permissions"),
        ("09:18", "Noah Park", "Invited 3 viewers"),
        ("08:55", "System", "Nightly backup complete"),
        ("08:12", "Iris Vale", "Exported analytics.csv"),
        ("07:40", "Maya Chen", "Enabled 2FA policy"),
    ]
    ay = 558
    for i, (time, actor, action) in enumerate(audits):
        a.text(26, ay, time, 5.8, "regular", DIM, mono=True)
        a.text(62, ay - 0.5, actor, 6.4, "demi", WHITE)
        a.text(62, ay + 8, action, 6, "regular", MUTED)
        if i < len(audits) - 1:
            a.line([(26, ay + 20), (w - 26, ay + 20)], (255, 255, 255, 10), 0.6)
        ay += 30

    # analytics summary
    a.rr(16, 734, w - 32, 92, 14, fill=PANEL_2, outline=LINE, width=0.8)
    a.text(26, 744, "Analytics", 8.2, "demi", WHITE)
    a.text(w - 28, 745, "This month", 6, "medium", MUTED, anchor="ra")
    for i, (label, value, delta, color) in enumerate([
        ("New users", "1,284", "+12%", LIME),
        ("Retention", "86%", "+4%", PINK),
        ("Reports", "312", "+9%", BLUE),
    ]):
        bx = 26 + i * ((w - 56) / 3)
        a.text(bx, 764, value, 11, "bold", WHITE)
        a.text(bx, 778, label, 5.8, "medium", MUTED)
        a.text(bx, 790, delta, 5.8, "demi", color)

    # device mix
    a.rr(16, 826, w - 32, 60, 14, fill=PANEL_2, outline=LINE, width=0.8)
    a.text(26, 834, "Device mix", 8.2, "demi", WHITE)
    a.text(w - 28, 835, "Last 7 days", 6, "medium", MUTED, anchor="ra")
    devices = [("Desktop", 0.58, LIME), ("Mobile", 0.31, PINK), ("Tablet", 0.11, BLUE)]
    seg = (w - 60) / 3
    for i, (label, value, color) in enumerate(devices):
        bx = 26 + i * seg
        a.text(bx, 852, label, 5.8, "medium", MUTED)
        a.text(bx + seg - 10, 852, f"{int(value * 100)}%", 5.8, "demi", color, anchor="ra")
        a.rr(bx, 864, seg - 10, 4, 2, fill=(255, 255, 255, 16))
        a.rr(bx, 864, (seg - 10) * value, 4, 2, fill=color)

    # bottom nav
    nav_y = h - 54
    a.rr(16, nav_y, w - 32, 40, 14, fill=(0, 10, 18, 220), outline=(255, 255, 255, 26), width=0.8)
    for i, x in enumerate([44, 104, w / 2, w - 104, w - 44]):
        active = i == 0
        a.ellipse(x - 5, nav_y + 15, 10, 10, fill=LIME if active else (255, 255, 255, 40))
        if active:
            a.ellipse(x - 9, nav_y + 11, 18, 18, outline=(197, 250, 117, 80), width=1)


# ─── hero: source ───────────────────────────────────────────────────────────


def hero_source(a: Art, w, h):
    a.rect(0, 0, w, h, (7, 17, 26))
    top_bar(a, w, "Source", "main · clean", status="Dart")
    # tabs
    a.rr(12, 64, w - 24, 24, 8, fill=(255, 255, 255, 7))
    a.rr(16, 67, 96, 18, 6, fill=PANEL_3)
    a.text(26, 72, "app_router.dart", 6.8, "medium", WHITE, mono=True)
    a.text(126, 72, "theme.dart", 6.8, "regular", MUTED, mono=True)
    a.text(204, 72, "main.dart", 6.8, "regular", DIM, mono=True)
    a.ellipse(16, 73, 4, 4, fill=LIME)

    # file tree
    tree_w = 118
    a.rr(12, 96, tree_w, h - 196, 10, fill=(255, 255, 255, 5), outline=(255, 255, 255, 14), width=0.7)
    tree = [
        (0, "lib", "folder", True),
        (1, "core", "folder", False),
        (2, "theme", "folder", False),
        (1, "features", "folder", False),
        (2, "dashboard", "folder", False),
        (2, "users", "folder", False),
        (1, "app_router.dart", "file", True),
        (1, "main.dart", "file", False),
    ]
    ty = 106
    for depth, label, kind, active in tree:
        tx0 = 20 + depth * 9
        if kind == "folder":
            a.rr(tx0, ty + 1, 7, 5.5, 1, fill=LIME)
        else:
            a.rr(tx0, ty, 6, 7.5, 1.5, fill=BLUE)
        a.text(tx0 + 12, ty - 0.8, label, 6.2, "medium" if active else "regular", WHITE if active else MUTED)
        ty += 19

    # Package + test groups keep the explorer from bottoming out early.
    a.line([(20, ty + 9), (tree_w - 2, ty + 9)], (255, 255, 255, 14), 0.6)
    a.text(20, ty + 15, "PACKAGES", 5.4, "demi", DIM)
    py = ty + 27
    for label in ["provider", "go_router", "intl"]:
        a.rr(21, py + 1, 5, 5, 1, outline=(255, 255, 255, 46), width=0.7)
        a.text(32, py - 0.8, label, 6, "regular", MUTED)
        py += 17
    a.text(20, py + 13, "TESTS", 5.4, "demi", DIM)
    ty = py + 25
    for label in ["audit_screen_test.dart", "role_guard_test.dart"]:
        a.rr(21, ty, 6, 7.5, 1.5, fill=(255, 255, 255, 34))
        a.text(33, ty - 0.8, label, 5.8, "regular", MUTED)
        ty += 17

    # code area
    cx = 140
    code = [
        ("1", "final ", "keyword", "router = GoRouter("),
        ("2", "  routes: [", "plain", ""),
        ("3", "    GoRoute(", "plain", ""),
        ("4", "      path: ", "plain", "'/'"),
        ("5", "      builder: ", "plain", "HomeScreen"),
        ("6", "    ),", "plain", ""),
        ("7", "    GoRoute(", "plain", ""),
        ("8", "      path: ", "plain", "'/users'"),
        ("9", "      builder: ", "plain", "UsersScreen"),
        ("10", "    ),", "plain", ""),
        ("11", "    GoRoute(", "plain", ""),
        ("12", "      path: ", "plain", "'/audit'"),
        ("13", "      builder: ", "plain", "AuditScreen"),
        ("14", "    ),", "plain", ""),
        ("15", "  ],", "plain", ""),
        ("16", "  redirect: ", "plain", "guard"),
        ("17", ");", "plain", ""),
        ("18", "", "plain", ""),
        ("19", "class ", "keyword", "AppTheme {"),
        ("20", "  static ", "keyword", "ThemeData dark() =>"),
        ("21", "    ThemeData(", "plain", ""),
        ("22", "      useMaterial3: ", "plain", "true,"),
        ("23", "      colorScheme: ", "plain", "scheme,"),
        ("24", "    );", "plain", ""),
        ("25", "}", "plain", ""),
    ]
    cy = 104
    for num, prefix, kind, rest in code:
        a.text(cx, cy, num, 5.8, "regular", DIM, anchor="ra", mono=True)
        color = PINK if kind == "keyword" else (255, 255, 255, 205)
        a.text(cx + 10, cy, prefix, 6.6, "regular", color, mono=True)
        if rest:
            a.text(cx + 10 + len(prefix) * 4.05, cy, rest, 6.6, "regular", LIME if rest.startswith("'") else BLUE, mono=True)
        cy += 15.5

    # outline panel
    a.rr(140, 552, w - 152, 300, 10, fill=(255, 255, 255, 4), outline=(255, 255, 255, 14), width=0.7)
    a.text(152, 562, "OUTLINE", 5.6, "demi", DIM)
    outline = ["GoRouter router", "AppTheme.dark", "HomeScreen", "UsersScreen", "AuditScreen", "RoleGuard"]
    oy = 580
    for i, label in enumerate(outline):
        a.rr(152, oy + 1, 6, 6, 1.5, fill=LIME if i % 2 == 0 else BLUE)
        a.text(164, oy - 0.5, label, 6.4, "medium", (255, 255, 255, 170))
        oy += 19
    a.line([(152, oy + 4), (w - 24, oy + 4)], (255, 255, 255, 12), 0.6)
    a.text(152, oy + 12, "Dependencies", 5.6, "demi", DIM)
    a.text(152, oy + 26, "provider ^6.1.2 · go_router ^14.6.2", 6, "regular", MUTED, mono=True)

    # Diagnostics + tests give the lower half of the inspector a purpose.
    a.line([(152, oy + 46), (w - 24, oy + 46)], (255, 255, 255, 12), 0.6)
    a.text(152, oy + 54, "DIAGNOSTICS", 5.6, "demi", DIM)
    diag_y = oy + 68
    for label, color in [("No analyzer issues", GREEN), ("0 warnings · 0 hints", LIME)]:
        a.check(156, diag_y + 3.4, 3.4, color, (10, 22, 34))
        a.text(166, diag_y, label, 6.2, "medium", (255, 255, 255, 175))
        diag_y += 18
    a.line([(152, diag_y + 8), (w - 24, diag_y + 8)], (255, 255, 255, 12), 0.6)
    a.text(152, diag_y + 16, "TESTS", 5.6, "demi", DIM)
    test_y = diag_y + 30
    for label in ["audit_screen_test.dart", "role_guard_test.dart"]:
        a.ellipse(152, test_y + 1.5, 5, 5, fill=GREEN)
        a.text(164, test_y, label, 6, "medium", (255, 255, 255, 170), mono=True)
        test_y += 18
    a.text(w - 24, diag_y + 16, "2 passed", 5.8, "demi", GREEN, anchor="ra")

    # gutter + terminal
    a.rr(12, h - 88, w - 24, 72, 10, fill=(0, 9, 16, 220), outline=(255, 255, 255, 18), width=0.7)
    a.text(22, h - 80, "TERMINAL", 5.8, "demi", DIM)
    a.text(22, h - 66, "$ flutter analyze", 6.6, "regular", WHITE, mono=True)
    a.text(22, h - 52, "✓ No issues found!", 6.6, "regular", GREEN, mono=True)
    a.text(22, h - 38, "$ flutter build web", 6.6, "regular", WHITE, mono=True)
    a.text(22, h - 24, "✓ Built build/web", 6.6, "regular", LIME, mono=True)


# ─── detail: iterate / refine / export ──────────────────────────────────────


def detail_iterate(a: Art, w, h):
    a.rect(0, 0, w, h, (255, 255, 255, 0))
    a.rr(0, 0, w, h, 40, fill=INK)
    screen_bg(a, w, h)
    top_bar(a, w, "Prompt & iterate", "context aware", status="live")
    a.text(18, 62, "Iterate on your app", 19, "bold", WHITE)
    a.text(18, 86, "Ask for a screen, a layout, or one more feature.", 7.4, "regular", MUTED)

    a.rr(16, 108, w - 32, 54, 14, fill=PANEL_2, outline=LINE, width=0.8)
    a.text(27, 118, "Add an audit log table with filters", 8.2, "demi", WHITE)
    a.text(27, 131, "and CSV export.", 8.2, "demi", WHITE)
    avatar(a, w - 32, 122, 8, LIME, "A")

    a.rr(16, 172, w - 32, 66, 14, fill=(8, 21, 33), outline=(255, 255, 255, 22), width=0.8)
    a.text(26, 181, "FlutterForge Agent", 8.4, "bold", WHITE)
    a.pill(w - 78, 180, 50, 14, "applied", (52, 211, 153, 30), (110, 231, 183), 6.4)
    a.text(26, 197, "Updated 4 files · +106 −3", 7, "medium", MUTED)
    a.text(26, 211, "Material 3 · Provider · GoRouter", 6.8, "regular", LIME)

    # capability chips
    chips = [("Material 3", LIME), ("Provider", PINK), ("GoRouter", BLUE), ("Animations", AMBER)]
    x = 18
    for i, (label, color) in enumerate(chips):
        cw = 20 + len(label) * 4.4
        a.rr(x, 250, cw, 20, 10, fill=(255, 255, 255, 9), outline=color + (90,), width=0.8)
        a.ellipse(x + 8, 258.5, 3.5, 3.5, fill=color)
        a.text(x + 15, 255.5, label, 6.4, "medium", WHITE)
        x += cw + 6

    # diff card
    a.rr(16, 282, w - 32, 160, 14, fill=(8, 21, 33), outline=(255, 255, 255, 22), width=0.8)
    a.text(26, 292, "lib/features/audit/audit_screen.dart", 6.4, "medium", BLUE, mono=True)
    a.pill(w - 82, 288, 54, 14, "+64 −2", (52, 211, 153, 24), (110, 231, 183), 6.2)
    lines = [
        ("+", "final rows = await repo.audit(", GREEN),
        ("+", "  filter: AuditFilter.today,", GREEN),
        ("+", ");", GREEN),
        (" ", "return AuditTable(rows: rows);", (255, 255, 255, 190)),
        ("-", "return const Placeholder();", RED),
    ]
    ly = 312
    for sign, text, color in lines:
        if sign == "+":
            a.rect(24, ly - 1, w - 48, 13, (52, 211, 153, 18))
        elif sign == "-":
            a.rect(24, ly - 1, w - 48, 13, (251, 113, 133, 18))
        a.text(28, ly, sign, 6.4, "bold", color, mono=True)
        a.text(38, ly, text, 6.4, "regular", color, mono=True)
        ly += 17
    a.rr(26, 402, 96, 26, 13, fill=LIME)
    a.text(74, 415, "Apply changes", 7.4, "bold", INK, anchor="mm")
    a.rr(130, 402, 74, 26, 13, fill=(255, 255, 255, 10), outline=(255, 255, 255, 30), width=0.8)
    a.text(167, 415, "Review", 7.2, "demi", WHITE, anchor="mm")

    # next steps
    a.text(18, 458, "Next steps", 7, "demi", DIM)
    for i, label in enumerate(["Add CSV export", "Wire role permissions"]):
        a.rr(18, 472 + i * 30, w - 36, 24, 8, fill=(255, 255, 255, 5), outline=(255, 255, 255, 12), width=0.6)
        a.text(28, 479 + i * 30, "○", 8, "regular", LIME)
        a.text(40, 479 + i * 30, label, 7.4, "medium", MUTED)

    # changed files
    a.rr(16, 544, w - 32, 178, 14, fill=(8, 21, 33), outline=(255, 255, 255, 22), width=0.8)
    a.text(26, 554, "Changed files", 8.2, "demi", WHITE)
    a.pill(w - 78, 551, 50, 15, "+106 −3", (52, 211, 153, 24), (110, 231, 183), 6)
    files = [
        ("audit_screen.dart", "+64  −2", GREEN),
        ("audit_repository.dart", "+28  −1", GREEN),
        ("audit_filter.dart", "+12  −0", GREEN),
        ("app_router.dart", "+2  −0", LIME),
    ]
    fy = 578
    for name, stat, color in files:
        a.rr(26, fy, 14, 14, 4, fill=(255, 255, 255, 9))
        a.text(31, fy + 2, "D", 5.6, "bold", BLUE)
        a.text(48, fy + 0.5, name, 6.6, "medium", (255, 255, 255, 190), mono=True)
        a.text(w - 28, fy + 0.5, stat, 6.2, "demi", color, anchor="ra", mono=True)
        fy += 26

    # context
    context_bottom = h - 70
    a.rr(16, 734, w - 32, context_bottom - 734, 14, fill=PANEL_2, outline=LINE, width=0.8)
    a.text(26, 744, "Context attached", 8, "demi", WHITE)
    a.text(w - 28, 745, "12.4k / 32k", 6, "medium", MUTED, anchor="ra")
    a.rr(26, 762, w - 52, 5, 2.5, fill=(255, 255, 255, 16))
    a.rr(26, 762, (w - 52) * 0.39, 5, 2.5, fill=LIME)
    chips = ["pubspec.yaml", "router.dart", "users_screen.dart", "audit_model.dart"]
    cxp, cyp = 26, 780
    for label in chips:
        cw = 18 + len(label) * 3.7
        if cxp + cw > w - 26:
            cxp, cyp = 26, cyp + 24
        a.rr(cxp, cyp, cw, 20, 10, fill=(255, 255, 255, 8), outline=(255, 255, 255, 20), width=0.6)
        a.text(cxp + 9, cyp + 6, label, 5.6, "medium", MUTED, mono=True)
        cxp += cw + 6

    # composer keeps the context card reading as a working surface
    a.line([(26, 838), (w - 26, 838)], (255, 255, 255, 12), 0.6)
    a.rr(26, 848, w - 52, 38, 12, fill=(255, 255, 255, 6), outline=(255, 255, 255, 18), width=0.7)
    a.text(38, 862, "Ask for the next change…", 7, "medium", DIM)
    a.ellipse(w - 52, 858, 18, 18, fill=LIME)
    a.text(w - 43, 862.5, "↑", 8, "bold", INK, anchor="ma")
    a.text(26, context_bottom - 20, "Enter to send · Shift+Enter for a new line", 5.6, "medium", DIM)

    # status bar
    a.rr(16, h - 64, w - 32, 40, 12, fill=(255, 255, 255, 5), outline=(255, 255, 255, 14), width=0.6)
    a.ellipse(28, h - 49, 6, 6, fill=GREEN)
    a.text(40, h - 52.5, "All changes saved", 7, "demi", (255, 255, 255, 200))
    a.text(w - 28, h - 52, "main · local", 6.2, "medium", DIM, anchor="ra")


def detail_refine(a: Art, w, h):
    a.rr(0, 0, w, h, 40, fill=INK)
    screen_bg(a, w, h)
    top_bar(a, w, "Live preview", "hot reload on", status="web")
    a.text(18, 62, "Refine in place", 19, "bold", WHITE)
    a.text(18, 86, "Test the interactions, then ask for the next change.", 7.2, "regular", MUTED)

    # device switch
    a.rr(18, 108, 192, 28, 14, fill=(255, 255, 255, 7), outline=(255, 255, 255, 18), width=0.7)
    for i, label in enumerate(["Phone", "Tablet", "Desktop"]):
        active = i == 2
        dx = 20 + i * 63
        if active:
            a.rr(dx, 111.5, 61, 21, 10.5, fill=LIME)
        fg = INK if active else MUTED
        gx, gy = dx + 8, 117
        if i == 0:
            a.rr(gx + 1, gy, 5, 9, 1.2, outline=fg, width=0.9)
        elif i == 1:
            a.rr(gx, gy, 7, 9, 1.2, outline=fg, width=0.9)
        else:
            a.rr(gx, gy, 10, 7, 1.2, outline=fg, width=0.9)
            a.line([(gx + 4, gy + 7), (gx + 4, gy + 9)], fg, 0.9)
            a.line([(gx + 2, gy + 9), (gx + 6, gy + 9)], fg, 0.9)
        a.text(dx + 22, 121, label, 6.2, "demi", fg, anchor="lm")

    # preview card
    a.rr(16, 148, w - 32, 250, 16, fill=(7, 19, 30), outline=(255, 255, 255, 24), width=0.9)
    a.rr(16, 148, w - 32, 30, 14, fill=(255, 255, 255, 7))
    a.ellipse(28, 160, 4, 4, fill=LIME)
    a.text(38, 156.5, "localhost:5173/preview", 6.2, "medium", MUTED, mono=True)
    a.pill(w - 66, 154, 38, 14, "100%", (255, 255, 255, 10), WHITE, 6)
    # mini dashboard
    a.text(32, 190, "Dashboard", 12, "bold", WHITE)
    a.text(32, 207, "Welcome back, Maya", 6.6, "regular", MUTED)
    a.rr(32, 222, 118, 52, 10, fill=PANEL_2, outline=LINE, width=0.7)
    a.text(40, 229, "Revenue", 5.8, "medium", MUTED)
    a.text(40, 240, "$48.2k", 12, "bold", WHITE)
    a.chart(160, 224, w - 192, 46, LIME, 32, grid=False, seed=11)
    a.rr(32, 286, w - 64, 92, 12, fill=PANEL_2, outline=LINE, width=0.7)
    a.text(42, 294, "Recent activity", 7.4, "demi", WHITE)
    for i, (label, color) in enumerate([("Role updated", LIME), ("User invited", PINK), ("Report exported", BLUE)]):
        a.ellipse(43, 311 + i * 18, 4, 4, fill=color)
        a.text(52, 307.5 + i * 18, label, 6.4, "medium", (255, 255, 255, 185))
        a.text(w - 42, 307.5 + i * 18, "2m", 5.8, "regular", DIM, anchor="ra")

    # hot reload pill
    a.rr(18, 412, 120, 24, 12, fill=(52, 211, 153, 22), outline=(52, 211, 153, 60), width=0.7)
    a.ellipse(28, 421, 6, 6, fill=GREEN)
    a.text(40, 417, "Hot reload ✓", 7.2, "demi", (110, 231, 183))

    # controls
    a.text(18, 456, "Viewport", 7, "demi", DIM)
    a.rr(18, 470, w - 36, 40, 12, fill=(255, 255, 255, 5), outline=(255, 255, 255, 14), width=0.7)
    for i, label in enumerate(["Responsive", "Safe area", "Dark mode"]):
        a.text(30 + i * ((w - 56) / 3), 484, "● " + label, 6.4, "medium", LIME if i == 2 else MUTED)

    # console
    a.rr(16, 536, w - 32, 172, 14, fill=(0, 9, 16), outline=(255, 255, 255, 18), width=0.8)
    a.text(26, 546, "CONSOLE", 5.8, "demi", DIM)
    a.text(w - 28, 546, "clear", 5.8, "medium", MUTED, anchor="ra")
    console = [
        ("$ flutter run -d chrome", WHITE),
        ("✓ Compiled in 1.8s", GREEN),
        ("✓ Hot reload applied — 2 widgets", LIME),
        ("→ GET /api/users 200 (42ms)", BLUE),
        ("→ GET /api/audit 200 (31ms)", BLUE),
        ("→ GET /api/roles 200 (18ms)", BLUE),
        ("✓ Preview connected — ws://localhost", GREEN),
        ("ℹ 3 widgets rebuilt in 12ms", MUTED),
    ]
    ly = 564
    for line, color in console:
        a.text(26, ly, line, 6.2, "regular", color, mono=True)
        ly += 17

    # performance
    a.rr(16, 726, w - 32, 180, 14, fill=PANEL_2, outline=LINE, width=0.8)
    a.text(26, 736, "Performance", 8, "demi", WHITE)
    a.pill(w - 78, 733, 50, 15, "60 fps", (52, 211, 153, 24), (110, 231, 183), 6)
    metrics = [("Build", 0.82, LIME), ("Frame", 0.94, GREEN), ("Memory", 0.61, PINK)]
    my = 760
    for label, value, color in metrics:
        a.text(26, my, label, 6.2, "medium", MUTED)
        a.text(w - 28, my, f"{int(value * 100)}%", 6.2, "demi", color, anchor="ra")
        a.rr(26, my + 9, w - 54, 5, 2.5, fill=(255, 255, 255, 16))
        a.rr(26, my + 9, (w - 54) * value, 5, 2.5, fill=color)
        my += 25
    a.text(26, 846, "Last reload 12s ago · 3 pending changes", 5.8, "medium", DIM)
    a.chart(26, 862, w - 52, 34, GREEN, 26, grid=False, seed=13)

    # status bar
    a.rr(16, 936, w - 32, 40, 12, fill=(255, 255, 255, 5), outline=(255, 255, 255, 14), width=0.6)
    a.ellipse(28, 951, 6, 6, fill=GREEN)
    a.text(40, 947.5, "Live preview connected", 7, "demi", (255, 255, 255, 200))
    a.text(w - 28, 948, "localhost:5173", 6.2, "medium", LIME, anchor="ra", mono=True)


def detail_export(a: Art, w, h):
    a.rr(0, 0, w, h, 40, fill=INK)
    screen_bg(a, w, h)
    top_bar(a, w, "Export & build", "3 targets ready", status="local")
    a.text(18, 62, "Take it with you", 19, "bold", WHITE)
    a.text(18, 86, "Editable Dart source, project files and assets.", 7.2, "regular", MUTED)

    platforms = [
        ("Web", "PWA + static", GREEN, "Ready"),
        ("macOS", "Universal", GREEN, "Ready"),
        ("Windows", "x64", AMBER, "Build"),
    ]
    y = 112
    for label, meta, color, state in platforms:
        a.rr(16, y, w - 32, 58, 13, fill=PANEL_2, outline=LINE, width=0.8)
        a.rr(26, y + 13, 32, 32, 9, fill=(255, 255, 255, 8))
        # tiny platform glyph
        if label == "Web":
            a.ellipse(34, y + 21, 16, 16, outline=color, width=1.6)
            a.line([(34, y + 29), (50, y + 29)], color, 1.4)
            a.line([(42, y + 21), (42, y + 37)], color, 1.4)
        elif label == "macOS":
            a.rr(33, y + 24, 18, 12, 2, fill=color)
            a.rr(30, y + 36, 24, 3, 1.5, fill=color)
        else:
            a.rr(33, y + 22, 18, 15, 2, outline=color, width=1.4)
            a.line([(33, y + 29), (51, y + 29)], color, 1.4)
            a.line([(42, y + 22), (42, y + 37)], color, 1.4)
        a.text(70, y + 13, label, 9.4, "bold", WHITE)
        a.text(70, y + 29, meta, 6.6, "regular", MUTED)
        a.pill(w - 78, y + 21, 52, 16, ("✓ " if state == "Ready" else "") + state, (255, 255, 255, 9) if state != "Ready" else (52, 211, 153, 24), color)
        y += 68

    # build progress
    a.rr(16, 324, w - 32, 74, 13, fill=(8, 21, 33), outline=(255, 255, 255, 20), width=0.8)
    a.text(26, 334, "Building web release", 8, "demi", WHITE)
    a.text(w - 28, 334, "68%", 7, "demi", LIME, anchor="ra")
    a.rr(26, 350, w - 52, 6, 3, fill=(255, 255, 255, 16))
    a.rr(26, 350, (w - 52) * 0.68, 6, 3, fill=LIME)
    a.text(26, 364, "Compiling Dart · tree shaking icons", 6.4, "regular", MUTED)

    # command
    a.rr(16, 412, w - 32, 52, 11, fill=(0, 9, 16), outline=(255, 255, 255, 16), width=0.7)
    a.text(26, 421, "TERMINAL", 5.6, "demi", DIM)
    a.text(26, 434, "$ flutter build web --release", 6.4, "regular", LIME, mono=True)
    a.text(26, 447, "✓ build/web · 4.8 MB", 6.2, "regular", GREEN, mono=True)

    # project contents
    a.rr(16, 484, w - 32, 210, 14, fill=(8, 21, 33), outline=(255, 255, 255, 22), width=0.8)
    a.text(26, 494, "Project contents", 8.2, "demi", WHITE)
    a.text(w - 28, 495, "18 files", 6, "medium", MUTED, anchor="ra")
    contents = [
        ("lib/", "14 Dart files", BLUE),
        ("test/", "widget tests", PINK),
        ("assets/", "images & fonts", LIME),
        ("pubspec.yaml", "provider, go_router", AMBER),
        ("README.md", "run & build notes", MUTED),
    ]
    cy = 516
    for name, meta, color in contents:
        a.rr(26, cy + 1, 7, 7, 2, fill=color)
        a.text(40, cy - 0.5, name, 6.6, "medium", (255, 255, 255, 190), mono=True)
        a.text(w - 28, cy - 0.5, meta, 6, "regular", MUTED, anchor="ra")
        cy += 25

    # release notes
    a.rr(16, 710, w - 32, 180, 14, fill=PANEL_2, outline=LINE, width=0.8)
    a.text(26, 720, "Release notes", 8, "demi", WHITE)
    a.text(26, 740, "• Material 3 dark theme", 6.8, "medium", MUTED)
    a.text(26, 756, "• Role-based navigation guards", 6.8, "medium", MUTED)
    a.text(26, 772, "• Audit log with CSV export", 6.8, "medium", MUTED)
    a.text(26, 788, "• Analytics dashboard", 6.8, "medium", MUTED)
    a.pill(26, 810, 78, 16, "web · macOS", (197, 250, 117, 22), LIME, 6.2)
    a.pill(112, 810, 58, 16, "Windows", (255, 255, 255, 10), MUTED, 6.2)
    a.text(26, 840, "Generated locally · no backend required", 6, "regular", DIM)

    a.rr(16, h - 70, w - 32, 34, 17, fill=LIME)
    a.text(w / 2, h - 53, "Export project", 9, "bold", INK, anchor="mm")
    a.text(w / 2, h - 24, "ZIP · includes pubspec.yaml and README", 5.8, "medium", MUTED, anchor="mm")


# ─── wide workspace ─────────────────────────────────────────────────────────


def workspace_wide(a: Art, w, h):
    a.rr(0, 0, w, h, 26, fill=(5, 14, 23))
    a.rr(0, 0, w, h, 26, outline=(255, 255, 255, 26), width=1)
    # chrome
    a.rr(0, 0, w, 38, 26, fill=(10, 24, 36))
    a.rect(0, 24, w, 14, (10, 24, 36))
    for i, color in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        a.ellipse(18 + i * 16, 14, 9, 9, fill=color)
    a.text(w / 2, 19, "FlutterForge — ApexAdmin", 8, "demi", (255, 255, 255, 200), anchor="mm")
    a.pill(w - 96, 10, 78, 18, "● Preview", (197, 250, 117, 24), LIME, 7)

    # three panels
    pad = 14
    top = 52
    bottom = h - 14
    left_w = w * 0.30
    mid_w = w * 0.34
    right_w = w - left_w - mid_w - pad * 4

    # left chat
    a.rr(pad, top, left_w, bottom - top, 14, fill=INK_2, outline=(255, 255, 255, 18), width=0.8)
    a.text(pad + 16, top + 16, "AI Builder", 12, "bold", WHITE)
    a.ellipse(pad + 16, top + 34, 5, 5, fill=LIME)
    a.text(pad + 27, top + 32, "Ready · 4 skills", 6.6, "medium", MUTED)
    a.rr(pad + 14, top + 52, left_w - 28, 58, 12, fill=PANEL_2, outline=LINE, width=0.7)
    a.text(pad + 24, top + 62, "Create a role-based admin", 7.4, "demi", WHITE)
    a.text(pad + 24, top + 74, "dashboard with audit logs.", 7.4, "demi", WHITE)
    a.text(pad + 24, top + 86, "Dark theme, local only.", 7, "regular", MUTED)

    a.rr(pad + 14, top + 120, left_w - 28, 210, 12, fill=(8, 21, 33), outline=(255, 255, 255, 20), width=0.8)
    a.text(pad + 24, top + 130, "FlutterForge Agent", 7.8, "bold", WHITE)
    a.pill(pad + left_w - 82, top + 128, 52, 14, "working", (52, 211, 153, 30), (110, 231, 183), 6.2)
    a.text(pad + 24, top + 148, "Step 7 of 13", 6.2, "medium", MUTED)
    a.rr(pad + 24, top + 158, left_w - 48, 4, 2, fill=(255, 255, 255, 16))
    a.rr(pad + 24, top + 158, (left_w - 48) * 0.54, 4, 2, fill=LIME)
    steps = ["Product Intake", "UX Research", "Design System", "Architecture", "Database Schema"]
    sy = top + 176
    for i, label in enumerate(steps):
        if i < 3:
            a.check(pad + 30, sy + 5, 4.2, LIME, INK)
            a.text(pad + 40, sy - 1, label, 6.8, "medium", (255, 255, 255, 185))
        elif i == 3:
            a.spinner(pad + 30, sy + 5, 4.2, LIME, 1.4)
            a.text(pad + 40, sy - 1, label, 6.8, "demi", WHITE)
        else:
            a.ellipse(pad + 26, sy + 1, 8, 8, outline=(255, 255, 255, 26), width=1)
            a.text(pad + 40, sy - 1, label, 6.8, "regular", DIM)
        sy += 22

    # assistant follow-up
    a.rr(pad + 14, top + 350, left_w - 28, 88, 12, fill=PANEL_2, outline=LINE, width=0.7)
    a.text(pad + 24, top + 360, "Scaffolded the dashboard,", 7, "demi", WHITE)
    a.text(pad + 24, top + 372, "roles, audit log and", 7, "demi", WHITE)
    a.text(pad + 24, top + 384, "analytics. Next: role guards.", 7, "demi", WHITE)
    a.pill(pad + 24, top + 402, 60, 15, "3 files", (197, 250, 117, 22), LIME, 6)

    # files
    a.rr(pad + 14, top + 450, left_w - 28, 142, 12, fill=(8, 21, 33), outline=(255, 255, 255, 18), width=0.7)
    a.text(pad + 24, top + 460, "Files written", 7.4, "demi", WHITE)
    a.text(pad + left_w - 24, top + 461, "4 new", 5.8, "medium", MUTED, anchor="ra")
    file_rows = [
        ("theme.dart", "132 lines"),
        ("app_router.dart", "48 lines"),
        ("users_screen.dart", "210 lines"),
        ("audit_screen.dart", "164 lines"),
    ]
    fy = top + 480
    for name, meta in file_rows:
        a.text(pad + 24, fy, "▸", 6, "regular", LIME)
        a.text(pad + 34, fy - 0.5, name, 6.4, "medium", (255, 255, 255, 190), mono=True)
        a.text(pad + left_w - 24, fy - 0.5, meta, 5.6, "regular", DIM, anchor="ra")
        fy += 22

    # plan
    a.rr(pad + 14, top + 604, left_w - 28, 160, 12, fill=(8, 21, 33), outline=(255, 255, 255, 18), width=0.7)
    a.text(pad + 24, top + 614, "Build plan", 7.4, "demi", WHITE)
    plan = [("Dashboard shell", True), ("Role guards", True), ("Audit log", False), ("Analytics", False)]
    py = top + 636
    for label, done in plan:
        a.rr(pad + 24, py - 2, 9, 9, 2.5, fill=LIME if done else None, outline=None if done else LINE, width=0.7)
        if done:
            a.line([(pad + 26, py + 2.2), (pad + 28, py + 4.4), (pad + 31, py + 0.4)], INK, 1.2)
        a.text(pad + 38, py - 1, label, 6.4, "medium", WHITE if done else MUTED)
        py += 22

    a.rr(pad + 14, bottom - 54, left_w - 28, 40, 12, fill=(0, 10, 18, 220), outline=(255, 255, 255, 26), width=0.7)
    a.text(pad + 26, bottom - 42, "Describe a change…", 7, "regular", MUTED)
    a.ellipse(pad + left_w - 42, bottom - 46, 24, 24, fill=LIME)

    # middle code
    mx = pad * 2 + left_w
    a.rr(mx, top, mid_w, bottom - top, 14, fill=(7, 17, 26), outline=(255, 255, 255, 18), width=0.8)
    a.text(mx + 14, top + 14, "app_router.dart", 7.4, "medium", WHITE, mono=True)
    a.text(mx + 120, top + 14, "theme.dart", 7, "regular", MUTED, mono=True)
    a.line([(mx + 14, top + 30), (mx + mid_w - 14, top + 30)], (255, 255, 255, 16), 1)
    lines = [
        ("1", "final router = GoRouter(", PINK),
        ("2", "  routes: [", (255, 255, 255, 200)),
        ("3", "    GoRoute(", (255, 255, 255, 200)),
        ("4", "      path: '/',", LIME),
        ("5", "      builder: HomeScreen,", BLUE),
        ("6", "    ),", (255, 255, 255, 200)),
        ("7", "    GoRoute(", (255, 255, 255, 200)),
        ("8", "      path: '/users',", LIME),
        ("9", "      builder: UsersScreen,", BLUE),
        ("10", "    ),", (255, 255, 255, 200)),
        ("11", "  ],", (255, 255, 255, 200)),
        ("12", ");", (255, 255, 255, 200)),
        ("13", "", (255, 255, 255, 200)),
        ("14", "class AppTheme {", PINK),
        ("15", "  static ThemeData dark() {", (255, 255, 255, 200)),
        ("16", "    final scheme = ColorScheme.dark(", (255, 255, 255, 200)),
        ("17", "      primary: Color(0xFFC5FA75),", LIME),
        ("18", "      surface: Color(0xFF00101E),", LIME),
        ("19", "    );", (255, 255, 255, 200)),
        ("20", "    return ThemeData(", (255, 255, 255, 200)),
        ("21", "      useMaterial3: true,", BLUE),
        ("22", "      colorScheme: scheme,", BLUE),
        ("23", "      fontFamily: 'Inter',", LIME),
        ("24", "    );", (255, 255, 255, 200)),
        ("25", "  }", (255, 255, 255, 200)),
        ("26", "}", (255, 255, 255, 200)),
        ("27", "", (255, 255, 255, 200)),
        ("28", "// users feature", DIM),
        ("29", "final usersProvider = FutureProvider(", PINK),
        ("30", "  (ref) => ref.watch(repo).list(),", (255, 255, 255, 200)),
        ("31", ");", (255, 255, 255, 200)),
    ]
    ly = top + 46
    for num, code, color in lines:
        a.text(mx + 18, ly, num, 5.6, "regular", DIM, anchor="ra", mono=True)
        a.text(mx + 28, ly, code, 6.4, "regular", color, mono=True)
        ly += 15
    # problems panel
    a.rr(mx + 14, bottom - 288, mid_w - 28, 160, 10, fill=(255, 255, 255, 4), outline=(255, 255, 255, 14), width=0.6)
    a.text(mx + 24, bottom - 278, "PROBLEMS", 5.4, "demi", DIM)
    a.text(mx + mid_w - 24, bottom - 278, "0 errors · 1 hint", 5.4, "medium", GREEN, anchor="ra")
    problems = [
        ("hint", "Prefer const constructors", "app_router.dart:14", BLUE),
        ("info", "Unused import removed", "theme.dart:3", MUTED),
        ("ok", "All routes resolve", "app_router.dart", GREEN),
    ]
    py2 = bottom - 258
    for level, message, where, color in problems:
        a.ellipse(mx + 26, py2 + 2, 5, 5, fill=color)
        a.text(mx + 38, py2 - 1.5, message, 6.2, "medium", (255, 255, 255, 185))
        a.text(mx + 38, py2 + 7, where, 5.4, "regular", DIM, mono=True)
        py2 += 34

    a.rr(mx + 14, bottom - 104, mid_w - 28, 88, 10, fill=(0, 9, 16, 220), outline=(255, 255, 255, 14), width=0.6)
    a.text(mx + 24, bottom - 96, "TERMINAL", 5.4, "demi", DIM)
    a.text(mx + 24, bottom - 82, "$ flutter analyze", 6.2, "regular", WHITE, mono=True)
    a.text(mx + 24, bottom - 68, "✓ No issues found!", 6.2, "regular", GREEN, mono=True)
    a.text(mx + 24, bottom - 54, "$ flutter run -d chrome", 6.2, "regular", WHITE, mono=True)
    a.text(mx + 24, bottom - 40, "✓ Preview ready", 6.2, "regular", LIME, mono=True)

    # right preview
    rx = pad * 3 + left_w + mid_w
    a.rr(rx, top, right_w, bottom - top, 14, fill=INK_2, outline=(255, 255, 255, 18), width=0.8)
    a.text(rx + 16, top + 14, "Live preview", 8, "demi", WHITE)
    a.pill(rx + right_w - 76, top + 12, 60, 16, "● 5173", (197, 250, 117, 22), LIME, 6.2)
    a.rr(rx + 14, top + 38, right_w - 28, bottom - top - 52, 12, fill=(6, 16, 26), outline=(255, 255, 255, 16), width=0.7)
    # mini admin dashboard
    a.text(rx + 28, top + 52, "ApexAdmin", 12, "bold", WHITE)
    a.text(rx + 28, top + 68, "Dashboard", 6.2, "regular", MUTED)
    kpi(a, rx + 26, top + 84, (right_w - 64) / 2, 48, "USERS", "12.4k", "+8.2%")
    kpi(a, rx + 32 + (right_w - 64) / 2, top + 84, (right_w - 64) / 2, 48, "UPTIME", "99.9%", "+0.1%", PINK)
    a.rr(rx + 26, top + 142, right_w - 52, 104, 10, fill=PANEL_2, outline=LINE, width=0.6)
    a.text(rx + 36, top + 150, "Activity", 7, "demi", WHITE)
    a.chart(rx + 36, top + 164, right_w - 72, 70, LIME, 30, grid=False, seed=5)
    a.rr(rx + 26, top + 256, right_w - 52, 84, 10, fill=PANEL_2, outline=LINE, width=0.6)
    a.text(rx + 36, top + 264, "Roles", 7, "demi", WHITE)
    role_badge(a, rx + 36, top + 280, "Admin", LIME, INK, 44)
    role_badge(a, rx + 86, top + 280, "Editor", PINK, INK, 42)
    role_badge(a, rx + 134, top + 280, "Viewer", BLUE, INK, 44)

    # system health
    a.rr(rx + 26, top + 352, right_w - 52, 96, 10, fill=PANEL_2, outline=LINE, width=0.6)
    a.text(rx + 36, top + 360, "System health", 7, "demi", WHITE)
    a.text(rx + right_w - 36, top + 361, "99.9%", 6, "demi", GREEN, anchor="ra")
    for i, (label, value, color) in enumerate([("API", 0.94, GREEN), ("DB", 0.88, LIME), ("Workers", 0.76, AMBER)]):
        yy = top + 378 + i * 21
        a.text(rx + 36, yy, label, 5.8, "medium", MUTED)
        a.text(rx + right_w - 36, yy, f"{int(value * 100)}%", 5.8, "demi", color, anchor="ra")
        a.rr(rx + 70, yy + 2, right_w - 112, 4, 2, fill=(255, 255, 255, 14))
        a.rr(rx + 70, yy + 2, (right_w - 112) * value, 4, 2, fill=color)

    # audit log
    a.rr(rx + 26, top + 460, right_w - 52, 180, 10, fill=(8, 21, 33), outline=(255, 255, 255, 18), width=0.6)
    a.text(rx + 36, top + 468, "Audit log", 7, "demi", WHITE)
    a.text(rx + right_w - 36, top + 469, "View all", 5.8, "demi", LIME, anchor="ra")
    audits = [
        ("09:42", "Maya", "Updated role permissions"),
        ("09:18", "Noah", "Invited 3 viewers"),
        ("08:55", "System", "Nightly backup complete"),
        ("08:12", "Iris", "Exported analytics.csv"),
        ("07:40", "Maya", "Enabled 2FA policy"),
    ]
    ay = top + 488
    for time, actor, action in audits:
        a.text(rx + 36, ay, time, 5.2, "regular", DIM, mono=True)
        a.text(rx + 68, ay - 0.5, actor, 5.8, "demi", WHITE)
        a.text(rx + 100, ay - 0.5, action, 5.6, "regular", MUTED)
        ay += 26

    # analytics
    a.rr(rx + 26, top + 652, right_w - 52, 168, 10, fill=PANEL_2, outline=LINE, width=0.6)
    a.text(rx + 36, top + 660, "Analytics", 7, "demi", WHITE)
    a.text(rx + right_w - 36, top + 661, "This month", 5.6, "medium", MUTED, anchor="ra")
    for i, (label, value, delta, color) in enumerate([
        ("New users", "1,284", "+12%", LIME),
        ("Retention", "86%", "+4%", PINK),
        ("Reports", "312", "+9%", BLUE),
    ]):
        bx = rx + 36 + i * ((right_w - 92) / 3)
        a.text(bx, top + 682, value, 10, "bold", WHITE)
        a.text(bx, top + 696, label, 5.2, "medium", MUTED)
        a.text(bx, top + 706, delta, 5.2, "demi", color)
    a.chart(rx + 36, top + 720, right_w - 72, 84, LIME, 34, grid=False, seed=8)


# ─── editorial brand compositions ───────────────────────────────────────────


def brand_texture(a: Art, w, h, seed=1):
    """Dark metal gradient + film grain + vignette."""
    rnd = random.Random(seed)
    top = (4, 17, 29)
    bottom = (13, 41, 58)
    for y in range(a.img.height):
        t = y / max(1, a.img.height - 1)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
        a.d.line([(0, y), (a.img.width, y)], fill=color)
    # grid
    step = w / 14
    for i in range(15):
        a.line([(i * step, 0), (i * step, h)], (255, 255, 255, 7), 0.7)
    for j in range(9):
        a.line([(0, j * h / 8), (w, j * h / 8)], (255, 255, 255, 6), 0.7)
    # vignette
    vig = Image.new("L", (a.img.width, a.img.height), 0)
    vd = ImageDraw.Draw(vig)
    vd.ellipse(
        [-a.img.width * 0.25, -a.img.height * 0.35, a.img.width * 1.25, a.img.height * 1.35],
        fill=110,
    )
    vig = vig.filter(ImageFilter.GaussianBlur(a.p(60)))
    dark = Image.new("RGBA", a.img.size, (0, 4, 8, 255))
    a.img.paste(dark, (0, 0), Image.eval(vig, lambda v: 255 - v))
    # grain
    grain = Image.effect_noise(a.img.size, 14).convert("L")
    a.img.alpha_composite(Image.merge("RGBA", (grain, grain, grain, Image.new("L", a.img.size, 10))))


def brand_poster(a: Art, w, h, seed, headline, kicker, ring_color, text=True):
    """Simplified poster for small collage images: one card, big type."""
    # arcs top right
    a.ellipse(w * 0.52, -h * 0.35, w * 0.85, w * 0.85, outline=ring_color + (150,), width=1.6)
    a.ellipse(w * 0.62, -h * 0.22, w * 0.62, w * 0.62, outline=ring_color + (70,), width=1.0)

    # product card
    cw = w * 0.58
    ch = cw * 0.58
    cx, cy = w * 0.09, h * 0.10
    a.rr(cx, cy, cw, ch, 12, fill=(8, 22, 34, 235), outline=(255, 255, 255, 36), width=0.8)
    a.text(cx + cw * 0.08, cy + ch * 0.10, "ApexAdmin", min(w, h) * 0.048, "demi", WHITE)
    a.text(cx + cw * 0.08, cy + ch * 0.26, "Dashboard · live", min(w, h) * 0.032, "medium", MUTED)
    a.chart(cx + cw * 0.07, cy + ch * 0.38, cw * 0.86, ch * 0.48, ring_color, 34, grid=False, seed=seed)

    # AI badge
    br = min(w, h) * 0.10
    bx, by = w * 0.79, h * 0.38
    a.ellipse(bx - br, by - br, br * 2, br * 2, fill=(8, 22, 34, 235), outline=ring_color + (130,), width=1.2)
    a.text(bx, by - br * 0.12, "AI", br * 0.92, "bold", ring_color, anchor="mm")
    a.text(bx, by + br * 0.56, "BUILDER", br * 0.23, "demi", WHITE, anchor="mm")

    if text:
        # type
        size = min(w, h) * 0.13
        hy = h - size * 0.95 - h * 0.09
        a.text(w * 0.09, hy - size * 0.95, kicker, min(w, h) * 0.038, "bold", ring_color)
        a.text(w * 0.09, hy, headline, size, "bold", WHITE)
        if h > w:
            a.text(w * 0.09, h * 0.60, "PROVIDER · MATERIAL 3", min(w, h) * 0.030, "demi", MUTED)
    else:
        # small base markers keep the visible collage strips intentional
        a.text(w * 0.09, h * 0.61, "FLUTTERFORGE", min(w, h) * 0.032, "bold", ring_color)
        a.line([(w * 0.09, h * 0.645), (w * 0.09 + w * 0.22, h * 0.645)], ring_color + (120,), 1.2)
        a.text(w * 0.09, h * 0.68, "LOCAL · DART", min(w, h) * 0.026, "medium", MUTED)
        a.text(w * 0.91, h * 0.61, "01", min(w, h) * 0.045, "bold", WHITE, anchor="ra")
        a.text(w * 0.91, h * 0.68, "BUILD", min(w, h) * 0.026, "medium", MUTED, anchor="ra")

    # corner ticks
    for (tx, ty) in [(0.05, 0.05), (0.95, 0.05), (0.05, 0.95), (0.95, 0.95)]:
        a.line([(w * tx - 4, h * ty), (w * tx + 4, h * ty)], WHITE + (80,), 0.8)
        a.line([(w * tx, h * ty - 4), (w * tx, h * ty + 4)], WHITE + (80,), 0.8)


def brand_art(w, h, name, seed, headline, kicker="FLUTTERFORGE", accent="lime", jpeg=True, text=True):
    a = Art(w, h, 3, INK)
    brand_texture(a, w, h, seed)

    # big rings / arcs
    ring_color = LIME if accent == "lime" else PINK

    if min(w, h) < 320:
        brand_poster(a, w, h, seed, headline, kicker, ring_color, text=text)
        a.save(name, jpeg=jpeg)
        return

    a.ellipse(w * 0.55, -h * 0.18, w * 0.72, w * 0.72, outline=ring_color + (150,), width=2.2)
    a.ellipse(w * 0.62, -h * 0.10, w * 0.55, w * 0.55, outline=ring_color + (70,), width=1.2)

    # brand glows
    glow = Image.new("RGBA", a.img.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([a.p(w * 0.58), a.p(-h * 0.10), a.p(w * 1.15), a.p(h * 0.45)], fill=ring_color + (72,))
    gd.ellipse(
        [a.p(-w * 0.20), a.p(h * (0.55 if h > w else 0.58)), a.p(w * 0.35), a.p(h * (0.55 if h > w else 0.58) + w * 0.55)],
        fill=PINK + (72,),
    )
    a.img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(a.p(34))))

    # floating UI cards
    if h > w:
        card_w = w * 0.44
        cx = w * 0.53
        cy = h * 0.45
    else:
        card_w = w * 0.38
        cx = w * 0.44
        cy = h * 0.42
    card_h = card_w * 0.62
    a.rr(cx, cy, card_w, card_h, 18, fill=(8, 22, 34, 235), outline=(255, 255, 255, 36), width=0.9)
    a.text(cx + 18, cy + 15, "Step 7 of 13", 7.4, "demi", MUTED)
    a.rr(cx + 18, cy + 28, card_w - 36, 4, 2, fill=(255, 255, 255, 18))
    a.rr(cx + 18, cy + 28, (card_w - 36) * 0.56, 4, 2, fill=ring_color)
    for i, label in enumerate(["Intake", "UX Research", "Design", "Architecture"]):
        yy = cy + 44 + i * 20
        if i < 3:
            a.check(cx + 24, yy + 4, 4, ring_color, INK)
            a.text(cx + 34, yy - 1.5, label, 6.8, "medium", (255, 255, 255, 190))
        else:
            a.spinner(cx + 24, yy + 4, 4, ring_color, 1.3)
            a.text(cx + 34, yy - 1.5, label, 6.8, "demi", WHITE)

    card2_w = w * 0.36
    card2_h = card2_w * 0.72
    a.rr(w * 0.10, h * 0.18, card2_w, card2_h, 16, fill=(8, 22, 34, 225), outline=(255, 255, 255, 32), width=0.8)
    a.text(w * 0.10 + 14, h * 0.18 + 12, "ApexAdmin", 8, "demi", WHITE)
    a.chart(w * 0.10 + 14, h * 0.18 + 30, card2_w - 28, card2_h - 48, ring_color, 34, grid=False, seed=seed)

    # phone silhouette
    if h > w:
        pw = w * 0.20
        px = w * 0.72
        py = h * 0.42
    else:
        pw = w * 0.145
        px = w * 0.83
        py = h * 0.40
    ph = pw * 2.02
    a.rr(px, py, pw, ph, 24, fill=(10, 18, 26, 240), outline=(255, 255, 255, 34), width=0.8)
    a.rr(px + 6, py + 6, pw - 12, ph - 12, 19, fill=(6, 16, 26))
    a.text(px + pw / 2, py + ph * 0.18, "AI", pw * 0.26, "bold", ring_color, anchor="mm")
    a.text(px + pw / 2, py + ph * 0.32, "BUILDER", pw * 0.09, "demi", WHITE, anchor="mm")
    for i in range(4):
        a.rr(px + 12, py + ph * 0.42 + i * 14, pw - 24, 5, 2.5, fill=(255, 255, 255, 26))

    # type
    a.text(w * 0.07, h * 0.78, kicker, min(w, h) * 0.032, "bold", ring_color)
    size = min(w, h) * (0.082 if h > w else 0.075)
    # manual two-line headline
    words = headline.split()
    if len(words) > 1 and h > w:
        mid = len(words) // 2
        a.text(w * 0.07, h * 0.83, " ".join(words[:mid]), size, "bold", WHITE)
        a.text(w * 0.07, h * 0.83 + size * 1.02, " ".join(words[mid:]), size, "bold", WHITE)
    else:
        a.text(w * 0.07, h * 0.84, headline, size, "bold", WHITE)

    # corner ticks
    for (tx, ty) in [(0.04, 0.04), (0.96, 0.04), (0.04, 0.96), (0.96, 0.96)]:
        a.line([(w * tx - 6, h * ty), (w * tx + 6, h * ty)], WHITE + (90,), 1)
        a.line([(w * tx, h * ty - 6), (w * tx, h * ty + 6)], WHITE + (90,), 1)

    a.save(name, jpeg=jpeg)


# ─── brand blobs ────────────────────────────────────────────────────────────


def blob_art(name, w, h, top_color, bottom_color, seed):
    """Soft-edged organic shape with a vertical brand gradient."""
    a = Art(w, h, 2, (0, 0, 0, 0))
    cx, cy = w * 0.5, h * 0.52
    pts = []
    steps = 220
    for i in range(steps):
        t = 2 * math.pi * i / steps
        r = (
            0.415
            + 0.030 * math.sin(3 * t + seed)
            + 0.018 * math.sin(5 * t + seed * 2.3)
            + 0.006 * math.sin(7 * t + seed * 1.7)
        )
        pts.append((cx + math.cos(t) * r * w, cy + math.sin(t) * r * h))
    mask = Image.new("L", a.img.size, 0)
    ImageDraw.Draw(mask).polygon([(a.p(x), a.p(y)) for x, y in pts], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(a.p(5)))
    grad = Image.new("RGBA", a.img.size)
    gd = ImageDraw.Draw(grad)
    for y in range(a.img.height):
        t = y / max(1, a.img.height - 1)
        et = t * t * (3 - 2 * t)
        c = tuple(int(top_color[i] + (bottom_color[i] - top_color[i]) * et) for i in range(3)) + (255,)
        gd.line([(0, y), (a.img.width, y)], fill=c)
    # Keep straight alpha: pasting with a blurred mask would darken the RGB
    # along the soft edge and leave a dirty halo on the lime page.
    grad.putalpha(mask)
    a.img.alpha_composite(grad)
    a.save(name)


# ─── build all ──────────────────────────────────────────────────────────────


def build_phone(name, painter):
    a = Art(496, 1001, 3)
    box = phone_shell(a, 22, 18, 452, 965)
    paste_screen(a, box, painter)
    screen_glass(a, box)
    phone_status(a, box)
    a.save(name)


def build_detail(name, painter, width=496):
    a = Art(width, 1001, 3)
    painter(a, width, 1001)
    # Round the card itself; screen_bg fills the canvas, so mask the outer
    # corners back to transparency for the page background to show through.
    mask = Image.new("L", (a.img.width, a.img.height), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle(
        [0, 0, a.img.width - 1, a.img.height - 1],
        radius=a.p(40),
        fill=255,
    )
    a.img.putalpha(mask)
    a.save(name)


def main():
    OUT.mkdir(parents=True, exist_ok=True)

    build_phone("ff-hero-builder.png", hero_builder)
    build_phone("ff-hero-preview.png", hero_preview)
    build_phone("ff-hero-source.png", hero_source)
    build_phone("ff-hero-iterate.png", detail_iterate)

    build_detail("ff-detail-iterate.png", detail_iterate)
    build_detail("ff-detail-refine.png", detail_refine)
    build_detail("ff-detail-export.png", detail_export)

    a = Art(1672, 941, 2)
    workspace_wide(a, 1672, 941)
    a.save("ff-workspace-wide.png")

    blob_art("ff-blob-pink.png", 512, 512, (255, 240, 250), (244, 180, 227), 3)
    blob_art("ff-blob-lime.png", 512, 512, (226, 255, 158), (148, 222, 62), 7)
    blob_art("ff-blob-ink.png", 512, 512, (16, 42, 60), (0, 16, 30), 11)

    brand_art(666, 1000, "ff-studio-tall.jpg", 4, "MAKE SOMETHING REAL", accent="lime")
    brand_art(1000, 660, "ff-studio-wide.jpg", 9, "PROMPT TO PREVIEW", accent="pink")
    brand_art(1000, 660, "ff-story-front.jpg", 12, "REAL FILES. REAL SOURCE", accent="lime")
    brand_art(235, 300, "ff-story-left.jpg", 21, "LOCAL FIRST", accent="pink", text=False)
    brand_art(235, 300, "ff-story-right.jpg", 22, "AI BUILDER", accent="lime", text=False)
    brand_art(235, 300, "ff-testimonials-left.jpg", 31, "PREVIEW", accent="lime", text=False)
    brand_art(235, 300, "ff-testimonials-right.jpg", 32, "SOURCE", accent="pink", text=False)
    brand_art(290, 200, "ff-testimonials-front.jpg", 33, "SHIP IT", accent="lime")
    brand_art(666, 1000, "ff-intro-tall.jpg", 41, "IDEA TO APP", accent="lime")
    brand_art(1000, 660, "ff-intro-wide.jpg", 42, "YOUR NEXT APP", accent="pink")
    brand_art(666, 1000, "ff-closing-tall.jpg", 51, "MAKE IT YOURS", accent="pink")
    brand_art(1000, 660, "ff-closing-wide.jpg", 52, "LOOK AT THIS", accent="lime")


if __name__ == "__main__":
    main()
