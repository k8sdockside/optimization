// Every workload container that has usage readings, as a table: request,
// use and suggestion for CPU and memory, and an Apply button where a day of
// history backs the suggestion.
//
// Bridge calls used here: ready, list, get, charts (through ../ui/load),
// patch (Apply), open, openView, openUrl.

import { buildCluster, type Snapshot } from '../model/cluster';
import { cpuQuantity, formatBytes, formatCpu, memoryQuantity, parseQuantity } from '../model/quantity';
import type { Verdict } from '../model/resources';
import { GIB_PER_CORE, sizingRows, type Sizing, type SizingRow } from '../model/rightsizing';
import type { Target } from '../model/rules';
import type { Usage } from '../model/usage';
import { add, button, byId, chip, clear, el, type ChipTone } from '../ui/dom';
import { plural } from '../ui/format';
import { applyFix, loadSaved, loadSnapshot, loadUsage } from '../ui/load';
import { durable, keep, recall } from '../ui/memory';
import { banner, declined, every, keepFocus, politely, readHash, sdk, writeHash } from '../ui/page';
import { checkbox, fixText, sourceNotice, targetButton } from '../ui/widgets';

const REFRESH_EVERY = 60_000;
const USAGE_EVERY = 5 * 60_000;

interface State {
    ctx: K8sDockside.Context | null;
    snap: Snapshot | null;
    usage: Usage | null;
    usageAt: number;
    rows: SizingRow[];
    system: boolean;
    query: string;
    onlyTips: boolean;
}

const state: State = { ctx: null, snap: null, usage: null, usageAt: 0, rows: [], system: false, query: '', onlyTips: true };

function fail(err: unknown): void {
    if (!declined(err)) banner.show(err);
}

function openTarget(t: Target): void {
    sdk.open({ kind: t.kind, namespace: t.namespace, name: t.name }).catch(fail);
}

async function refresh(): Promise<void> {
    const now = Date.now();
    const stale = !state.usage || now - state.usageAt > USAGE_EVERY;
    const [snap, usage] = await Promise.all([loadSnapshot(), stale ? loadUsage() : Promise.resolve(state.usage!)]);
    if (stale) state.usageAt = now;
    state.snap = snap;
    state.usage = usage;
    if (snap.missing.has('pods')) banner.show(new Error(`Could not read pods: ${snap.missing.get('pods')}`));
    else banner.clear();
    recompute();
    draw();
}

function recompute(): void {
    if (!state.snap || !state.usage) return;
    state.rows = sizingRows(buildCluster(state.snap, state.usage, { system: state.system }));
}

/**
 * The search rides in the address while the tab is open; the two filters are
 * kept by the app for this cluster when `view` says they changed -- or ride in
 * the address too, on an app too old to keep them.
 */
function remember(view = true): void {
    writeHash({
        q: state.query || null,
        all: durable || state.onlyTips ? null : '1',
        sys: durable || !state.system ? null : '1',
    });
    if (view && durable) keep('rightsizing', { onlyTips: state.onlyTips, system: state.system });
}

async function apply(row: SizingRow): Promise<void> {
    if (!row.fix) return;
    try {
        await applyFix(row.fix);
        await refresh();
    } catch (err) {
        fail(err);
    }
}

// ----- drawing ----------------------------------------------------------------------

const draw = politely(document.body, render);

function render(): void {
    if (!state.usage) return;
    const source = byId('source');
    clear(source);
    source.appendChild(sourceNotice(state.usage, (url) => sdk.openUrl(url).catch(fail)));
    renderToolbar();
    renderTable();
}

function renderToolbar(): void {
    const bar = byId('toolbar');
    if (!bar.hidden) return; // drawn once: the search field must keep its caret
    bar.hidden = false;
    const left = el('div', 'controls-left');
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'search';
    search.placeholder = 'Filter by namespace, workload or container';
    search.value = state.query;
    search.addEventListener('input', () => {
        state.query = search.value;
        remember(false);
        renderTable();
    });
    add(
        left,
        search,
        checkbox('Only containers with a tip', state.onlyTips, (on) => {
            state.onlyTips = on;
            remember();
            keepFocus(document.body, renderTable);
        }),
        checkbox('Include system namespaces', state.system, (on) => {
            state.system = on;
            remember();
            recompute();
            keepFocus(document.body, renderTable);
        }),
    );
    const right = el('div', 'controls-right');
    right.appendChild(button('Overview', 'small', 'gauge', () => sdk.openView('overview').catch(fail)));
    add(bar, left, right);
}

const VERDICT: Record<Verdict, { text: string; tone: ChipTone } | null> = {
    over: { text: 'over', tone: 'warn' },
    under: { text: 'under', tone: 'warn' },
    'near-limit': { text: 'near limit', tone: 'error' },
    ok: { text: 'ok', tone: 'ok' },
    unknown: null,
};

function hasTip(row: SizingRow): boolean {
    const off = (s: Sizing): boolean => s.verdict !== 'ok' && (s.verdict !== 'unknown' || (!Number.isFinite(s.request) && Number.isFinite(s.used)));
    return off(row.cpu) || off(row.memory);
}

function visible(): SizingRow[] {
    const q = state.query.trim().toLowerCase();
    return state.rows.filter((row) => (!state.onlyTips || hasTip(row)) && (!q || row.key.toLowerCase().includes(q)));
}

function cell(sizing: Sizing, format: (n: number) => string, quantity: (n: number) => string): HTMLElement {
    const td = el('td', 'num');
    const verdict = !Number.isFinite(sizing.request) && Number.isFinite(sizing.used) ? { text: 'no request', tone: 'warn' as ChipTone } : VERDICT[sizing.verdict];
    const suggested = Number.isFinite(sizing.suggested) ? format(parseQuantity(quantity(sizing.suggested))) : '—';
    const line = el('div', 'sizing');
    add(line, el('span', 'req', format(sizing.request)), el('span', 'arrow', '·'), el('span', 'used', format(sizing.used)));
    if (verdict && verdict.tone !== 'ok') add(line, el('span', 'arrow', '→'), el('strong', 'sug', suggested));
    add(td, line, verdict ? chip(verdict.text, verdict.tone) : null);
    td.title = `request ${format(sizing.request)}${Number.isFinite(sizing.limit) ? `, limit ${format(sizing.limit)}` : ''}, used ${format(sizing.used)}, suggested ${suggested}`;
    return td;
}

/** What following the row changes over all its pods: green where it frees requests, amber where it asks for more. */
function changeCell(row: SizingRow): HTMLElement {
    const td = el('td', 'num change');
    const parts: HTMLElement[] = [];
    const part = (value: number, text: (n: number) => string): void => {
        if (Math.abs(value) < 1e-9) return;
        parts.push(el('span', value < 0 ? 'frees' : 'needs', `${value < 0 ? '−' : '+'}${text(Math.abs(value))}`));
    };
    part(row.change.cpu, (n) => `${formatCpu(n)} CPU`);
    part(row.change.memory, formatBytes);
    part(row.change.memoryLimit, (n) => `${formatBytes(n)} limit`);
    if (!parts.length) td.appendChild(el('span', 'faint', '—'));
    parts.forEach((p, i) => add(td, i ? ' · ' : null, p));
    td.title = `Summed over the ${plural(row.change.pods, 'pod')} measured. Minus frees requests on the nodes; plus asks for more.`;
    return td;
}

function renderTable(): void {
    const box = byId('table');
    clear(box);
    const u = state.usage;
    if (!u) return;
    if (u.source === 'none') {
        box.appendChild(el('p', 'empty', 'Rightsizing needs usage data — see the tip above. Everything else the advisor checks is on the Overview.'));
        return;
    }
    const rows = visible();
    const history = u.source === 'prometheus';
    box.appendChild(
        el(
            'p',
            'faint small',
            `${plural(rows.length, 'container')} shown of ${state.rows.length} with readings, biggest change first (a core weighs as much as ${GIB_PER_CORE} GiB). ` +
                (history ? 'Usage is the last day: CPU at its 95th percentile, memory at its peak.' : 'Usage is one reading from metrics-server, so there is no Apply: a request is not sized on one moment.'),
        ),
    );
    if (!rows.length) {
        box.appendChild(el('p', 'empty', state.onlyTips ? 'Every container is sized about right.' : 'Nothing matches.'));
        return;
    }
    const table = el('table', 'grid');
    const head = el('tr');
    for (const h of ['Workload', 'CPU  request · used → suggested', 'Memory  request · used → suggested', 'Change, all pods', '']) head.appendChild(el('th', '', h));
    table.appendChild(add(el('thead'), head));
    const body = el('tbody');
    for (const row of rows) {
        const tr = el('tr');
        const who = el('td');
        who.appendChild(targetButton({ kind: APP_KINDS[row.s.w.kind] ?? '', namespace: row.s.w.namespace, name: row.s.w.name, label: `${row.s.w.namespace}/${row.s.w.name}`, container: row.s.container.name }, openTarget));
        const action = el('td', 'act');
        if (row.fix && state.ctx?.write) {
            const b = button('Apply', 'small primary', 'wand', () => void apply(row));
            b.title = `${fixText(row.fix)}. You see the patch before it is applied.`;
            b.dataset.focus = 'apply:' + row.key;
            action.appendChild(b);
        }
        add(tr, who, cell(row.cpu, formatCpu, cpuQuantity), cell(row.memory, formatBytes, memoryQuantity), changeCell(row), action);
        body.appendChild(tr);
    }
    table.appendChild(body);
    box.appendChild(table);
}

const APP_KINDS: Readonly<Record<string, string>> = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets', CronJob: 'cronjobs', Job: 'jobs' };

// ----- start --------------------------------------------------------------------------

sdk.ready()
    .then(async (ctx) => {
        state.ctx = ctx;
        const hash = readHash();
        state.query = hash.q ?? '';
        const view = durable ? await recall<{ onlyTips?: unknown; system?: unknown }>('rightsizing', {}) : {};
        state.onlyTips = typeof view.onlyTips === 'boolean' ? view.onlyTips : hash.all !== '1';
        state.system =
            typeof view.system === 'boolean' ? view.system : hash.sys ? hash.sys === '1' : (await loadSaved()).settings.system;
        every(REFRESH_EVERY, refresh);
    })
    .catch(fail);
