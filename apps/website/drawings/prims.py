"""The primitives of the site's drawings: the palette (light and dark), the
classes the drawings use, and the shapes (text, card, person, agent, key,
lock, badge, arrow, pill). Read by gen.py.
"""
import html

# The values of @vaubaan/design-tokens (packages/design-tokens/src/palette.ts), light and dark:
# paper, hairline, ink, the one accent (also "ask me first"), the person (teal) and the agent
# (purple), allowed green, refused red (the only red), the four rows (green, cool grey, mauve,
# deep plum) and the code surface. No orange or yellow. Keep them equal to the tokens.
THEMES = {
 'light': dict(bg='#FBFBF9', surface='#FFFFFF', ink='#1B2128', muted='#56606B', line='#DDE1E6',
   accent='#2F55C7', accentSoft='#E8EDFB', accentInk='#1F3F9E', vault='#F1F2F4',
   human='#0B7F77', humanSoft='#D8F3F0', humanInk='#0B5F59',
   agent='#7A5FD0', agentSoft='#EFEAFB', agentInk='#4E3A99',
   ok='#13995A', okSoft='#DCF7E7', okInk='#0B6B3C',
   ask='#2F55C7', askSoft='#E8EDFB', askInk='#1F3F9E',
   stop='#C81E2A', stopSoft='#FDE4E4', stopInk='#A3121E',
   r1='#005F2E', r1Soft='#DFF8E6', r1B='#A6E3BB', r2='#434E5A', r2Soft='#EDF1F5', r2B='#CFD7E0',
   r3='#663B63', r3Soft='#FAEBF8', r3B='#E6C3E2', r4='#70155A', r4Soft='#FFDCF8', r4B='#F1A6DD',
   term='#15191D', termInk='#E6EAEE', termMuted='#97A1AC', termOk='#5CC48A', termAsk='#9DB7FF',
   termStop='#F08A76', onAccent='#FFFFFF'),
 'dark': dict(bg='#0E1215', surface='#151A1F', ink='#E8ECEF', muted='#A3ADB7', line='#2A333B',
   accent='#8FB0FF', accentSoft='#17254A', accentInk='#CBD9FF', vault='#1C2228',
   human='#3CC9BD', humanSoft='#0D302D', humanInk='#8EE6DC',
   agent='#A990F0', agentSoft='#26203D', agentInk='#D6CBFA',
   ok='#3DDC84', okSoft='#0D3320', okInk='#7EEAAA',
   ask='#8FB0FF', askSoft='#17254A', askInk='#CBD9FF',
   stop='#FF6B6B', stopSoft='#3F1215', stopInk='#FFA3A3',
   r1='#A1E3B7', r1Soft='#173221', r1B='#2C5A3B', r2='#C8D2DD', r2Soft='#282C30', r2B='#41474E',
   r3='#EAC3E5', r3Soft='#342633', r3B='#5A4058', r4='#FFBCEE', r4Soft='#48203C', r4B='#74365F',
   term='#0B0E11', termInk='#E6EAEE', termMuted='#8B96A1', termOk='#5CC48A', termAsk='#9DB7FF',
   termStop='#F08A76', onAccent='#0E1215'),
}
CLASSES = {  # class -> (property, token)
 'bg': ('fill', 'bg'), 'surface': ('fill', 'surface'), 'ink': ('fill', 'ink'), 'muted': ('fill', 'muted'),
 'line': ('stroke', 'line'), 'lineF': ('fill', 'line'), 'accent': ('fill', 'accent'), 'accentS': ('stroke', 'accent'),
 'accentSoft': ('fill', 'accentSoft'), 'accentInk': ('fill', 'accentInk'), 'accentInkS': ('stroke', 'accentInk'), 'vault': ('fill', 'vault'),
 'human': ('fill', 'human'), 'humanS': ('stroke', 'human'), 'humanSoft': ('fill', 'humanSoft'), 'humanInk': ('fill', 'humanInk'),
 'agent': ('fill', 'agent'), 'agentS': ('stroke', 'agent'), 'agentSoft': ('fill', 'agentSoft'), 'agentInk': ('fill', 'agentInk'),
 'ok': ('fill', 'ok'), 'okS': ('stroke', 'ok'), 'okSoft': ('fill', 'okSoft'), 'okInk': ('fill', 'okInk'),
 'ask': ('fill', 'ask'), 'askS': ('stroke', 'ask'), 'askSoft': ('fill', 'askSoft'), 'askInk': ('fill', 'askInk'),
 'stop': ('fill', 'stop'), 'stopS': ('stroke', 'stop'), 'stopSoft': ('fill', 'stopSoft'), 'stopInk': ('fill', 'stopInk'),
 **{f'r{n}{k}': (p, f'r{n}{t}') for n in (1, 2, 3, 4)
    for k, p, t in (('', 'fill', ''), ('Soft', 'fill', 'Soft'), ('B', 'stroke', 'B'))},
 'inkS': ('stroke', 'ink'), 'mutedS': ('stroke', 'muted'),
 'term': ('fill', 'term'), 'termInk': ('fill', 'termInk'), 'termMuted': ('fill', 'termMuted'),
 'termOk': ('fill', 'termOk'), 'termAsk': ('fill', 'termAsk'), 'termStop': ('fill', 'termStop'),
 'onAccent': ('fill', 'onAccent'), 'onAccentS': ('stroke', 'onAccent'),
}
BASE_CSS = ('text{font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif} '
 '.mono{font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace} '
 '.b{font-weight:600} .sb{font-weight:500} .thin{stroke-width:1.5} .mid{stroke-width:2} .thick{stroke-width:2.5} '
 '.dash{stroke-dasharray:6 6} .nofill{fill:none}')

def css(theme):
    t = THEMES[theme]
    return BASE_CSS + ' ' + ' '.join(f'.{c}{{{p}:{t[k]}}}' for c, (p, k) in CLASSES.items())

MARKERS = ''.join(
    f'<marker id="m-{c}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" '
    f'orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="{c}"/></marker>'
    for c in ('muted', 'accent', 'ink', 'ask', 'stop', 'ok', 'agent', 'human'))

# ---------- primitives ----------
def esc(s): return html.escape(s, quote=False)

def T(x, y, s, size=15, cls='ink', anchor='start', extra=''):
    return (f'<text x="{x}" y="{y}" font-size="{size}" text-anchor="{anchor}" class="{cls}" '
            f'xml:space="preserve"{extra}>{esc(s)}</text>')

def R(x, y, w, h, rx=16, cls='surface line thin'):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" class="{cls}"/>'

def card(x, y, w, h, title, band='vault', title_cls='ink b', size=15, right=None):
    """A card with a tinted header band, as in the harness drawings."""
    s = R(x, y, w, h)
    s += R(x, y, w, 40, 16, band) + f'<rect x="{x}" y="{y+24}" width="{w}" height="16" class="{band}"/>'
    s += f'<line x1="{x}" y1="{y+40}" x2="{x+w}" y2="{y+40}" class="line thin"/>'
    s += R(x, y, w, h, 16, 'nofill line thin')
    s += T(x + 18, y + 26, title, size, title_cls)
    if right: s += T(x + w - 18, y + 26, right, 13, 'muted mono', 'end')
    return s

def person(cx, cy, kind='human', r=22):
    return (f'<circle cx="{cx}" cy="{cy}" r="{r}" class="{kind}"/>'
            f'<circle cx="{cx}" cy="{cy - r*0.27:.1f}" r="{r*0.32:.1f}" class="surface"/>'
            f'<path d="M{cx - r*0.55:.1f} {cy + r*0.64:.1f} a{r*0.55:.1f} {r*0.45:.1f} 0 0 1 {r*1.1:.1f} 0z" class="surface"/>')

def bot(cx, cy, r=22):
    """The agent: a disc with a small screen face."""
    return (f'<circle cx="{cx}" cy="{cy}" r="{r}" class="agent"/>'
            f'<rect x="{cx - r*0.5:.1f}" y="{cy - r*0.38:.1f}" width="{r:.1f}" height="{r*0.7:.1f}" rx="{r*0.18:.1f}" class="surface"/>'
            f'<circle cx="{cx - r*0.2:.1f}" cy="{cy - r*0.03:.1f}" r="{r*0.09:.1f}" class="agent"/>'
            f'<circle cx="{cx + r*0.2:.1f}" cy="{cy - r*0.03:.1f}" r="{r*0.09:.1f}" class="agent"/>'
            f'<line x1="{cx}" y1="{cy - r*0.38:.1f}" x2="{cx}" y2="{cy - r*0.62:.1f}" class="nofill thick" stroke="currentColor" style="stroke:var(--x,inherit)"/>')

def keyicon(x, y, cls='accent', s=1.0):
    """A small key, head at (x, y)."""
    return (f'<g transform="translate({x} {y}) scale({s})">'
            f'<circle cx="0" cy="0" r="7" class="nofill thick {cls}S"/>'
            f'<path d="M7 0 H22 M17 0 V5 M21 0 V4" class="nofill thick {cls}S" stroke-linecap="round"/></g>')

def lock(x, y, cls='ink'):
    return (f'<g transform="translate({x} {y})"><rect x="-8" y="-2" width="16" height="12" rx="3" class="{cls}"/>'
            f'<path d="M-5 -2 V-6 a5 5 0 0 1 10 0 V-2" class="nofill mid {cls}S"/></g>')

def badge(cx, cy, kind):
    """ok tick, stop cross, ask diamond (the accent: your move)."""
    if kind == 'ok':
        return (f'<circle cx="{cx}" cy="{cy}" r="10" class="ok"/>'
                f'<path d="M{cx-5} {cy} l3.5 3.5 l6.5 -7" fill="none" class="surface" stroke-width="2.4" style="stroke:var(--s)"/>')
    if kind == 'stop':
        return (f'<circle cx="{cx}" cy="{cy}" r="10" class="stop"/>'
                f'<path d="M{cx-4} {cy-4} l8 8 M{cx+4} {cy-4} l-8 8" fill="none" stroke-width="2.4" style="stroke:var(--s)"/>')
    return (f'<rect x="{cx-7}" y="{cy-7}" width="14" height="14" rx="2" class="ask" transform="rotate(45 {cx} {cy})"/>')

def arrow(d, cls='accent', width='mid', dash=False):
    return f'<path d="{d}" class="nofill {cls}S {width}{" dash" if dash else ""}" marker-end="url(#m-{cls})"/>'

def pill(x, y, w, text, cls='accentSoft', tcls='accentInk mono sb', size=14, h=32):
    return R(x, y, w, h, h / 2, cls) + T(x + w / 2, y + h / 2 + size * 0.36, text, size, tcls, 'middle')

def label_on(x, y, text, cls='muted', size=13, anchor='middle'):
    """A label with a background knock-out so it reads over lines."""
    w = len(text) * size * 0.56 + 12
    x0 = x - w / 2 if anchor == 'middle' else (x - w if anchor == 'end' else x - 6)
    return R(f'{x0:.0f}', y - size - 2, f'{w:.0f}', size + 9, 6, 'bg') + T(x, y, text, size, cls, anchor)

