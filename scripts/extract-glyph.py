#!/usr/bin/env python3
"""Outlines the capital S of the display face for scripts/build-icons.mjs.

The icon draws its initial as a path so that opening the SVG never depends on a
font being installed. That path is pasted into build-icons.mjs, so this only
needs running when the display face changes.

    python3 -m venv .venv && .venv/bin/pip install fonttools
    .venv/bin/python scripts/extract-glyph.py

Prints the path data and the glyph bounds. Copy both into the GLYPH and BOUNDS
constants in scripts/build-icons.mjs.

Young Serif is OFL licensed, which permits shipping the outline. Keep FONT_URL
pinned to a tag rather than main so the glyph is reproducible.
"""
import urllib.request

from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen

FONT_URL = "https://github.com/google/fonts/raw/main/ofl/youngserif/YoungSerif-Regular.ttf"
CHARACTER = "S"

with urllib.request.urlopen(FONT_URL) as response:
    font = TTFont(response)

glyphs = font.getGlyphSet()
name = font.getBestCmap()[ord(CHARACTER)]

bounds = BoundsPen(glyphs)
glyphs[name].draw(bounds)

pen = SVGPathPen(glyphs, ntos=lambda v: str(round(v)))
glyphs[name].draw(pen)

print(f"BOUNDS = {list(bounds.bounds)}")
print(f"GLYPH = '{pen.getCommands()}'")
