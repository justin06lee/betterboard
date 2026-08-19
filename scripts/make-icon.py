#!/usr/bin/env python3
"""Generates the betterboard mark: a single pressure-tapered stroke entering
from beyond the left edge and lifting inside the frame — an endless surface,
and real ink on it.

Writes the identical artwork to both destinations, so the README banner and the
app icon are the same picture and cannot drift apart:

    python3 scripts/make-icon.py
"""
import argparse
import math

S = 1024  # canvas
INK_A, INK_B = "#5ad2f5", "#b9ecff"
TILE_A, TILE_B = "#20242e", "#0e0f14"
GRID = "#333846"


def bezier(p0, p1, p2, p3, t):
    u = 1 - t
    return (
        u**3 * p0[0] + 3 * u**2 * t * p1[0] + 3 * u * t**2 * p2[0] + t**3 * p3[0],
        u**3 * p0[1] + 3 * u**2 * t * p1[1] + 3 * u * t**2 * p2[1] + t**3 * p3[1],
    )


def smoothstep(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def width(t):
    """Pressure: already moving as it crosses the edge, bearing down through the
    belly, lifting to a point at the flick. Deliberately smooth end to end — a
    piecewise profile leaves visible kinks along the edge of the stroke."""
    press = 0.42 + 0.58 * smoothstep(t / 0.30)
    lift = (1 - smoothstep((t - 0.50) / 0.50)) ** 0.85
    return press * lift


def stroke_path(thickest=150.0):
    # Sweeps in low from the left, rises through the middle, flicks up and away.
    p0, p1, p2, p3 = (-90, 690), (250, 880), (610, 205), (930, 300)
    n = 240
    pts = [bezier(p0, p1, p2, p3, i / n) for i in range(n + 1)]

    left, right = [], []
    for i, (x, y) in enumerate(pts):
        t = i / n
        a = pts[max(0, i - 1)]
        b = pts[min(n, i + 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / length, dx / length
        half = width(t) * thickest / 2
        left.append((x + nx * half, y + ny * half))
        right.append((x - nx * half, y - ny * half))

    ring = left + right[::-1]
    d = [f"M{ring[0][0]:.1f},{ring[0][1]:.1f}"]
    # Midpoint-quadratic smoothing, the same trick the app uses for its own ink.
    for i in range(1, len(ring)):
        x0, y0 = ring[i - 1]
        x1, y1 = ring[i]
        d.append(f"Q{x0:.1f},{y0:.1f} {(x0 + x1) / 2:.1f},{(y0 + y1) / 2:.1f}")
    d.append("Z")
    return " ".join(d)


def dots(spacing=88, r=6.5):
    out = []
    start = spacing // 2
    for y in range(start, S, spacing):
        for x in range(start, S, spacing):
            # Fade toward the edges so the grid sits behind the mark.
            fade = 1 - (abs(x - S / 2) + abs(y - S / 2)) / (S * 1.15)
            if fade <= 0.12:
                continue
            out.append(f'<circle cx="{x}" cy="{y}" r="{r}" opacity="{fade * 0.8:.3f}"/>')
    return "\n      ".join(out)


def svg() -> str:
    radius = 232  # the rounded tile every platform expects of an app icon
    corner = f' rx="{radius}" ry="{radius}"'
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}" width="{S}" height="{S}" role="img" aria-label="betterboard">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{TILE_A}"/>
      <stop offset="1" stop-color="{TILE_B}"/>
    </linearGradient>
    <linearGradient id="ink" x1="0.05" y1="0.85" x2="0.92" y2="0.18">
      <stop offset="0" stop-color="{INK_A}"/>
      <stop offset="1" stop-color="{INK_B}"/>
    </linearGradient>
    <clipPath id="tile-clip">
      <rect x="0" y="0" width="{S}" height="{S}"{corner}/>
    </clipPath>
  </defs>

  <rect x="0" y="0" width="{S}" height="{S}"{corner} fill="url(#tile)"/>

  <g clip-path="url(#tile-clip)">
    <g fill="{GRID}">
      {dots()}
    </g>
    <path d="{stroke_path()}" fill="url(#ink)"/>
  </g>

  <rect x="4" y="4" width="{S - 8}" height="{S - 8}" rx="{radius - 4}" ry="{radius - 4}"
        fill="none" stroke="#ffffff" stroke-opacity="0.07" stroke-width="8"/>
</svg>
"""


DESTINATIONS = ("assets/icon.svg", "assets/betterboard.svg")

if __name__ == "__main__":
    argparse.ArgumentParser(description=__doc__).parse_args()
    art = svg()
    for out in DESTINATIONS:
        with open(out, "w") as fh:
            fh.write(art)
    print("wrote " + " and ".join(DESTINATIONS) + " (identical)")
