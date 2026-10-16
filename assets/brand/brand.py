import math, os, io, sys
import cairosvg
from PIL import Image
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

ROOT = sys.argv[1]
FONTS = sys.argv[2]
R, C = 32.0, 50.0
INK, ACC = "#1C2B24", "#3E8E5E"
INK_D, ACC_D = "#E9EFEB", "#6FBF8E"
TILE, TILE_D = "#E2E9E5", "#17251F"
SUB, SUB_D = "#55655D", "#9FB3A8"

def pt(a, r=R):
    t = math.radians(a)
    return C + r * math.cos(t), C + r * math.sin(t)

def f(p):
    return f"{p[0]:.2f} {p[1]:.2f}"

def theta(dist):
    return 2 * math.degrees(math.asin(dist / (2 * R)))

def taper(a0, a1, w0, w1, fill, n=48):
    o, i = [], []
    for k in range(n + 1):
        t = k / n
        a = a0 + (a1 - a0) * t
        w = w0 + (w1 - w0) * t
        o.append(pt(a, R + w / 2))
        i.append(pt(a, R - w / 2))
    d = "M" + f(o[0]) + " " + " ".join("L" + f(p) for p in o[1:]) + " " + " ".join("L" + f(p) for p in reversed(i)) + " Z"
    s, e = pt(a0), pt(a1)
    return (f'<path d="{d}" {fill}/>'
            f'<circle cx="{s[0]:.2f}" cy="{s[1]:.2f}" r="{w0/2:.2f}" {fill}/>'
            f'<circle cx="{e[0]:.2f}" cy="{e[1]:.2f}" r="{w1/2:.2f}" {fill}/>')

def uniform(a0, a1, w, stroke):
    s, e = pt(a0), pt(a1)
    return f'<path d="M{f(s)} A32 32 0 0 1 {f(e)}" fill="none" {stroke} stroke-width="{w}" stroke-linecap="round"/>'

def paint(role, pal):
    color, alpha = pal[role]
    op = "" if alpha >= 1 else f' fill-opacity="{alpha}"'
    return f'fill="{color}"{op}'

def stroke_paint(role, pal):
    color, alpha = pal[role]
    op = "" if alpha >= 1 else f' stroke-opacity="{alpha}"'
    return f'stroke="{color}"{op}'

def primary(pal, template=False):
    # 定稿：绿点在左、黑点在右；黑弧在上（右细→左粗），绿弧在下（左细→右粗）
    thin, thick, node, gap = (8, 14, 12, 3) if template else (6, 13, 10.5, 3.5)
    tk = theta(node + gap + thick / 2)
    tn = theta(node + gap + thin / 2)
    top = taper(180 + tk, 360 - tn, thick, thin, paint("ink", pal))
    bottom = taper(tk, 180 - tn, thick, thin, paint("acc", pal))
    nodes = (f'<circle cx="18" cy="50" r="{node}" {paint("acc", pal)}/>'
             f'<circle cx="82" cy="50" r="{node}" {paint("ink", pal)}/>')
    return top + bottom + nodes

def alternate(pal, template=False):
    # 备选：等粗圆头弧线；黑点在左、绿点在右；黑弧在上，绿弧在下
    w, node, gap = (11, 12, 3) if template else (9, 10, 4)
    t = theta(node + gap + w / 2)
    top = uniform(180 + t, 360 - t, w, stroke_paint("ink", pal))
    bottom = uniform(t, 180 - t, w, stroke_paint("acc", pal))
    nodes = (f'<circle cx="18" cy="50" r="{node}" {paint("ink", pal)}/>'
             f'<circle cx="82" cy="50" r="{node}" {paint("acc", pal)}/>')
    return top + bottom + nodes

PAL = {
    "light": {"ink": (INK, 1), "acc": (ACC, 1)},
    "dark": {"ink": (INK_D, 1), "acc": (ACC_D, 1)},
    "mono": {"ink": ("#111111", 1), "acc": ("#111111", 1)},
    "template": {"ink": ("#000000", 1), "acc": ("#000000", 0.55)},
}

def svg(w, h, body, vb=None):
    vb = vb or f"0 0 {w} {h}"
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="{vb}">{body}</svg>'

def mark_svg(fn, pal, template=False):
    return svg(100, 100, fn(PAL[pal], template), "4 4 92 92")

def placed(fn, pal, cx, cy, size, template=False):
    s = size / 92
    return f'<g transform="translate({cx},{cy}) scale({s:.5f}) translate(-50,-50)">{fn(PAL[pal], template)}</g>'

def app_icon(fn, dark=False):
    tile = TILE_D if dark else TILE
    body = f'<rect x="100" y="100" width="824" height="824" rx="185" fill="{tile}"/>' + placed(fn, "dark" if dark else "light", 512, 512, 590)
    return svg(1024, 1024, body)

def full_bleed(fn, size, ratio):
    body = f'<rect width="{size}" height="{size}" fill="{TILE}"/>' + placed(fn, "light", size / 2, size / 2, size * ratio)
    return svg(size, size, body)

class Font:
    def __init__(self, path):
        self.tt = TTFont(path)
        self.gs = self.tt.getGlyphSet()
        self.cmap = self.tt.getBestCmap()
        self.upm = self.tt["head"].unitsPerEm
        self.cap = getattr(self.tt["OS/2"], "sCapHeight", 0) or 0.7 * self.upm

    def text(self, s, x, baseline, size, tracking, color):
        k = size / self.upm
        out, cx = [], x
        for ch in s:
            g = self.cmap.get(ord(ch))
            if ch == " " or g is None:
                cx += (self.gs[g].width if g else self.upm * 0.3) * k + tracking * size
                continue
            pen = SVGPathPen(self.gs)
            self.gs[g].draw(TransformPen(pen, (k, 0, 0, -k, cx, baseline)))
            d = pen.getCommands()
            if d:
                out.append(f'<path d="{d}" fill="{color}"/>')
            cx += self.gs[g].width * k + tracking * size
        return "".join(out), cx - tracking * size - x

def lockup(fn, sans, mono, dark=False):
    ink, sub = (INK_D, SUB_D) if dark else (INK, SUB)
    mark = placed(fn, "dark" if dark else "light", 100, 100, 200)
    word, ww = sans.text("ARC", 236, 128, 128, 0.04, ink)
    tag, tw = mono.text("AGENT REMOTE CONTROL", 240, 168, 22, 0.1, sub)
    width = int(236 + max(ww, tw + 4) + 12)
    return svg(width, 200, mark + word + tag), width

def png(svg_text, path, w, h=None):
    cairosvg.svg2png(bytestring=svg_text.encode(), write_to=path, output_width=w, output_height=h or w)

def build(name, fn):
    base = os.path.join(ROOT, name)
    for d in ("svg", "png", "icons", "social"):
        os.makedirs(os.path.join(base, d), exist_ok=True)
    sans = Font(os.path.join(FONTS, "geist-sans/Geist-Bold.ttf"))
    mono = Font(os.path.join(FONTS, "geist-mono/GeistMono-Regular.ttf"))
    files = {
        "mark.svg": mark_svg(fn, "light"),
        "mark-dark.svg": mark_svg(fn, "dark"),
        "mark-mono.svg": mark_svg(fn, "mono"),
        "mark-template.svg": mark_svg(fn, "template", True),
        "app-icon.svg": app_icon(fn),
        "app-icon-dark.svg": app_icon(fn, True),
    }
    lk, lw = lockup(fn, sans, mono)
    lkd, _ = lockup(fn, sans, mono, True)
    files["lockup.svg"] = lk
    files["lockup-dark.svg"] = lkd
    for fname, text in files.items():
        with open(os.path.join(base, "svg", fname), "w") as fh:
            fh.write(text)
    for s in (16, 32, 64, 128, 256, 512, 1024):
        png(files["app-icon.svg"], os.path.join(base, "png", f"app-icon-{s}.png"), s)
    png(files["app-icon-dark.svg"], os.path.join(base, "png", "app-icon-dark-1024.png"), 1024)
    for s in (256, 512, 1024):
        png(files["mark.svg"], os.path.join(base, "png", f"mark-{s}.png"), s)
    for s in (16, 18, 22):
        png(files["mark-template.svg"], os.path.join(base, "png", f"menubar-{s}Template.png"), s)
        png(files["mark-template.svg"], os.path.join(base, "png", f"menubar-{s}Template@2x.png"), s * 2)
    png(lk, os.path.join(base, "png", "lockup-1200.png"), 1200, int(1200 * 200 / lw))
    src = Image.open(os.path.join(base, "png", "app-icon-1024.png")).convert("RGBA")
    src.save(os.path.join(base, "icons", "AppIcon.icns"))
    src.save(os.path.join(base, "icons", "app.ico"), sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
    fav = os.path.join(base, "png", "mark-256.png")
    Image.open(fav).convert("RGBA").save(os.path.join(base, "icons", "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])
    light_g = fn(PAL["light"])
    dark_g = fn(PAL["dark"])
    favsvg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="4 4 92 92">'
              '<style>.d{display:none}@media (prefers-color-scheme: dark){.l{display:none}.d{display:inline}}</style>'
              f'<g class="l">{light_g}</g><g class="d">{dark_g}</g></svg>')
    with open(os.path.join(base, "icons", "favicon.svg"), "w") as fh:
        fh.write(favsvg)
    png(full_bleed(fn, 180, 0.62), os.path.join(base, "icons", "apple-touch-icon.png"), 180)
    png(full_bleed(fn, 400, 0.6), os.path.join(base, "social", "x-avatar-400.png"), 400)
    scale = 680 / lw
    og = svg(1200, 630, f'<rect width="1200" height="630" fill="{TILE}"/>'
             f'<g transform="translate({(1200 - 680) / 2:.1f},{315 - 100 * scale:.1f}) scale({scale:.4f})">{lk[lk.index(">") + 1:-6]}</g>')
    png(og, os.path.join(base, "social", "og-card-1200x630.png"), 1200, 630)

build("primary", primary)
build("alternate", alternate)
print("ok")
