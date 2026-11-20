"""The drawings of vaubaan.com and of the README.

Two projects, every drawing in both (website spec §2.1):
  dev        — a developer, "Rate limiter for the API": GitHub, and Supabase
  consultant — a consultant, "Weekly client recap": Gmail, Notion, Google Calendar
Each drawing in a light and a dark version:
  svg/<name>[-consultant]-<light|dark>.svg, and svg/drawings.json (title, description, size).

Every permission, row, verb, gate and limit comes from facts.json, written from the
risk catalogs by `npx tsx apps/website/scripts/drawing-facts.ts`; a test of the site
fails when the catalogs and facts.json disagree. Run, from the repository root:

  npx tsx apps/website/scripts/drawing-facts.ts && python3 apps/website/drawings/gen.py

Only the short names of the permissions (SHORT) and the scenes are written here.
Nothing in a drawing may promise what is not built (the honesty rule of the site).
"""
import json, os, re, sys, textwrap
sys.dont_write_bytecode = True  # no __pycache__ beside the sources
from prims import *  # noqa: F401,F403  (tokens, primitives)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'svg')
PLUGINS = os.path.join(HERE, '..', '..', '..', 'plugins')
FACTS = json.load(open(os.path.join(HERE, 'facts.json')))
TOTALS = FACTS['totals']

NAMES = {'GitHub': 'github', 'Gmail': 'gmail', 'Notion': 'notion', 'Calendar': 'google-calendar',
         'Google Calendar': 'google-calendar', 'Supabase': 'supabase', 'Vercel': 'vercel'}
ICONS = {}
for svc_id in set(NAMES.values()):
    src = open(os.path.join(PLUGINS, svc_id, 'src', 'icon.ts')).read()
    d = re.search(r"_ICON =\s*'([^']+)'", src).group(1)
    c = re.search(r"_ICON_COLOR = '(#[0-9A-Fa-f]{6})'", src).group(1)
    ICONS[svc_id] = (d, c)
def logo(name, x, y, size=20):
    """The service's mark (from its plugin's icon.ts), top-left at (x, y)."""
    d, c = ICONS[NAMES.get(name, name)]
    r, g, b = (int(c[i:i+2], 16) for i in (1, 3, 5))
    dark = (0.299*r + 0.587*g + 0.114*b) < 60
    fill = 'class="ink"' if dark else f'fill="{c}"'
    return f'<g transform="translate({x} {y}) scale({size/24:.4f})"><path d="{d}" {fill}/></g>'
def logo_label(name, x, y, size, tsize, cls='ink b', anchor='middle', label=None):
    """A mark followed by the name, centred on x (anchor middle) on baseline y."""
    label = label or name
    tw = len(label) * tsize * 0.6
    total = size + 8 + tw
    x0 = x - total / 2 if anchor == 'middle' else x
    return logo(name, f'{x0:.0f}', f'{y - tsize*0.36 - size/2:.0f}', size) + T(f'{x0 + size + 8:.0f}', y, label, tsize, cls)

DRAWINGS = []
def drawing(name, w, h):
    def deco(fn):
        DRAWINGS.append((name, w, h, fn))
        return fn
    return deco
def frame(w, h): return R(0, 0, w, h, 24, 'bg line thin')

# The rows of the risk model, worst first: name, band classes, word class.
ROWS = {4: ('Cannot be repaired', 'r4Soft r4B thin', 'r4'), 3: ('Repairable, at a price', 'r3Soft r3B thin', 'r3'),
        2: ('Worth a look', 'r2Soft r2B thin', 'r2'), 1: ('Harmless', 'r1Soft r1B thin', 'r1')}
LEVELS = {'careful': 1, 'trusting': 3, 'autonomous': 10}
GATE_BADGE = {'auto': 'ok', 'approval': 'ask', None: 'stop'}

# ---------- the catalogs, through facts.json ----------
SHORT = {
 'github.read-code': 'Read code', 'github.read-meta': 'Read PRs and issues',
 'github.search-global': 'Search all of GitHub', 'github.feature-branch-write': 'Feature branches',
 'github.bulk-file-write': 'Push many files', 'github.create-pr': 'Open a PR', 'github.comment-write': 'Comment',
 'github.label-write': 'Label', 'github.issue-write': 'Edit an issue', 'github.git-push': 'git push',
 'github.force-push': 'Force-push', 'github.branch-delete': 'Delete a branch',
 'github.merge-protected': 'Merge into main', 'github.create-release': 'Create a release',
 'github.delete-release': 'Delete a release', 'github.tag-write': 'Push a tag',
 'github.workflow-write-via-file': 'Workflow files', 'github.branch-protection-write': 'Branch protection',
 'gmail.read-mailbox': 'Mailbox structure', 'gmail.read-from-zone-automated': 'Notifications',
 'gmail.read-from-zone-internal': 'Colleagues’ mail', 'gmail.read-from-zone-known-external': 'Clients’ mail',
 'gmail.read-from-zone-unknown': 'Unknown senders', 'gmail.read-drafts': 'Drafts',
 'gmail.read-sensitive-label': 'Sensitive labels', 'gmail.bulk-read': 'Bulk search',
 'gmail.draft-write': 'Any draft', 'gmail.draft-to-zone-self': 'To yourself',
 'gmail.draft-to-zone-internal': 'To colleagues', 'gmail.draft-to-zone-allowlist': 'To clients',
 'gmail.send-to-zone-self': 'Send to yourself', 'gmail.send-to-zone-internal': 'Send to colleagues',
 'gmail.send-to-zone-allowlist': 'Send to clients', 'gmail.send-to-zone-external': 'Send to anyone',
 'gmail.label-write': 'Label a thread', 'gmail.label-create': 'Create a label', 'gmail.bulk-label-write': 'Label in bulk',
}

def svc(sid): return FACTS['services'][sid]
def macro(sid, mid): return next(m for m in svc(sid)['macroActions'] if m['id'] == mid)
def entry(rid):
    sid = rid.split('.')[0]
    for m in svc(sid)['macroActions']:
        for e in m['entries']:
            if e['id'] == rid: return e
    raise KeyError(rid)
def short(rid):
    if rid not in SHORT: raise SystemExit(f'gen.py: no short name for {rid}: add it to SHORT')
    return SHORT[rid]
def quota(rid, level): return entry(rid)['quota'] * LEVELS[level]
def fmt(n): return f'{n:,}'.replace(',', ' ')

def map_of(sid):
    """{row: {macro label: [short names]}} and the column labels, catalog order."""
    cols, rows = [], {1: {}, 2: {}, 3: {}, 4: {}}
    for m in svc(sid)['macroActions']:
        cols.append(m['label'])
        for e in m['entries']:
            name = short(e['id'])
            if name.startswith('Send to'): name = 'To' + name[len('Send to'):]
            rows[e['row']].setdefault(m['label'], []).append(name)
    return cols, rows

def reasons_of(sid):
    """Each row's reasons, the words of the tree's branches, two at most."""
    out = {}
    for m in svc(sid)['macroActions']:
        for e in m['entries']:
            if not e.get('reason'): continue
            words = e['reason'].replace('-', ' ')
            if words not in out.setdefault(e['row'], []): out[e['row']].append(words)
    return {r: ' · '.join(v[:2]) for r, v in out.items()}

def ticked_lines(sid, mids, level):
    lines = []
    for mid in mids:
        for e in macro(sid, mid)['entries']:
            lines.append((short(e['id']), GATE_BADGE[e[level]], fmt(e['quota'] * LEVELS[level])))
    return lines

def verbs_of(sid):
    return [(m['label'], m['description'], len(m['entries'])) for m in svc(sid)['macroActions']]

def model_line():
    return (f'{TOTALS["services"]} services modelled the same way: {TOTALS["planes"]} planes, '
            f'{TOTALS["permissions"]} permissions, {TOTALS["macroActions"]} verbs.')

GH, GM, SB = svc('github'), svc('gmail'), svc('supabase')
GH_COLS, GH_MAP = map_of('github')
GM_COLS, GM_MAP = map_of('gmail')
GH_TICKS = ['read', 'propose']
GM_TICKS = ['search', 'send']
GH_LINES = ticked_lines('github', GH_TICKS, 'trusting')
GM_LINES = ticked_lines('gmail', GM_TICKS, 'trusting')
# What the scenes say in words; redraw when one of them stops being true.
assert entry('supabase.bulk-row-write')['envs'] == ['preview', 'staging'], 'bulk row writes gained a production form: redraw'
assert entry('supabase.migration-write')['autonomous'] == 'auto', 'a staging migration no longer runs at Autonomous: redraw'
assert entry('github.merge-protected')['trusting'] == 'approval', 'merging into main no longer asks at Trusting: redraw'
assert entry('gmail.send-to-zone-allowlist')['trusting'] == 'approval', 'a mail to a client no longer asks at Trusting: redraw'
assert entry('gmail.read-sensitive-label')['row'] == 2

# =====================================================================
# The two projects
# =====================================================================
DEV = dict(
 key='dev',
 hero=dict(
  desc='Your coding agent holds a mission key. Vaubaan holds the credentials, runs what the mission allows, refuses the rest, and asks you before what is hard to undo.',
  lines=['Vaubaan keeps your credentials. Your coding agent', 'gets a mission: what it may touch, how often,', 'and what it must ask you first.'],
  mission='Mission · Rate limiter', right='GitHub · acme/api', logos=['GitHub'], rlabel='acme/api',
  rows=[('ok', 'Push to feature/*', f'runs freely · {fmt(quota("github.git-push", "trusting"))} a day', 'GitHub'),
        ('ok', 'Open a pull request', f'runs freely · {fmt(quota("github.create-pr", "trusting"))} a day', 'GitHub'),
        ('ask', 'Merge into main', 'ask me first', 'GitHub'), ('stop', 'Production database', 'not in this mission', 'Supabase')],
  ask='Merge #142 into main?'),
 path=dict(
  desc='The agent calls a tool with its mission key. The plugin names the permission the call needs, Vaubaan checks it against the mission and its limits, then runs it with a credential the agent never sees, asks the mission creator first, or refuses with what to do. Every call is recorded.',
  sub='The same path for every tool and every git push.', call='merge #142',
  risk=['github.merge-protected'], allowed='listed · 1 of 3 today',
  log=['10:41  merge #142  approved, ran', '10:36  migration prod  refused'],
  svc='GitHub', others='Supabase, Vercel…'),
 token=dict(
  desc='Left: the agent holds the GitHub token itself, with everything it allows and no limit. Right: the token stays in Vaubaan; the agent holds a mission key that opens named permissions with limits.',
  secret='ghp_••••', svc='GitHub',
  bad=['everything the token allows, every repository', 'no limit until it expires', 'nobody asked before a merge', 'it can print it, copy it, leak it'],
  good=['named permissions, on named repositories', 'a limit per permission, per day', 'merges wait for your yes', 'its key opens this mission only']),
 ask=dict(
  desc='The agent calls a merge; Vaubaan refuses with approval-required and the page of the request; you see it waiting for you, read the exact call and approve; when you tell the agent, it replays the same call and it runs.',
  call='1  merge #142 into main', phone='3  “Merge #142 into main?” waits for you',
  risk='github.merge-protected', detail='acme/api · squash'),
 team=dict(
  desc='Alone: one person, their agent and the accounts they connected, on an instance of their own. Then the team: the same missions behind the team’s sign-in, accounts shared permission by permission, one key per person.',
  accounts='2 accounts', sso='OpenID Connect · GitHub', svcs=['GitHub', 'Supabase', 'Vercel']),
 term=dict(
  desc='A coding agent session through Vaubaan: reads and pushes run, a staging migration runs, a production migration is refused because it is not in the mission, a merge asks the mission creator first.',
  title='claude · mission “Rate limiter for the API”',
  lines=[('termMuted', '›', 'add a rate limiter to the API, migrate staging, open a PR', ''),
         ('ok', '✓', 'github__get_file_contents src/server.ts', f'runs freely · 1 of {fmt(quota("github.read-code", "trusting"))} today'),
         ('ok', '✓', 'git push origin feature/rate-limit', f'runs freely · 1 of {fmt(quota("github.git-push", "trusting"))} today'),
         ('ok', '✓', 'supabase__apply_migration staging', f'runs freely · 1 of {fmt(quota("supabase.migration-write", "autonomous"))} today'),
         ('stop', '✕', 'supabase__apply_migration production', 'resource-not-in-mission'),
         ('ask', '◆', 'github__merge_pull_request #142', 'approval-required'),
         ('termMuted', ' ', 'waiting for your yes: https://vaubaan.example/waiting/r_8f2c…', '')]),
 map=dict(
  sid='github', title='GitHub, mapped', cols=GH_COLS, map=GH_MAP, reasons=reasons_of('github'),
  widths=[140, 180, 240, 180, 170],
  desc=f'The {GH["permissions"]} GitHub permissions placed in {len(GH_COLS)} verbs ({", ".join(GH_COLS)}) and four rows, from Cannot be repaired to Harmless. Most of the agent’s work sits in Harmless; what is costly to undo gathers in Ship and Administer.',
  sub=f'{GH["permissions"]} permissions, {len(GH_COLS)} verbs, ordered by how hard each is to repair. The same for every service: {TOTALS["services"]} services, {TOTALS["permissions"]} permissions.'),
 ticks=dict(
  sid='github',
  desc=f'Ticking Read and Propose at Trusting on a GitHub repository writes {len(GH_LINES)} explicit lines: each permission gets its gate from its row and the trust level, and its limit from the base budget times three. The other verbs stay out.',
  card='GitHub · acme/api',
  verbs=[(m['label'], m['id'] in GH_TICKS) for m in GH['macroActions']],
  lines=GH_LINES),
 scale=dict(
  desc='Every permission of every service answers one question: if your agent gets it wrong, how hard is it to repair? Four steps, from Harmless (read code) to Cannot be repaired (delete a release).',
  steps=['Read code', 'Search all of GitHub', 'Merge into main', 'Delete a release'],
  ids=['github.read-code', 'github.search-global', 'github.merge-protected', 'github.delete-release'],
  why=[['Nothing changes.', 'Let it run all day.'], ['Reaches beyond the', 'repositories of', 'the mission.'],
       ['CI runs, people are', 'notified. Undoing it', 'takes work.'], ['Its files are gone', 'for everyone who', 'linked to them.']]),
 model=dict(
  desc=f'Supabase, modelled: one project carries the environment (preview, staging, prod) over {len(SB["planes"])} planes ({", ".join(SB["planes"])}) and their entities. A migration becomes one permission per environment; bulk row writes have no production form. The {SB["permissions"]} permissions fold into {len(SB["macroActions"])} verbs a person ticks.',
  svc='Supabase', sub=f'{len(SB["planes"])} planes, the project carries the environment',
  carrier='project', carrier_note='carries the env', tags=['preview', 'staging', 'prod'],
  lanes=[('db', ['schema', 'table', 'row', 'policy', 'migration', 'db-role', 'extension', '+ more'], False),
         ('storage', ['bucket', 'object', 'signed-url', 'bucket-policy', 'config'], False),
         ('auth', ['user', 'link', 'mfa-factor', 'identity', 'sso-provider', 'config'], False),
         ('functions', ['edge-function', 'body', 'deployment', 'secret', 'config'], False)],
  dashed_note=None,
  trick='One act, one line per env',
  acts=[('Apply a migration', [(e, 'ok', '') for e in entry('supabase.migration-write')['envs']], 'tick it per environment'),
        ('Write rows in bulk', [('preview', 'ok', ''), ('staging', 'ok', ''), ('prod', 'stop', 'no prod form')], 'never offered for production')],
  verbs=verbs_of('supabase')),
 authors=dict(
  desc=f'A plugin author answers five plain questions for each permission in the risk catalog. Merging into main is costly to undo, so it lands on {ROWS[entry("github.merge-protected")["row"]][0]}; the kit checks it and a reviewer reads it in the catalog pull request.',
  id='github.merge-protected', label='Write on main, release-*',
  vals=['costly', 'env', 'data', 'moderate', 'team'], on=[1, 1, 1, 1, 1], row=entry('github.merge-protected')['row'], because='because it is costly to undo',
  foot='The five questions are the whole method: the same for GitHub, Stripe or your own internal service.'),
)

CONS = dict(
 key='consultant',
 hero=dict(
  desc='Your assistant holds a mission key. Vaubaan holds the access to your mail, notes and calendar, runs what the mission allows, refuses the rest, and asks you before a mail leaves for a client.',
  lines=['Vaubaan keeps your access. Your assistant', 'gets a mission: which mail, pages and calendar,', 'how often, and what it must ask you first.'],
  mission='Mission · Acme recap', right='Gmail · Notion · Calendar', logos=['Gmail', 'Notion', 'Calendar'], rlabel='',
  rows=[('ok', 'Read Acme threads', f'runs freely · {fmt(quota("gmail.read-from-zone-known-external", "trusting"))} a day', 'Gmail'),
        ('ok', 'Write Notion notes', f'runs freely · {fmt(quota("notion.content-append", "trusting"))} a day', 'Notion'),
        ('ask', 'Send to jane@acme.com', 'ask me first', 'Gmail'), ('stop', 'Your Finance label', 'not in this mission', 'Gmail')],
  ask='Send the recap to Jane?'),
 path=dict(
  desc='The assistant calls a tool with its mission key. The Gmail plugin names the permission the call needs (sending to a client), Vaubaan checks it against the mission and its limits, then sends with an access the assistant never sees, asks you first, or refuses with what to do. Every call is recorded.',
  sub='The same path for every mail, page and event.', call='send recap',
  risk=['gmail.', 'send-to-zone-allowlist'], allowed='listed · 1 of 60 today',
  log=['10:41  recap to Jane  approved, sent', '10:36  label Finance  refused'],
  svc='Gmail', others='Notion, Calendar…'),
 token=dict(
  desc='Left: the assistant holds the Gmail app password itself, with every mail and no limit. Right: the password stays in Vaubaan; the assistant holds a mission key that opens named permissions with limits.',
  secret='abcd ••••', svc='Gmail',
  bad=['every mail, every contact, every folder', 'no limit until you revoke it', 'nobody asked before a mail leaves', 'it can print it, copy it, leak it'],
  good=['named permissions, on named mail and pages', 'a limit per permission, per day', 'mail to clients waits for your yes', 'its key opens this mission only']),
 ask=dict(
  desc='The assistant sends the recap to a client; Vaubaan refuses with approval-required and the page of the request; you see it waiting for you, read the exact mail and approve; when you tell the assistant, it replays the same call and the mail leaves.',
  call='1  send the recap to jane@acme.com', phone='3  “Send the recap to Jane?” waits for you',
  risk='gmail.send-to-zone-allowlist', detail='jane@acme.com · recap'),
 team=dict(
  desc='Alone: one person, their assistant and the accounts they connected, on an instance of their own. Then the firm: the same missions behind the firm’s sign-in, accounts shared permission by permission, one key per person.',
  accounts='3 accounts', sso='OpenID Connect · Google', svcs=['Gmail', 'Notion', 'Calendar']),
 term=dict(
  desc='An assistant session through Vaubaan: mail search, calendar and notes run, a thread under the sensitive Finance label is refused because that permission is not in the mission, the mail to the client asks you first.',
  title='claude · mission “Weekly client recap”',
  lines=[('termMuted', '›', 'prepare this week’s Acme recap, then send it to Jane', ''),
         ('ok', '✓', 'gmail__search_threads from:acme.com', f'runs freely · 1 of {fmt(quota("gmail.read-from-zone-known-external", "trusting"))} today'),
         ('ok', '✓', 'google_calendar__list_events this week', f'runs freely · 1 of {fmt(quota("google-calendar.event-read", "trusting"))} today'),
         ('ok', '✓', 'notion__append_blocks “Acme / Weekly notes”', f'runs freely · 1 of {fmt(quota("notion.content-append", "trusting"))} today'),
         ('stop', '✕', 'gmail__get_thread “Invoice Q3” (label Finance)', 'risk-not-accepted'),
         ('ask', '◆', 'gmail__send_draft to jane@acme.com', 'approval-required'),
         ('termMuted', ' ', 'waiting for your yes: https://vaubaan.example/waiting/r_3a91…', '')]),
 map=dict(
  sid='gmail', title='Gmail, mapped', cols=GM_COLS, map=GM_MAP, reasons=reasons_of('gmail'),
  widths=[320, 210, 210, 170],
  desc=f'The {GM["permissions"]} Gmail permissions placed in {len(GM_COLS)} verbs ({", ".join(GM_COLS)}) and four rows, from Cannot be repaired to Harmless. Reading and drafting sit in Harmless; a mail that leaves for a client cannot be called back.',
  sub=f'{GM["permissions"]} permissions, {len(GM_COLS)} verbs, ordered by how hard each is to repair. Notion has {svc("notion")["permissions"]}, Google Calendar {svc("google-calendar")["permissions"]}: same rows, their own verbs.'),
 ticks=dict(
  sid='gmail',
  desc=f'Ticking Search and Send at Trusting on a Gmail account writes {len(GM_LINES)} explicit lines: reading runs freely, and every mail that leaves for someone else asks first. Limits are the base budgets times three. Draft and Tidy stay out.',
  card='Gmail · you@studio.fr',
  verbs=[(m['label'], m['id'] in GM_TICKS) for m in GM['macroActions']],
  lines=GM_LINES),
 scale=dict(
  desc='Every permission of every service answers one question: if your assistant gets it wrong, how hard is it to repair? Four steps, from Harmless (draft a reply) to Cannot be repaired (send to a client).',
  steps=['Draft a reply', 'Read the agenda', 'Move a meeting', 'Send to a client'],
  ids=['gmail.draft-write', 'google-calendar.event-read', 'google-calendar.event-change', 'gmail.send-to-zone-allowlist'],
  why=[['Nothing leaves.', 'You read it first.'], ['Who you meet, when', 'and where: personal', 'data.'],
       ['Guests see it move.', 'Moving it back takes', 'an apology.'], ['A sent mail cannot', 'be called back.']]),
 model=dict(
  desc=f'Gmail, modelled: one mailbox plane with what Gmail keeps, plus zones Gmail does not have: who wrote a mail and who receives it, read from your domains and your client list. Sending becomes four permissions, one per recipient zone, each on its own row. The {GM["permissions"]} permissions fold into {len(GM_COLS)} verbs a person ticks.',
  svc='Gmail', sub='1 plane, the mailbox; zones added by Vaubaan',
  carrier='mailbox', carrier_note='knows your domains and clients', tags=[],
  lanes=[('stored', ['label', 'thread', 'message', 'attachment', 'draft'], False),
         ('from', ['notifications', 'colleagues', 'clients', 'unknown'], True),
         ('to', ['yourself', 'colleagues', 'clients', 'anyone'], True),
         ('flags', ['sensitive', 'bulk'], True)],
  dashed_note='dashed: not in Gmail, added by the model',
  trick='One act, one line per recipient',
  acts=[('Send a message', [(o, entry(rid)['row'], '') for o, rid in (('yourself', 'gmail.send-to-zone-self'), ('colleagues', 'gmail.send-to-zone-internal'),
                            ('clients', 'gmail.send-to-zone-allowlist'), ('anyone', 'gmail.send-to-zone-external'))], 'priced by who receives it'),
        ('Read a thread', [('unknown sender', entry('gmail.read-from-zone-unknown')['row'], '')], 'where injected text comes from')],
  verbs=verbs_of('gmail')),
 authors=dict(
  desc=f'A plugin author answers five plain questions for each permission in the risk catalog. Sending to a pre-approved client can never be undone, so it lands on {ROWS[entry("gmail.send-to-zone-allowlist")["row"]][0]}; the kit checks it and a reviewer reads it in the catalog pull request.',
  id='gmail.send-to-zone-allowlist', label='Send to known contacts',
  vals=['irreversible', 'env', 'data', 'free', 'team'], on=[2, 1, 1, 0, 1], row=entry('gmail.send-to-zone-allowlist')['row'], because='because it can never be undone',
  foot='The five questions are the whole method: the same for Gmail, Stripe or your own internal service.'),
)
SCENARIOS = [DEV, CONS]
for S in SCENARIOS:
    for rid, want in zip(S['scale']['ids'], (1, 2, 3, 4)):
        assert entry(rid)['row'] == want, f'{rid} left row {want}: redraw the repair scale'

# =====================================================================
@drawing('hero', 1200, 440)
def hero(S):
    P = S['hero']
    s = frame(1200, 440)
    s += pill(64, 64, 276, 'open source · you run it', 'accentSoft', 'accentInk mono sb')
    s += T(64, 160, 'Let your agent', 58, 'ink b') + T(64, 226, 'work alone.', 58, 'ink b')
    s += T(64, 284, 'It stops where you said.', 30, 'accent b')
    for i, l in enumerate(P['lines']): s += T(64, 330 + i * 28, l, 19, 'muted')
    s += bot(636, 118, 26)
    s += T(636, 166, 'your agent', 14, 'muted', 'middle')
    s += f'<circle cx="660" cy="140" r="13" class="surface line thin"/>' + keyicon(653, 140, 'accent', 0.5)
    x, y, w, h = 700, 56, 440, 250
    s += card(x, y, w, h, P['mission'], 'accentSoft', 'accentInk b')
    lx = x + w - 18
    if P['rlabel']:
        lx -= len(P['rlabel']) * 7.8; s += T(f'{lx:.0f}', y + 26, P['rlabel'], 13, 'accentInk mono sb'); lx -= 8
    for name in reversed(P['logos']):
        lx -= 22; s += logo(name, f'{lx:.0f}', y + 9, 22); lx -= 8
    for i, (k, a, b, svc) in enumerate(P['rows']):
        yy = y + 76 + i * 46
        s += badge(x + 30, yy - 5, k)
        s += logo(svc, x + 50, yy - 15, 18)
        s += T(x + 78, yy, a, 15, 'ink sb')
        s += T(x + w - 18, yy, b, 13, {'ok': 'muted', 'ask': 'askInk sb', 'stop': 'stopInk sb'}[k], 'end')
        if i < 3: s += f'<line x1="{x+18}" y1="{yy+20}" x2="{x+w-18}" y2="{yy+20}" class="line thin"/>'
    s += arrow('M664 118 C 680 118, 684 118, 698 118', 'agent')
    s += person(636, 372, 'human', 26)
    s += T(636, 420, 'you', 14, 'muted', 'middle')
    px, py = 688, 334
    s += R(px, py, 290, 76, 16, 'surface line thin')
    s += T(px + 16, py + 28, 'Waiting for you', 12, 'muted')
    s += T(px + 16, py + 58, P['ask'], 17, 'ink b')
    s += R(px + 202, py + 10, 74, 26, 13, 'accent') + T(px + 239, py + 28, 'Approve', 12.5, 'onAccent b', 'middle')
    s += arrow('M700 214 C 676 214, 680 290, 712 330', 'ask', 'mid', True)
    s += R(996, 334, 144, 76, 16, 'vault')
    s += lock(1020, 362, 'ink') + T(1038, 368, 'credentials', 13, 'ink sb')
    s += T(1012, 392, 'stay in Vaubaan', 13, 'muted')
    return s, 'Vaubaan: let your agent work alone', P['desc']

# =====================================================================
@drawing('token-or-mission', 1200, 480)
def token_or_mission(S):
    P = S['token']
    s = frame(1200, 480)
    s += R(40, 40, 540, 400, 22, 'surface line thin')
    s += T(68, 82, 'Today: a password in the agent’s config' if S is CONS else 'Today: a token in the agent’s config', 19, 'ink b')
    s += bot(120, 196, 30)
    s += R(164, 166, 140, 60, 12, 'stopSoft') + keyicon(184, 196, 'stop', 1.0)
    s += T(218, 201, P['secret'], 14, 'stopInk mono sb')
    s += arrow('M308 196 L 420 196', 'stop', 'thick')
    s += R(426, 156, 124, 80, 16, 'vault') + logo(P['svc'], 474, 166, 28) + T(488, 222, P['svc'], 14, 'ink b', 'middle')
    for i, t in enumerate(P['bad']):
        y = 292 + i * 34
        s += badge(80, y - 5, 'stop') + T(100, y, t, 15, 'ink')
    s += R(620, 40, 540, 400, 22, 'surface line thin')
    s += T(648, 82, 'With Vaubaan: a mission', 19, 'ink b')
    s += bot(690, 196, 30)
    s += R(730, 172, 64, 48, 12, 'accentSoft') + keyicon(746, 196, 'accent', 0.85)
    s += arrow('M798 196 L 850 196', 'accent', 'mid')
    s += R(856, 150, 156, 92, 16, 'accentSoft')
    s += T(934, 182, 'Vaubaan', 15, 'accentInk b', 'middle')
    s += lock(904, 214, 'accentInk') + T(920, 219, 'password here' if S is CONS else 'token here', 12.5, 'accentInk')
    s += arrow('M1012 196 L 1052 196', 'accent', 'mid')
    s += R(1058, 156, 80, 80, 16, 'vault') + logo(P['svc'], 1084, 166, 28) + T(1098, 222, P['svc'], 13, 'ink b', 'middle')
    for i, t in enumerate(P['good']):
        y = 292 + i * 34
        s += badge(660, y - 5, 'ok') + T(680, y, t, 15, 'ink')
    return s, 'A secret in the agent, or a mission', P['desc']

# =====================================================================
@drawing('repair-scale', 1200, 560)
def repair_scale(S):
    P = S['scale']
    s = frame(1200, 560)
    s += T(64, 72, 'One question for every permission', 28, 'ink b')
    s += T(64, 104, 'If your agent gets it wrong, how hard is it to repair?', 19, 'accent sb')
    base, w, gap = 468, 256, 14
    for i, r in enumerate((1, 2, 3, 4)):
        name, band, glyph = ROWS[r]
        chip, lines = P['steps'][i], P['why'][i]
        x = 64 + i * (w + gap)
        top = base - (176 + i * 50)
        s += R(x, top, w, base - top, 16, band)
        s += T(x + 20, top + 34, name, 17 if len(name) < 23 else 15.5, f'{glyph} b')
        cw = len(chip) * 7.3 + 26
        s += R(x + 20, top + 50, f'{cw:.0f}', 30, 15, 'surface line thin') + T(f'{x + 20 + cw/2:.0f}', top + 70, chip, 13, 'ink sb', 'middle')
        for j, l in enumerate(lines):
            s += T(x + 20, top + 112 + j * 21, l, 15, 'ink')
    s += arrow('M64 496 L 1128 496', 'muted', 'mid')
    s += T(1128, 520, 'harder to repair', 13, 'muted', 'end')
    s += T(64, 540, 'Plugin authors answer it for each permission, and reviewers check the answer like code.', 13, 'muted')
    return s, 'One question for every permission', P['desc']

# =====================================================================
@drawing('modelled-then-verbs', 1200, 680)
def modelled_then_verbs(S):
    P = S['model']
    s = frame(1200, 680)
    s += T(64, 72, 'We modelled each service. You tick a few verbs.', 28, 'ink b')
    s += T(64, 102, 'Its planes, its entities, where the environment lives; then its acts, cut into permissions, folded into verbs.', 16, 'muted')
    top, bot_y = 140, 604
    # ---- 1. the domain
    ax, aw = 40, 460
    s += card(ax, top, aw, bot_y - top, f'1 ·      {P["svc"]}, modelled', 'vault', 'ink b')
    s += logo(P['svc'], ax + 36, top + 10, 20)
    s += T(ax + 20, top + 64, P['sub'], 12.5, 'muted')
    # env carrier bar
    by = top + 82
    s += R(ax + 20, by, aw - 40, 48, 12, 'accentSoft')
    s += T(ax + 36, by + 30, P['carrier'], 15, 'accentInk mono b')
    s += T(ax + 36 + len(P['carrier']) * 9.4 + 12, by + 30, P['carrier_note'], 12.5, 'accentInk')
    tx = ax + aw - 28
    for t in reversed(P['tags']):
        tw = len(t) * 7.6 + 20
        tx -= tw
        s += R(f'{tx:.0f}', by + 11, f'{tw:.0f}', 26, 6, 'surface line thin')
        s += T(f'{tx + tw/2:.0f}', by + 29, t, 12, ('ink b' if t == 'prod' else 'ink sb') + ' mono', 'middle')
        tx -= 6
    # lanes
    ly = by + 70
    n = len(P['lanes']); gap = 10
    lw = (aw - 40 - gap * (n - 1)) / n
    lh = bot_y - ly - (44 if P['dashed_note'] else 20)
    for i, (name, ents, dashed) in enumerate(P['lanes']):
        lx = ax + 20 + i * (lw + gap)
        s += R(f'{lx:.0f}', ly, f'{lw:.0f}', lh, 12, 'vault' + (' accentS thin dash' if dashed else ''))
        s += f'<line x1="{lx + lw/2:.0f}" y1="{by+48}" x2="{lx + lw/2:.0f}" y2="{ly}" class="accentS thin"/>'
        s += T(f'{lx + 12:.0f}', ly + 26, name, 13.5, 'ink mono b')
        for j, e in enumerate(ents):
            yy = ly + 56 + j * 30
            more = e.startswith('+')
            if not more:
                s += R(f'{lx + 8:.0f}', yy - 17, f'{lw - 16:.0f}', 24, 8, 'surface line thin')
            s += T(f'{lx + 14:.0f}', yy, e, 11.5 if S is CONS else 10.5, ('muted' if more else 'ink') + ('' if S is CONS else ' mono'))
    if P['dashed_note']:
        s += f'<rect x="{ax+20}" y="{bot_y-30}" width="26" height="14" rx="4" class="nofill accentS thin dash"/>'
        s += T(ax + 54, bot_y - 18, P['dashed_note'], 12.5, 'muted')
    # ---- 2. the trick
    bx, bw = 530, 290
    s += arrow(f'M{ax+aw+4} 372 L {bx-6} 372', 'accent', 'mid')
    s += card(bx, top, bw, bot_y - top, '2 · ' + P['trick'], 'accentSoft', 'accentInk b', size=14)
    yy = top + 76
    for act, outs, note in P['acts']:
        s += R(bx + 18, yy - 20, bw - 36, 30, 15, 'surface accentS mid') + T(bx + bw / 2, yy, act, 13.5, 'ink b', 'middle')
        oy = yy + 34
        for (o, k, lab) in outs:
            s += f'<path d="M{bx+40} {yy+10} V {oy-5} H {bx+60}" class="nofill accentS thin"/>'
            dashed = k == 'stop'
            s += R(bx + 62, oy - 17, 100, 24, 12, 'surface line thin' + (' dash' if dashed else ''))
            s += T(bx + 112, oy, o, 11.5, ('muted' if dashed else 'ink') + ' sb' + ('' if S is CONS else ' mono'), 'middle')
            if isinstance(k, int):
                rn, rband, rword = ROWS[k]
                rw = len(rn) * 5.4 + 12
                s += R(bx + 168, oy - 16, f'{rw:.0f}', 22, 11, rband) + T(f'{bx + 168 + rw/2:.0f}', oy - 1, rn, 9.5, f'{rword} b', 'middle')
            else:
                s += f'<g transform="translate({bx+178} {oy-5}) scale(0.75) translate({-(bx+178)} {-(oy-5)})">' + badge(bx + 178, oy - 5, k) + '</g>'
                if lab: s += T(bx + 192, oy, lab, 11.5, {'ok': 'muted', 'ask': 'askInk sb', 'stop': 'stopInk sb'}[k])
            oy += 32
        s += T(bx + 20, oy + 2, note, 12, 'muted')
        yy = oy + 46
    # ---- 3. the verbs
    cx, cw = 852, 308
    s += arrow(f'M{bx+bw+4} 372 L {cx-6} 372', 'accent', 'mid')
    total = sum(v[2] for v in P['verbs'])
    s += card(cx, top, cw, bot_y - top, '3 · Verbs you tick', 'accentSoft', 'accentInk b', size=14,
              right=f'{total} permissions')
    vy = top + 70
    for i, (v, d, cnt) in enumerate(P['verbs']):
        s += R(cx + 18, vy - 15, 20, 20, 5, 'surface line mid')
        s += T(cx + 48, vy, v, 15, 'ink b') + T(cx + cw - 18, vy, f'{cnt} lines', 12, 'muted', 'end')
        for j, l in enumerate(textwrap.wrap(d, 36)):
            s += T(cx + 48, vy + 22 + j * 18, l, 12.5, 'muted')
        vy += 30 + 18 * len(textwrap.wrap(d, 36)) + 12
    s += T(64, 640, model_line(), 14, 'muted')
    return s, 'Modelled, then folded into verbs', P['desc']

# =====================================================================
@drawing('the-map', 1200, 700)
def the_map(S):
    P = S['map']; MAP = P['map']
    s = ''
    s += logo(P['title'].split(',')[0], 64, 46, 32) + T(108, 72, P['title'], 28, 'ink b')
    s += T(64, 102, P['sub'], 16, 'muted')
    lx, lw = 56, 170
    xs = []; cx = lx + lw
    for n, w in zip(P['cols'], P['widths']): xs.append((n, cx, w)); cx += w
    top = 140
    for n, x, w in xs:
        cnt = sum(len(MAP[r].get(n, [])) for r in MAP)
        s += T(x + 14, top + 20, n, 17 if len(n) < 12 else 15, 'ink b') + T(x + 14, top + 40, f'{cnt} permission' + ('s' if cnt > 1 else ''), 12.5, 'muted')
    y = top + 58
    def chips_layout(items, w):
        lines, cur, cw = [], [], 0
        for it in items:
            iw = len(it) * 7.0 + 22
            if cur and cw + iw > w - 24: lines.append(cur); cur, cw = [], 0
            cur.append((it, iw)); cw += iw + 8
        if cur: lines.append(cur)
        return lines
    for r in (4, 3, 2, 1):
        layouts = {n: chips_layout(MAP[r].get(n, []), w) for n, x, w in xs}
        nl = max([len(v) for v in layouts.values()] + [1])
        h = max(80, 24 + nl * 36)
        full, band, word = ROWS[r]
        parts = full.split(', ')
        reason = P['reasons'].get(r, '')
        s += R(lx, y, cx - lx, h, 12, band)
        for k, part in enumerate(parts):
            s += T(lx + 16, y + 28 + k * 18, part + (',' if k < len(parts) - 1 else ''), 14, f'{word} b')
        if reason: s += T(lx + 16, y + 32 + len(parts) * 18, reason, 11.5, 'muted mono')
        for n, x, w in xs:
            for li, line in enumerate(layouts[n]):
                xx = x + 12
                for it, iw in line:
                    yy = y + 14 + li * 36
                    s += R(f'{xx:.0f}', yy, f'{iw:.0f}', 28, 14, 'surface line thin')
                    s += T(f'{xx + iw/2:.0f}', yy + 19, it, 12.5, 'ink sb', 'middle')
                    xx += iw + 8
        y += h + 8
    for n, x, w in xs[1:]:
        s += f'<line x1="{x}" y1="{top}" x2="{x}" y2="{y-8}" class="line thin dash"/>'
    s += T(64, y + 26, 'Anything else: one catch-all permission for a write no entry describes. It is never on the map, and never granted without being named.', 14, 'muted')
    H = int(y + 60)
    return frame(1200, H) + s, P['title'], P['desc'], H

# =====================================================================
@drawing('two-ticks', 1200, 560)
def two_ticks(S):
    P = S['ticks']
    s = frame(1200, 560)
    s += T(64, 72, 'You tick verbs. Vaubaan writes the lines.', 28, 'ink b')
    s += T(64, 102, 'The trust level of a verb sets each gate from the row, and multiplies the limits ×1, ×3 or ×10.', 16, 'muted')
    x, y, w = 56, 150, 300
    h = 80 + len(P['verbs']) * 52
    s += card(x, y, w, h, '      ' + P['card'], 'vault', 'ink b')
    s += logo(P['card'].split(' ·')[0], x + 16, y + 9, 22)
    for i, (v, on) in enumerate(P['verbs']):
        yy = y + 80 + i * 52
        if on:
            s += R(x + 22, yy - 15, 20, 20, 5, 'accent') + f'<path d="M{x+27} {yy-5} l4 4 l7 -8" fill="none" class="onAccentS" stroke-width="2.4"/>'
        else:
            s += R(x + 22, yy - 15, 20, 20, 5, 'surface line mid')
        s += T(x + 54, yy, v, 16, 'ink b' if on else 'muted sb')
        if on: s += pill(x + w - 112, yy - 20, 92, 'Trusting', 'accentSoft', 'accentInk sb', 12.5, 28)
    s += T(x + 22, y + h - 18, '2 ticks, 1 choice', 13, 'muted')
    mx, my = 392, 168
    levels = ['Careful', 'Trusting', 'Autonomous']
    cw = 84; c0 = mx + 160
    s += R(c0 + cw, my - 12, cw, 300, 12, 'accentSoft')
    for j, l in enumerate(levels):
        s += T(c0 + j * cw + cw / 2, my + 10, l, 12.5, ('accentInk b' if j == 1 else 'muted sb'), 'middle')
    # The gates by row and level, read from the catalog: the first permission of each row.
    firsts = {}
    for m in svc(P['sid'])['macroActions']:
        for e in m['entries']: firsts.setdefault(e['row'], e)
    grid = [(ROWS[r][0], [GATE_BADGE[firsts[r][l]] for l in ('careful', 'trusting', 'autonomous')], r) for r in (4, 3, 2, 1)]
    for i, (rn, cells, r) in enumerate(grid):
        yy = my + 50 + i * 50
        rw = len(rn) * 7.0 + 20
        s += R(mx - 8, yy - 13, f'{rw:.0f}', 26, 13, ROWS[r][1]) + T(mx + 2, yy + 5, rn, 12.5, f'{ROWS[r][2]} b')
        for j, k in enumerate(cells):
            s += badge(c0 + j * cw + cw / 2, yy, k)
    yy = my + 50 + 4 * 50
    s += T(mx, yy + 5, 'Limits', 13, 'ink sb')
    for j, m in enumerate(['×1', '×3', '×10']):
        s += T(c0 + j * cw + cw / 2, yy + 5, m, 14, 'accentInk b' if j == 1 else 'muted b', 'middle')
    lgy = 500
    s += badge(420, lgy - 5, 'ok') + T(438, lgy, 'runs freely', 13, 'muted')
    s += badge(540, lgy - 5, 'ask') + T(556, lgy, 'asks you first', 13, 'muted')
    s += badge(680, lgy - 5, 'stop') + T(698, lgy, 'left out', 13, 'muted')
    rx, ry, rw = 850, 130, 310
    lines = P['lines']
    rh = 52 + len(lines) * 26 + 10
    s += card(rx, ry, rw, rh, f'The mission holds {len(lines)} lines', 'accentSoft', 'accentInk b')
    for i, (l, k, q) in enumerate(lines):
        yy = ry + 66 + i * 26
        s += T(rx + 18, yy, l, 13, 'ink')
        s += f'<g transform="translate({rx + rw - 128} {yy - 4}) scale(0.7) translate({-(rx + rw - 128)} {-(yy - 4)})">' + badge(rx + rw - 128, yy - 4, k) + '</g>'
        s += T(rx + rw - 18, yy, q + ' a day', 12, 'muted', 'end')
    s += arrow('M358 300 C 384 300, 386 300, 404 300', 'accent', 'mid')
    s += arrow(f'M{c0 + 3*cw + 8} 300 C 840 300, 840 300, {rx - 6} 300', 'accent', 'mid')
    s += T(1005, 530, 'every line editable, one by one', 13, 'muted', 'middle')
    return s, 'You tick verbs, Vaubaan writes the lines', P['desc']

# =====================================================================
@drawing('path-of-a-call', 1200, 560)
def path_of_a_call(S):
    P = S['path']
    s = frame(1200, 560)
    s += T(64, 72, 'How a call goes through', 28, 'ink b')
    s += T(64, 102, P['sub'], 16, 'muted')
    s += bot(108, 268, 28)
    s += T(108, 318, 'your agent', 15, 'ink b', 'middle')
    s += T(108, 338, 'holds a mission key', 13, 'muted', 'middle')
    s += arrow('M140 268 L 262 268', 'agent')
    s += label_on(200, 258, P['call'], 'agentInk sb', 13)
    px, py, pw, ph = 268, 140, 680, 332
    s += R(px, py, pw, ph, 22, 'surface line thin')
    s += T(px + 24, py + 32, 'Vaubaan', 16, 'ink b') + T(px + 112, py + 32, 'where you run it', 14, 'muted')
    steps = [('1', 'Plugin names it', None), ('2', 'Mission allows it?', P['allowed']), ('3', 'Decision', '')]
    bx, by, bw, bh = px + 24, py + 56, 196, 124
    for i, (n, a, b) in enumerate(steps):
        x = bx + i * (bw + 22)
        s += R(x, by, bw, bh, 14, 'accentSoft' if i == 2 else 'vault')
        s += f'<circle cx="{x+22}" cy="{by+26}" r="12" class="accent"/>' + T(x + 22, by + 31, n, 13, 'onAccent b', 'middle')
        s += T(x + 42, by + 31, a, 14, 'ink b')
        if i == 0:
            for j, part in enumerate(P['risk']): s += T(x + 16, by + 70 + j * 18, part, 12.5, 'ink mono')
        elif b: s += T(x + 16, by + 74, b, 12.5, 'muted')
        if i < 2: s += arrow(f'M{x+bw+2} {by+bh/2} L {x+bw+20} {by+bh/2}', 'accent', 'thin')
    ox = bx + 2 * (bw + 22) + 16
    for j, (k, t) in enumerate([('ok', 'runs'), ('ask', 'asks you first'), ('stop', 'refused, says why')]):
        yy = by + 60 + j * 24
        s += badge(ox + 8, yy - 5, k) + T(ox + 26, yy, t, 13, 'ink')
    vx, vy = bx, by + bh + 30
    s += R(vx, vy, 290, 92, 14, 'vault')
    s += lock(vx + 28, vy + 34, 'ink') + T(vx + 48, vy + 40, 'Credentials, encrypted', 14, 'ink b')
    s += T(vx + 20, vy + 68, 'opened for this one call, never handed out', 12.5, 'muted')
    ax = vx + 312
    s += R(ax, vy, 322, 92, 14, 'surface line thin')
    s += T(ax + 20, vy + 34, 'Activity', 14, 'ink b')
    s += T(ax + 20, vy + 58, P['log'][0], 12.5, 'ink mono')
    s += T(ax + 20, vy + 78, P['log'][1], 12.5, 'muted mono')
    s += arrow(f'M{bx+2*(bw+22)+bw/2} {by+bh} C {bx+2*(bw+22)+bw/2} {vy-6}, {ax+160} {vy-20}, {ax+160} {vy}', 'muted', 'thin')
    s += arrow(f'M{px+pw} 268 L 1004 268', 'accent', 'thick')
    s += label_on(976, 256, 'runs it', 'accentInk sb', 13)
    s += R(1010, 222, 150, 92, 16, 'surface line thin')
    s += logo_label(P['svc'], 1085, 262, 24, 17) + T(1085, 290, P['others'], 13, 'muted', 'middle')
    s += person(1085, 430, 'human', 26)
    s += T(1085, 480, 'you', 14, 'ink b', 'middle') + T(1085, 500, 'Waiting for you', 13, 'muted', 'middle')
    s += arrow(f'M{px+pw} 330 C 1000 330, 1010 420, 1052 428', 'ask', 'mid', True)
    s += label_on(1004, 360, 'asks first', 'askInk sb', 13)
    s += arrow(f'M{px} 196 C 170 196, 108 196, 108 234', 'stop', 'mid', True)
    s += label_on(196, 186, 'refusal + what to do', 'stopInk sb', 13)
    return s, 'How a call goes through Vaubaan', P['desc']

# =====================================================================
@drawing('ask-me-first', 1200, 470)
def ask_me_first(S):
    P = S['ask']
    s = frame(1200, 470)
    s += T(64, 72, 'Ask me first', 28, 'ink b')
    s += T(64, 102, 'Nothing waits inside Vaubaan. The yes is given on a page, by you only.', 16, 'muted')
    for x, k, t in [(240, 'agent', 'Your agent'), (600, 'mid', 'Vaubaan'), (960, 'human', 'You')]:
        if k == 'agent': s += bot(x, 150, 22)
        elif k == 'human': s += person(x, 150, 'human', 22)
        else: s += R(x - 22, 128, 44, 44, 12, 'accent') + T(x, 156, 'V', 18, 'onAccent b', 'middle')
        s += T(x + 34, 156, t, 16, 'ink b')
        s += f'<line x1="{x}" y1="180" x2="{x}" y2="440" class="line mid dash"/>'
    rows = [(210, 240, 600, 'agent', P['call']), (258, 600, 240, 'stop', '2  approval-required + the page of the request'),
            (306, 600, 960, 'ask', P['phone']), (354, 960, 600, 'accent', '4  you read the call and approve'),
            (414, 240, 600, 'ok', '5  you tell the agent; it replays the call: it runs')]
    for y, a, b, c, t in rows:
        s += arrow(f'M{a + (6 if b > a else -6)} {y} L {b + (-8 if b > a else 8)} {y}', c, 'mid', c in ('stop', 'ask'))
        s += label_on((a + b) / 2, y - 10, t, {'agent': 'agentInk sb', 'stop': 'stopInk sb', 'ask': 'askInk sb', 'accent': 'accentInk sb', 'ok': 'okInk sb'}[c], 13.5)
    long = len(P['risk']) > 22
    fs = 10.5 if long else 11.5
    w = max(176, len(P['risk']) * fs * 0.61 + 28)
    cx, cy = 1176 - w, 300
    s += R(f'{cx:.0f}', cy, f'{w:.0f}', 96, 14, 'surface line thin')
    s += T(f'{cx + 14:.0f}', cy + 24, P['risk'], fs, 'muted mono')
    s += T(f'{cx + 14:.0f}', cy + 48, P['detail'], 12.5, 'ink mono')
    s += R(f'{cx + 14:.0f}', cy + 60, 72, 26, 13, 'accent') + T(f'{cx + 50:.0f}', cy + 78, 'Approve', 12, 'onAccent b', 'middle')
    s += R(f'{cx + 92:.0f}', cy + 60, 70, 26, 13, 'surface line thin') + T(f'{cx + 127:.0f}', cy + 78, 'Refuse', 12, 'ink b', 'middle')
    return s, 'Ask me first', P['desc']

# =====================================================================
@drawing('alone-then-team', 1200, 460)
def alone_then_team(S):
    P = S['team']
    s = frame(1200, 460)
    s += R(40, 40, 440, 380, 22, 'surface line thin')
    s += T(68, 82, 'Alone', 19, 'ink b') + T(68, 106, 'your own instance · a desktop app is planned', 14, 'muted')
    s += R(100, 140, 320, 180, 14, 'vault')
    s += f'<path d="M76 330 H444 L428 346 H92 Z" class="lineF"/>'
    s += person(170, 200, 'human', 24) + T(170, 246, 'you', 13, 'muted', 'middle')
    s += bot(170, 280, 20)
    s += R(236, 172, 160, 126, 12, 'accentSoft')
    s += T(316, 200, 'Vaubaan', 15, 'accentInk b', 'middle')
    s += T(316, 226, 'yours only', 12.5, 'accentInk', 'middle')
    s += T(316, 254, P['accounts'], 12.5, 'accentInk', 'middle') + T(316, 274, '3 missions', 12.5, 'accentInk', 'middle')
    s += arrow('M192 280 L 232 260', 'agent', 'thin')
    s += T(260, 392, 'One person, your accounts, your missions.', 14, 'muted', 'middle')
    s += arrow('M492 230 C 540 230, 560 230, 604 230', 'accent', 'thick')
    s += label_on(548, 214, 'your team joins', 'accentInk sb', 13)
    s += R(616, 40, 544, 380, 22, 'surface line thin')
    s += T(644, 82, 'Then your team', 19, 'ink b') + T(644, 106, 'the same missions on a server, behind your sign-in', 14, 'muted')
    s += pill(644, 126, 250, P['sso'], 'vault', 'ink mono sb', 12.5, 28)
    s += R(780, 176, 200, 132, 14, 'accentSoft')
    s += T(880, 206, 'Vaubaan', 15, 'accentInk b', 'middle')
    s += T(880, 232, 'accounts shared', 12.5, 'accentInk', 'middle') + T(880, 252, 'permission by permission', 12.5, 'accentInk', 'middle')
    s += lock(880, 280, 'accentInk')
    for n, y in [('Alice', 196), ('Bob', 252), ('Carol', 308)]:
        s += person(668, y, 'human', 17) + T(694, y + 5, n, 13.5, 'ink sb')
        s += bot(752, y, 11) + keyicon(728, y + 14, 'accent', 0.45)
        s += arrow(f'M764 {y} L 776 {max(200, min(y, 290))}', 'agent', 'thin')
    for i, (n, y) in enumerate(zip(P['svcs'], (196, 246, 296))):
        s += R(1028, y - 18, 116, 36, 10, 'vault') + logo_label(n, 1086, y + 5, 18, 13, 'ink sb')
        s += arrow(f'M980 {242 + (i-1)*18} L 1022 {y}', 'accent', 'thin')
    s += T(888, 392, 'Each person holds their own key. Activity says who did what.', 14, 'muted', 'middle')
    return s, 'Alone first, then your team', P['desc']

# =====================================================================
@drawing('agent-terminal', 1200, 400)
def agent_terminal(S):
    P = S['term']
    s = frame(1200, 400)
    s += R(40, 40, 1120, 320, 16, 'term')
    for i in range(3): s += f'<circle cx="{68 + i*20}" cy="66" r="6" class="termMuted"/>'
    s += T(600, 71, P['title'], 13, 'termMuted mono', 'middle')
    for i, (c, mark, t, v) in enumerate(P['lines']):
        y = 112 + i * 34
        tc = {'ok': 'termOk', 'ask': 'termAsk', 'stop': 'termStop'}.get(c, c)
        s += T(72, y, mark, 15, f'{tc} mono b')
        s += T(100, y, t, 15, ('termMuted' if c == 'termMuted' else 'termInk') + ' mono')
        if v: s += T(1128, y, v, 15, ('termMuted' if c == 'ok' else tc) + ' mono', 'end')
    return s, 'What your agent sees', P['desc']

# =====================================================================
@drawing('for-plugin-authors', 1200, 580)
def for_plugin_authors(S):
    P = S['authors']
    s = frame(1200, 580)
    s += T(64, 72, 'For plugin authors: five questions per permission', 28, 'ink b')
    s += T(64, 102, 'You know the service. Answer in plain facts, and Vaubaan places the permission, the same way for every service.', 16, 'muted')
    x, y, w, h = 56, 140, 340, 360
    s += R(x, y, w, h, 16, 'term')
    s += T(x + 20, y + 30, 'risk-catalog.yaml', 13, 'termMuted mono')
    keys = ['reversibility', 'blast', 'data', 'cost', 'visibility']
    code = [('- id: ', P['id']), ('  label: ', P['label']), ('  vector:', '')] + [(f'    {k}: ', v) for k, v in zip(keys, P['vals'])]
    ys = []
    for i, (k, v) in enumerate(code):
        yy = y + 70 + i * 34
        ys.append(yy)
        s += T(x + 20, yy, k, 14, 'termMuted mono')
        if v: s += T(x + (190 if i >= 3 else 96), yy, v, 14, 'termInk mono b')
    qx = 452
    qs = [('Can it be undone?', ['yes', 'at a price', 'never']),
          ('How far does it reach?', ['one thing', 'one environment', 'the account', 'in bulk']),
          ('What data does it touch?', ['names', 'content', 'secrets', 'personal']),
          ('What can it cost?', ['nothing', 'some money', 'no ceiling']),
          ('Who sees it?', ['you', 'your team', 'everyone'])]
    for i, ((q, opts), on) in enumerate(zip(qs, P['on'])):
        qy = 168 + i * 72
        s += T(qx, qy, q, 15, 'ink b')
        cx = qx
        for j, o in enumerate(opts):
            cw = len(o) * 7.3 + 22
            sel = j == on
            s += R(f'{cx:.0f}', qy + 12, f'{cw:.0f}', 28, 14, 'accent' if sel else 'surface line thin')
            s += T(f'{cx + cw/2:.0f}', qy + 31, o, 12.5, 'onAccent b' if sel else 'muted', 'middle')
            cx += cw + 6
        ly = ys[3 + i] - 5
        s += f'<path d="M{x+w+4} {ly} C {x+w+30} {ly}, {qx-34} {qy+26}, {qx-8} {qy+26}" class="nofill accentS thin"/>'
        s += f'<circle cx="{qx-8}" cy="{qy+26}" r="3" class="accent"/>'
    rx, ry, rw = 884, 150, 270
    name, band, glyph = ROWS[P['row']]
    s += T(rx, ry + 20, 'It lands on', 14, 'muted')
    s += R(rx, ry + 34, rw, 44, 22, band) + T(rx + rw / 2, ry + 62, name, 15, f'{glyph} b', 'middle')
    s += T(rx, ry + 104, P['because'], 14, 'ink')
    s += T(rx, ry + 126, 'the first answer that matters, read', 13, 'muted')
    s += T(rx, ry + 144, 'in a fixed order. No score to tune.', 13, 'muted')
    s += arrow(f'M{qx+400} 300 C {qx+420} 300, {rx-30} {ry+56}, {rx-6} {ry+56}', 'accent', 'mid')
    s += f'<line x1="{rx}" y1="{ry+176}" x2="{rx+rw}" y2="{ry+176}" class="line thin"/>'
    s += T(rx, ry + 206, 'Then', 14, 'ink b')
    for i, t in enumerate(['the kit checks every tool against it', 'a reviewer reads the five answers', 'in the catalog pull request', 'the catalog builds and signs it']):
        yy = ry + 236 + i * 26
        if i != 2:
            n = {0: '1', 1: '2', 3: '3'}[i]
            s += f'<circle cx="{rx+9}" cy="{yy-5}" r="9" class="accentSoft"/>' + T(rx + 9, yy - 1, n, 11, 'accentInk b', 'middle')
        s += T(rx + 26, yy, t, 13.5, 'ink')
    s += T(64, 548, P['foot'], 13, 'muted')
    return s, 'For plugin authors: five questions per permission', P['desc']

# ---------- write ----------
os.makedirs(OUT, exist_ok=True)
for f in os.listdir(OUT):
    if f.endswith('.svg'): os.remove(os.path.join(OUT, f))
bodies = {}
for S in SCENARIOS:
    for name, w, h, fn in DRAWINGS:
        res = fn(S)
        inner, title, desc = res[:3]
        if len(res) == 4: h = res[3]
        key = name if S is DEV else f'{name}-consultant'
        head = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" '
                f'aria-labelledby="t d"><title id="t">{esc(title)}</title><desc id="d">{esc(desc)}</desc>')
        for theme in THEMES:
            surf = THEMES[theme]['surface']
            svg = head + f'<style>{css(theme)} svg{{--s:{surf}}}</style><defs>{MARKERS}</defs>' + inner + '</svg>'
            svg = svg.replace('style="stroke:var(--s)"', f'stroke="{surf}"')
            svg = svg.replace('stroke="currentColor" style="stroke:var(--x,inherit)"', f'stroke="{THEMES[theme]["agent"]}"')
            open(os.path.join(OUT, f'{key}-{theme}.svg'), 'w').write(svg + '\n')
        bodies[key] = dict(w=w, h=h, title=title, desc=desc)
open(os.path.join(OUT, 'drawings.json'), 'w').write(json.dumps(bodies, ensure_ascii=False, indent=2) + '\n')
print('wrote', len(bodies), 'drawings')
