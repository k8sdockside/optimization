// The advisor's own overview: the score, where usage comes from, and every
// rule as a checklist -- tick a rule off to leave it out of the score, accept
// a finding to count it as decided. Choices are live at once, kept in the
// address while the tab is open, and saved to a ConfigMap on request.
//
// Bridge calls used here: ready, list, get, charts (through ../ui/load),
// patch and create (saving choices, applying a fix), open, openView, openUrl.

import { buildCluster, type Snapshot } from '../model/cluster';
import { formatBytes, formatCpu } from '../model/quantity';
import { analyze, type Outcome, type Report } from '../model/report';
import { bySeverity, CATEGORIES, type Finding, type Target } from '../model/rules';
import { CONFIGMAP, decodeSettings, encodeSettings, IGNORE_ANNOTATION, withAccepted, withRule, type Settings } from '../model/settings';
import type { Usage } from '../model/usage';
import { add, button, byId, chip, clear, el, icon, linkButton } from '../ui/dom';
import { plural } from '../ui/format';
import { applyFix, loadSaved, loadSnapshot, loadUsage, saveSettings, type Saved } from '../ui/load';
import { durable, keep, recall, strings } from '../ui/memory';
import { banner, declined, every, keepFocus, politely, readHash, sdk, writeHash } from '../ui/page';
import { bar, CATEGORY_ICON, checkbox, fixText, scoreRing, SEVERITY_TONE, severityChip, sourceNotice, targetButton, toneOf } from '../ui/widgets';

const REFRESH_EVERY = 60_000;
const USAGE_EVERY = 5 * 60_000;
const FINDINGS_SHOWN = 25;
const MI = 2 ** 20;

interface State {
    ctx: K8sDockside.Context | null;
    snap: Snapshot | null;
    usage: Usage | null;
    usageAt: number;
    saved: Saved | null;
    settings: Settings;
    report: Report | null;
    expanded: Set<string>;
    /** Categories folded away. */
    collapsed: Set<string>;
    showAll: Set<string>;
    filter: 'all' | 'open';
    busy: boolean;
}

const state: State = {
    ctx: null,
    snap: null,
    usage: null,
    usageAt: 0,
    saved: null,
    settings: decodeSettings(null),
    report: null,
    expanded: new Set(),
    collapsed: new Set(),
    showAll: new Set(),
    filter: 'all',
    busy: false,
};

function fail(err: unknown): void {
    if (!declined(err)) banner.show(err);
}

function openTarget(t: Target): void {
    sdk.open({ kind: t.kind, namespace: t.namespace, name: t.name }).catch(fail);
}

function openUrl(url: string): void {
    sdk.openUrl(url).catch(fail);
}

// ----- reading and deciding -------------------------------------------------------

async function refresh(): Promise<void> {
    const now = Date.now();
    const stale = !state.usage || now - state.usageAt > USAGE_EVERY;
    const [snap, usage] = await Promise.all([loadSnapshot(), stale ? loadUsage() : Promise.resolve(state.usage!)]);
    if (stale) state.usageAt = now;
    state.snap = snap;
    state.usage = usage;
    if (snap.missing.has('pods')) banner.show(new Error(`Could not read pods: ${snap.missing.get('pods')}`));
    else banner.clear();
    recompute(false);
}

/** Runs the rules again with the current choices. `now` for a user's own action, which should not wait. */
function recompute(now: boolean): void {
    if (!state.snap || !state.usage) return;
    state.report = analyze(buildCluster(state.snap, state.usage, { system: state.settings.system }), state.settings);
    remember();
    if (now) keepFocus(document.body, render);
    else draw();
}

function unsaved(): boolean {
    return !!state.saved && encodeSettings(state.settings) !== state.saved.text;
}

/** What is folded, unfolded and filtered: how the page is laid out, not the user's choices about rules. */
function viewState(): { collapsed: string[]; expanded: string[]; filter: string } {
    return { collapsed: [...state.collapsed].sort(), expanded: [...state.expanded].sort(), filter: state.filter };
}

/**
 * Keeps the page's state. Unsaved choices ride in the address while the tab
 * is open. How the page is laid out is kept by the app for this cluster,
 * across restarts, when `view` says it changed; on an app too old to keep it,
 * it rides in the address too.
 */
function remember(view = false): void {
    const v = viewState();
    writeHash({
        s: unsaved() ? encodeSettings(state.settings) : null,
        open: durable ? null : v.expanded.join(',') || null,
        c: durable ? null : v.collapsed.join(',') || null,
        f: durable || state.filter !== 'open' ? null : 'open',
    });
    if (view && durable) keep('overview', v);
}

function change(next: Settings): void {
    state.settings = next;
    recompute(true);
}

async function save(): Promise<void> {
    const saved = state.saved;
    if (!saved) return;
    state.busy = true;
    keepFocus(document.body, render);
    try {
        await saveSettings(state.settings, saved.exists);
        state.saved = { settings: state.settings, text: encodeSettings(state.settings), exists: true, error: '' };
    } catch (err) {
        fail(err);
    } finally {
        state.busy = false;
        remember();
        keepFocus(document.body, render);
    }
}

function discard(): void {
    if (state.saved) change(state.saved.settings);
}

async function apply(f: Finding): Promise<void> {
    if (!f.fix) return;
    try {
        await applyFix(f.fix);
        await refresh();
    } catch (err) {
        fail(err);
    }
}

function toggle(set: Set<string>, id: string): void {
    if (set.has(id)) set.delete(id);
    else set.add(id);
    // "Show all" is for this look only; folds and unfolds are kept.
    remember(set !== state.showAll);
    keepFocus(document.body, render);
}

/** Unfolds a category if it is folded, and scrolls to it. */
function reveal(category: string): void {
    if (state.collapsed.delete(category)) {
        remember(true);
        keepFocus(document.body, render);
    }
    document.getElementById('cat-' + category)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function foldAll(fold: boolean): void {
    state.collapsed = new Set(fold ? CATEGORIES.map((c) => c.id) : []);
    remember(true);
    keepFocus(document.body, render);
}

// ----- drawing ----------------------------------------------------------------------

const draw = politely(document.body, render);

function render(): void {
    const r = state.report;
    if (!r || !state.usage) return;
    renderHero(r);
    renderSource(state.usage);
    renderControls();
    renderRules(r);
    renderFoot();
}

function headline(r: Report): string {
    if (r.score === null) return 'Nothing to score yet';
    if (!r.open) return 'Nothing to fix — every rule that counts passes';
    return `${plural(r.open, 'tip')} to raise the score`;
}

function renderHero(r: Report): void {
    const hero = byId('hero');
    clear(hero);
    const body = el('div', 'hero-body');
    const story = el('p', 'hero-story');
    add(story, `Scored on ${r.scored} of ${r.total} rules`, r.accepted ? ` · ${plural(r.accepted, 'finding')} accepted` : '', '.');
    if (r.savings.cpu >= 0.05 || r.savings.memory >= 64 * MI) {
        add(story, ' The rightsizing tips would free ', el('strong', '', `${formatCpu(r.savings.cpu)} CPU`), ' and ', el('strong', '', formatBytes(r.savings.memory)), ' of requests.');
    }

    const cats = el('div', 'cats');
    for (const cat of r.categories) {
        const row = button('', 'cat', CATEGORY_ICON[cat.category], () => reveal(cat.category));
        row.dataset.focus = 'cat:' + cat.category;
        row.title = cat.score === null ? `${cat.label}: nothing scored` : `${cat.label}: ${cat.score} of 100, ${plural(cat.open, 'open tip')}`;
        add(
            row,
            el('span', 'cat-label', cat.label),
            bar((cat.score ?? 0) / 100, toneOf(cat.score)),
            el('span', 'cat-score', cat.score === null ? '–' : String(cat.score)),
            cat.open ? chip(String(cat.open), 'warn') : el('span', 'cat-none'),
        );
        cats.appendChild(row);
    }
    add(body, el('h1', 'hero-title ' + toneOf(r.score), headline(r)), story, cats);
    add(hero, scoreRing(r.score, r.grade), body);
}

function renderSource(u: Usage): void {
    const box = byId('source');
    clear(box);
    box.hidden = false;
    box.appendChild(sourceNotice(u, openUrl));
}

function renderControls(): void {
    const box = byId('controls');
    clear(box);
    box.hidden = false;
    const saved = state.saved;
    const canWrite = !!state.ctx?.write;

    const left = el('div', 'controls-left');
    left.appendChild(
        checkbox('Include system namespaces', state.settings.system, (on) => change({ ...state.settings, system: on }), {
            title: 'kube-system, kube-public, kube-node-lease and every namespace ending in -system',
            focus: 'system',
        }),
    );
    const seg = el('div', 'seg');
    for (const [value, label] of [
        ['all', 'All rules'],
        ['open', 'Only rules with tips'],
    ] as const) {
        const b = button(label, 'seg-btn' + (state.filter === value ? ' active' : ''), null, () => {
            state.filter = value;
            remember(true);
            keepFocus(document.body, render);
        });
        b.dataset.focus = 'filter:' + value;
        seg.appendChild(b);
    }
    left.appendChild(seg);
    const allFolded = CATEGORIES.every((c) => state.collapsed.has(c.id));
    const fold = button(allFolded ? 'Expand all' : 'Collapse all', 'small', allFolded ? 'chevron-down' : 'chevron', () => foldAll(!allFolded));
    fold.dataset.focus = 'fold-all';
    fold.title = durable ? 'Remembered for this cluster' : 'Remembered while this tab is open';
    left.appendChild(fold);

    const right = el('div', 'controls-right');
    const where = `${CONFIGMAP.namespace}/${CONFIGMAP.name}`;
    if (saved?.error) right.appendChild(el('span', 'save-state warn', `Could not read saved choices: ${saved.error}`));
    if (unsaved()) {
        right.appendChild(el('span', 'save-state', 'Changed — only in this tab until you save'));
        const discardButton = button('Discard', 'small', 'undo', discard);
        discardButton.dataset.focus = 'discard';
        const saveButton = button(state.busy ? 'Saving…' : 'Save to cluster', 'small primary', 'save', () => void save());
        saveButton.dataset.focus = 'save';
        saveButton.disabled = state.busy || !canWrite;
        saveButton.title = canWrite ? `Writes your choices to the ConfigMap ${where}, for next time and for everyone using this cluster` : 'This plugin is not allowed to write';
        add(right, discardButton, saveButton);
    } else if (saved && !saved.error) {
        right.appendChild(el('span', 'save-state faint', saved.exists ? `Choices saved in ${where}` : 'Default choices — nothing saved yet'));
    }
    add(box, left, right);
}

function renderRules(r: Report): void {
    const root = byId('rules');
    clear(root);
    root.hidden = false;
    let shown = 0;
    for (const cat of CATEGORIES) {
        const outcomes = r.outcomes
            .filter((o) => o.rule.category === cat.id && (state.filter === 'all' || (o.enabled && o.open.length > 0)))
            .sort((a, b) => bySeverity(a.rule, b.rule));
        if (!outcomes.length) continue;
        shown += outcomes.length;
        const section = el('section', 'cat-section');
        section.id = 'cat-' + cat.id;
        const score = r.categories.find((c) => c.category === cat.id)?.score ?? null;
        const folded = state.collapsed.has(cat.id);
        const head = el('h2', 'cat-head');
        const fold = button('', 'cat-toggle', folded ? 'chevron' : 'chevron-down', () => toggle(state.collapsed, cat.id));
        fold.dataset.focus = 'fold:' + cat.id;
        fold.setAttribute('aria-expanded', String(!folded));
        fold.title = folded ? `Show the ${cat.label} rules` : `Fold the ${cat.label} rules away`;
        add(fold, icon(CATEGORY_ICON[cat.id]), el('span', 'cat-name', cat.label));
        const tips = outcomes.reduce((n, o) => n + (o.enabled ? o.open.length : 0), 0);
        add(
            head,
            fold,
            folded ? el('span', 'cat-folded', `${plural(outcomes.length, 'rule')}${tips ? ` · ${plural(tips, 'tip')}` : ''}`) : null,
            chip(score === null ? 'not scored' : `${score}`, toneOf(score)),
        );
        section.classList.toggle('folded', folded);
        section.appendChild(head);
        if (!folded) for (const o of outcomes) section.appendChild(ruleRow(o));
        root.appendChild(section);
    }
    if (!shown) root.appendChild(el('p', 'empty', 'No rule that counts has a tip right now.'));
}

function status(o: Outcome): HTMLElement {
    if (!o.enabled) return chip('off', 'muted', undefined, 'Left out of the score');
    if (o.unavailable) return chip('can’t check', 'muted', 'info', o.unavailable);
    if (!o.eligible) return chip('nothing to check', 'muted');
    if (o.open.length) return chip(`${o.open.length} of ${o.eligible}`, SEVERITY_TONE[o.rule.severity], undefined, `${plural(o.open.length, 'open finding')} of ${o.eligible} checked`);
    return chip(o.accepted.length ? `passes · ${o.accepted.length} accepted` : 'passes', 'ok', 'check');
}

function ruleRow(o: Outcome): HTMLElement {
    const id = o.rule.id;
    const row = el('article', 'rule' + (o.enabled ? '' : ' off') + (o.unavailable ? ' na' : ''));
    const head = el('div', 'rule-head');

    const tick = document.createElement('input');
    tick.type = 'checkbox';
    tick.className = 'rule-toggle';
    tick.checked = o.enabled;
    tick.dataset.focus = 'toggle:' + id;
    tick.title = o.enabled ? 'Counts in the score — untick to leave it out' : 'Left out of the score — tick to count it';
    tick.setAttribute('aria-label', `${o.rule.title}: counts in the score`);
    tick.addEventListener('change', () => change(withRule(state.settings, o.rule, tick.checked)));

    const open = state.expanded.has(id);
    const title = button('', 'rule-title', open ? 'chevron-down' : 'chevron', () => toggle(state.expanded, id));
    title.dataset.focus = 'rule:' + id;
    title.setAttribute('aria-expanded', String(open));
    title.appendChild(el('span', 'rule-name', o.rule.title));

    add(head, tick, severityChip(o.rule.severity), title, status(o));
    row.appendChild(head);
    if (open) row.appendChild(ruleBody(o));
    return row;
}

function ruleBody(o: Outcome): HTMLElement {
    const id = o.rule.id;
    const body = el('div', 'rule-body');
    const how = el('p', 'rule-how');
    add(how, el('strong', '', 'What to do: '), o.rule.how);
    add(body, el('p', 'rule-why', o.rule.why), how);
    if (o.unavailable) {
        const na = el('p', 'rule-na');
        add(na, icon('info'), el('span', '', o.unavailable));
        body.appendChild(na);
    }
    if (o.open.length) {
        const limit = state.showAll.has(id) ? Infinity : FINDINGS_SHOWN;
        const list = el('ul', 'findings');
        for (const f of o.open.slice(0, limit)) list.appendChild(findingRow(f, false));
        body.appendChild(list);
        if (o.open.length > limit) body.appendChild(linkButton(`Show all ${o.open.length}`, () => toggle(state.showAll, id)));
    }
    if (o.accepted.length) {
        const details = el('details', 'accepted');
        details.appendChild(el('summary', '', plural(o.accepted.length, 'accepted finding')));
        const list = el('ul', 'findings');
        for (const f of o.accepted) list.appendChild(findingRow(f, true));
        details.appendChild(list);
        body.appendChild(details);
    }
    const foot = el('p', 'rule-id');
    add(foot, 'Rule ', el('code', '', id), '. To opt an object out in Git, annotate it ', el('code', '', `${IGNORE_ANNOTATION}: "${id}"`), '.');
    body.appendChild(foot);
    return body;
}

function findingRow(f: Finding, accepted: boolean): HTMLElement {
    const li = el('li', 'finding' + (accepted ? ' accepted' : ''));
    const main = el('div', 'finding-main');
    add(main, targetButton(f.target, openTarget), el('span', 'finding-detail', f.detail));
    const actions = el('div', 'finding-actions');
    if (accepted) {
        if (state.settings.accepted.includes(f.key)) {
            const undo = button('Undo', 'small', 'undo', () => change(withAccepted(state.settings, f.key, false)));
            undo.dataset.focus = 'undo:' + f.key;
            actions.appendChild(undo);
        } else {
            actions.appendChild(chip('annotated', 'muted', 'info', `The object or its namespace carries ${IGNORE_ANNOTATION}`));
        }
    } else {
        if (f.fix && state.ctx?.write) {
            const fix = button('Apply', 'small primary', 'wand', () => void apply(f));
            fix.title = `Change ${f.target.label} — ${fixText(f.fix)}. You see the patch before it is applied.`;
            fix.dataset.focus = 'apply:' + f.key;
            actions.appendChild(fix);
        }
        const accept = button('Accept', 'small', 'accept', () => change(withAccepted(state.settings, f.key, true)));
        accept.title = 'You have decided to live with this one: it counts as passing, and stays listed under accepted';
        accept.dataset.focus = 'accept:' + f.key;
        actions.appendChild(accept);
    }
    add(li, main, actions);
    return li;
}

function renderFoot(): void {
    const foot = byId('foot');
    clear(foot);
    foot.hidden = false;
    const view = linkButton('Rightsizing — every container, requests against use', () => sdk.openView('rightsizing').catch(fail));
    foot.appendChild(view);
    for (const link of state.ctx?.plugin?.links ?? []) foot.appendChild(linkButton(link.label, () => openUrl(link.url), link.url));
    if (state.ctx?.plugin?.version) foot.appendChild(el('span', 'faint', `v${state.ctx.plugin.version}`));
}

// ----- start --------------------------------------------------------------------------

sdk.ready()
    .then(async (ctx) => {
        state.ctx = ctx;
        const hash = readHash();
        const split = (text: string | undefined): string[] => (text ?? '').split(',').filter(Boolean);
        const view = durable
            ? await recall<{ collapsed?: unknown; expanded?: unknown; filter?: unknown }>('overview', {})
            : { collapsed: split(hash.c), expanded: split(hash.open), filter: hash.f };
        state.collapsed = new Set(strings(view.collapsed));
        state.expanded = new Set(strings(view.expanded));
        state.filter = view.filter === 'open' ? 'open' : 'all';
        state.saved = await loadSaved();
        state.settings = hash.s ? decodeSettings(hash.s) : state.saved.settings;
        every(REFRESH_EVERY, refresh);
    })
    .catch(fail);
