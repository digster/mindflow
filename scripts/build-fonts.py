"""
Builds the typefaces MindFlow ships into `src/fonts/`.

    npm run fonts      # after `npm install`; needs uv (https://docs.astral.sh/uv/)

The output is committed, like `src/ui/icons.ts`: the build inlines these files
and never runs this script. Run it only after changing the manifest below or
upgrading a source package.

Why ship fonts at all
---------------------
Text layout is part of the published format: `docs/07-rendering.md` specifies
where a line breaks, and the answer depends on how wide each glyph is. With
system fonts, `sans` was San Francisco on a Mac, Segoe UI on Windows and
something else on Linux, so the same board broke its lines differently on each.
It also meant a PDF could not carry real text, because a web page cannot read
the system font the canvas measured with. With these files, every renderer,
MindFlow's canvas, its text editor, its PDF writer and anyone else's, measures
with the same numbers.

What each face gets
-------------------
- **Subset to Latin.** Basic Latin, Latin-1, Latin Extended-A and common
  punctuation, arrows and symbols. That covers most European languages in
  about 25–40 KB a face. Anything else falls back to a system font, per glyph,
  exactly as before.
- **No kerning, ligatures or other layout features** (GSUB, GPOS, GDEF and
  kern dropped). With them, a string's width depends on the shaping engine,
  and the canvas, the DOM and a PDF viewer each shape differently. Without
  them, a string is exactly as wide as the sum of its glyphs' advance widths,
  which is what `docs/07-rendering.md` specifies and a PDF viewer does.
  `test/e2e/fonts.spec.ts` checks the canvas agrees to within 0.01 px.
- **No hinting.** Hinting instructions and the device-metric tables (hdmx,
  VDMX, LTSH) let a rasteriser round advance widths to whole pixels at some
  sizes, which would break the same guarantee.
- **Timestamps kept from the source**, so a rerun with unchanged inputs
  produces byte-identical files and no diff.

Two faces per family: `regular` for weights below 550 and `bold` for 550 and
above. The app registers them with those weight ranges, so the browser never
synthesises a bolder face, and the PDF writer applies the same rule.

Licences
--------
Every source is SIL Open Font License 1.1 with no Reserved Font Name, so the
subsets may keep their names. `LICENSES.md` is written alongside them with each
family's copyright notice and licence text, which the OFL requires.
"""

from __future__ import annotations

import pathlib

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCES = ROOT / "node_modules" / "@expo-google-fonts"
OUT = ROOT / "src" / "fonts"

# (logical family, role, source package, file within the package)
FACES = [
    ("sans", "regular", "inter", "400Regular/Inter_400Regular.ttf"),
    ("sans", "bold", "inter", "600SemiBold/Inter_600SemiBold.ttf"),
    ("serif", "regular", "noto-serif", "400Regular/NotoSerif_400Regular.ttf"),
    ("serif", "bold", "noto-serif", "600SemiBold/NotoSerif_600SemiBold.ttf"),
    ("mono", "regular", "jetbrains-mono", "400Regular/JetBrainsMono_400Regular.ttf"),
    ("mono", "bold", "jetbrains-mono", "600SemiBold/JetBrainsMono_600SemiBold.ttf"),
    # Kalam has no 600, so its bold role is its 700.
    ("hand", "regular", "kalam", "400Regular/Kalam_400Regular.ttf"),
    ("hand", "bold", "kalam", "700Bold/Kalam_700Bold.ttf"),
]

# Basic Latin, Latin-1 Supplement and Latin Extended-A, plus the punctuation,
# arrows and symbols people type into notes. A face that lacks one of these
# simply leaves it out.
UNICODES = [
    *range(0x0020, 0x007F),
    *range(0x00A0, 0x0180),
    0x0192, 0x02C6, 0x02C7, 0x02DA, 0x02DC,
    *range(0x2010, 0x2028),
    0x2030, 0x2032, 0x2033, 0x2039, 0x203A, 0x2044,
    0x20AC, 0x2122,
    *range(0x2190, 0x2194),
    0x2212, 0x2215, 0x2248, 0x2260, 0x2264, 0x2265,
    0xFFFD,
]

DROPPED_TABLES = [
    # Layout features: see "What each face gets" above.
    "GSUB", "GPOS", "GDEF", "kern", "morx", "kerx",
    # Hinting and device metrics.
    "hdmx", "VDMX", "LTSH", "gasp",
    # Variations and a signature the subset would invalidate.
    "STAT", "MVAR", "HVAR", "fvar", "gvar", "avar", "DSIG",
]


def options() -> subset.Options:
    opts = subset.Options()
    opts.layout_features = []
    opts.hinting = False
    opts.drop_tables = sorted(set(opts.drop_tables) | set(DROPPED_TABLES))
    # Copyright, names, version, and the licence description and URL.
    opts.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    opts.name_languages = [0x0409]
    opts.notdef_outline = True
    opts.recalc_timestamp = False
    return opts


def build_face(family: str, role: str, package: str, file: str) -> pathlib.Path:
    source = SOURCES / package / file
    if not source.exists():
        raise SystemExit(f"missing {source}; run `npm install` first")

    font = TTFont(source, recalcTimestamp=False)
    subsetter = subset.Subsetter(options())
    subsetter.populate(unicodes=UNICODES)
    subsetter.subset(font)

    out = OUT / f"{family}-{role}.ttf"
    font.save(out)
    return out


def write_licences() -> None:
    sections = [
        "# Font licences",
        "",
        "Generated by `scripts/build-fonts.py`. The fonts in this folder are",
        "Latin subsets of the typefaces below, with layout features and hinting",
        "removed. Each is licensed under the SIL Open Font License 1.1, reproduced",
        "with its copyright notice.",
    ]
    for package in dict.fromkeys(face[2] for face in FACES):
        licence = (SOURCES / package / "LICENSE_FONT").read_text(encoding="utf-8").strip()
        used = ", ".join(f"`{f}-{r}.ttf`" for f, r, p, _ in FACES if p == package)
        sections += ["", "---", "", f"## {package} ({used})", "", "```", licence, "```"]
    (OUT / "LICENSES.md").write_text("\n".join(sections) + "\n", encoding="utf-8")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for face in FACES:
        path = build_face(*face)
        print(f"[fonts] {path.relative_to(ROOT)} — {path.stat().st_size / 1024:.1f} kB")
    write_licences()


if __name__ == "__main__":
    main()
