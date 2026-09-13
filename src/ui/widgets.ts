// The pieces both pages draw with: the score ring, a bar, a severity, an
// object to open, and the notice about where usage comes from.

import type { Category, ResourceFix, Severity, Target } from '../model/rules';
import type { Usage } from '../model/usage';
import { add, button, chip, el, icon, linkButton, svg, type ChipTone } from './dom';
import { kindIcon, type IconName } from './icons';

export const CATEGORY_ICON: Readonly<Record<Category, IconName>> = {
    resources: 'resources',
    usage: 'usage',
    reliability: 'reliability',
    scaling: 'scaling',
    waste: 'waste',
    nodes: 'node',
    security: 'security',
    observability: 'observability',
};

export const SEVERITY_TONE: Readonly<Record<Severity, ChipTone>> = { high: 'error', medium: 'warn', low: 'info' };

export function toneOf(score: number | null): ChipTone {
    if (score === null) return 'muted';
    if (score >= 75) return 'ok';
    if (score >= 50) return 'warn';
    return 'error';
}

export function scoreRing(score: number | null, grade: string, size = 148): HTMLElement {
    const thickness = 12;
    const r = (size - thickness) / 2;
    const c = 2 * Math.PI * r;
    const mid = size / 2;
    const wrap = el('div', 'score-ring ' + toneOf(score));
    wrap.style.width = wrap.style.height = size + 'px';
    const drawing = svg('svg', { viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': score === null ? 'No score yet' : `Score ${score} of 100, grade ${grade}` });
    drawing.appendChild(svg('circle', { cx: mid, cy: mid, r, class: 'score-track', 'stroke-width': thickness }));
    if (score !== null && score > 0) {
        drawing.appendChild(
            svg('circle', { cx: mid, cy: mid, r, class: 'score-arc', 'stroke-width': thickness, 'stroke-dasharray': `${(score / 100) * c} ${c}`, transform: `rotate(-90 ${mid} ${mid})` }),
        );
    }
    const centre = el('div', 'score-centre');
    add(centre, el('div', 'score-number', score === null ? '–' : String(score)), el('div', 'score-grade', score === null ? 'no score' : `grade ${grade}`));
    add(wrap, drawing, centre);
    return wrap;
}

export function bar(fraction: number, tone: ChipTone): HTMLElement {
    const node = el('span', 'bar');
    const fill = el('i', 'bar-fill ' + tone);
    fill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    node.appendChild(fill);
    return node;
}

export function severityChip(severity: Severity): HTMLElement {
    const node = chip(severity, SEVERITY_TONE[severity]);
    node.classList.add('sev');
    node.title = `${severity} severity: weighs ${severity === 'high' ? 5 : severity === 'medium' ? 3 : 1} in the score`;
    return node;
}

/** The object a finding is about, as a button that opens it in the app. */
export function targetButton(t: Target, open: (t: Target) => void): HTMLElement {
    if (!t.kind) {
        const node = el('span', 'target');
        add(node, icon('cluster'), el('span', 'target-label', t.label));
        return node;
    }
    const node = button('', 'target', kindIcon(t.kind), () => open(t));
    add(node, el('span', 'target-label', t.label), t.container ? el('span', 'target-container', t.container) : null);
    node.title = `Open ${t.label}`;
    node.dataset.focus = `target:${t.kind}/${t.namespace}/${t.name}/${t.container ?? ''}`;
    return node;
}

export function checkbox(text: string, checked: boolean, onChange: (on: boolean) => void, opts: { title?: string; focus?: string; disabled?: boolean } = {}): HTMLLabelElement {
    const label = el('label', 'check');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.disabled = !!opts.disabled;
    if (opts.focus) input.dataset.focus = opts.focus;
    input.addEventListener('change', () => onChange(input.checked));
    add(label, input, el('span', '', text));
    if (opts.title) label.title = opts.title;
    return label;
}

/** What a fix changes, in words: "api: cpu request → 130m, memory limit → 512Mi". */
export function fixText(fix: ResourceFix): string {
    const parts: string[] = [];
    for (const [resource, value] of Object.entries(fix.requests)) parts.push(`${resource} request → ${value}`);
    for (const [resource, value] of Object.entries(fix.limits)) parts.push(`${resource} limit → ${value}`);
    return `${fix.container}: ${parts.join(', ')}`;
}

const STACKS = [
    { label: 'kube-prometheus-stack', url: 'https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack' },
    { label: 'victoria-metrics-k8s-stack', url: 'https://docs.victoriametrics.com/helm/victoria-metrics-k8s-stack/' },
];
const METRICS_SERVER = { label: 'metrics-server', url: 'https://github.com/kubernetes-sigs/metrics-server' };

/**
 * Where usage comes from, said once at the top. With no Prometheus it is a
 * tip -- what to install and why it is better -- never an error.
 */
export function sourceNotice(u: Usage, openUrl: (url: string) => void): HTMLElement {
    if (u.source === 'prometheus') {
        const box = el('div', 'notice ok');
        const body = el('div', 'notice-body');
        add(body, el('div', 'notice-head', `Usage: a day of history from ${u.where}`), u.note ? el('p', 'notice-why', u.note) : null);
        add(box, icon('check'), body);
        return box;
    }
    const box = el('div', 'notice tip');
    const body = el('div', 'notice-body');
    const ms = u.source === 'metrics-server';
    add(
        body,
        el('div', 'notice-head', ms ? 'Tip: rightsizing would be better with Prometheus or VictoriaMetrics' : 'Tip: install Prometheus or VictoriaMetrics to turn on rightsizing'),
        el(
            'p',
            'notice-text',
            ms
                ? 'Usage comes from metrics-server — one reading of right now. A day of history sizes requests on real peaks, and lets Apply write the suggestion for you. K8s Dockside finds either one by itself.'
                : 'There is no usage data, so the rightsizing rules are left out of the score. Prometheus or VictoriaMetrics give a day of history; metrics-server alone gives a reading of right now. Every other rule works without them.',
        ),
        u.note ? el('p', 'notice-why', `Why: ${u.note}.`) : null,
    );
    const links = el('div', 'notice-links');
    for (const link of ms ? STACKS : [...STACKS, METRICS_SERVER]) links.appendChild(linkButton(link.label, () => openUrl(link.url), link.url));
    body.appendChild(links);
    add(box, icon('tip'), body);
    return box;
}
