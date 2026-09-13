// Every rule run against the cluster, with the user's choices applied, and
// the score that comes out.
//
// The score is a weighted average of pass rates:
//
//     score = 100 × Σ weight × (eligible − open) / eligible  ÷  Σ weight
//
// over the rules that are switched on, could look, and had something to look
// at. A high-severity rule weighs 5, medium 3, low 1. An accepted finding
// counts as passing -- it has been looked at and decided on -- but is still
// listed; a rule switched off drops out of the score entirely.

import type { Cluster } from './cluster';
import { CATEGORIES, RULES, WEIGHT, type Category, type Finding, type Rule } from './rules';
import { ignoredBy, ruleEnabled, type Settings } from './settings';

export interface Outcome {
    rule: Rule;
    enabled: boolean;
    eligible: number;
    open: Finding[];
    accepted: Finding[];
    /** Why the rule could not look; '' when it could. */
    unavailable: string;
    /** Share of eligible things that pass, 0..1; null when it is not scored. */
    passRate: number | null;
}

export interface CategoryScore {
    category: Category;
    label: string;
    score: number | null;
    open: number;
}

export interface Report {
    outcomes: Outcome[];
    score: number | null;
    grade: string;
    categories: CategoryScore[];
    /** Rules that went into the score, and how many there are. */
    scored: number;
    total: number;
    open: number;
    accepted: number;
    /** Cores and bytes of requests the open rightsizing tips would free. */
    savings: { cpu: number; memory: number };
}

export function analyze(c: Cluster, settings: Settings, rules: readonly Rule[] = RULES): Report {
    const acceptedKeys = new Set(settings.accepted);
    const outcomes: Outcome[] = rules.map((rule) => {
        const enabled = ruleEnabled(settings, rule);
        const missing = (rule.needs ?? []).filter((k) => c.missing.has(k));
        if (missing.length) {
            const kind = missing[0]!;
            return { rule, enabled, eligible: 0, open: [], accepted: [], unavailable: `Could not read ${kind}: ${c.missing.get(kind)}`, passRate: null };
        }
        let result;
        try {
            result = rule.run(c);
        } catch (err) {
            // One rule tripping over an odd object must not take the others with it.
            return { rule, enabled, eligible: 0, open: [], accepted: [], unavailable: `This rule failed: ${err instanceof Error ? err.message : String(err)}`, passRate: null };
        }
        const open: Finding[] = [];
        const accepted: Finding[] = [];
        for (const f of sortFindings(result.findings)) {
            const t = f.target;
            const byAnnotation = t.kind !== '' && (ignoredBy(c.annotationsOf(t.kind, t.namespace, t.name), rule.id) || (t.namespace !== '' && ignoredBy(c.annotationsOf('namespaces', '', t.namespace), rule.id)));
            (acceptedKeys.has(f.key) || byAnnotation ? accepted : open).push(f);
        }
        const unavailable = result.unavailable ?? '';
        const eligible = Math.max(result.eligible, result.findings.length);
        const passRate = unavailable || !eligible ? null : (eligible - open.length) / eligible;
        return { rule, enabled, eligible, open, accepted, unavailable, passRate };
    });

    const counted = outcomes.filter((o) => o.enabled && o.passRate !== null);
    const categories = CATEGORIES.map(({ id, label }) => {
        const mine = counted.filter((o) => o.rule.category === id);
        return { category: id, label, score: weighted(mine), open: mine.reduce((n, o) => n + o.open.length, 0) };
    }).filter((cat) => outcomes.some((o) => o.rule.category === cat.category));

    const savings = { cpu: 0, memory: 0 };
    for (const o of counted) {
        for (const f of o.open) {
            if (f.saving && f.saving.cpu > 0) savings.cpu += f.saving.cpu;
            if (f.saving && f.saving.memory > 0) savings.memory += f.saving.memory;
        }
    }

    const score = weighted(counted);
    return {
        outcomes,
        score,
        grade: grade(score),
        categories,
        scored: counted.length,
        total: outcomes.length,
        open: counted.reduce((n, o) => n + o.open.length, 0),
        accepted: counted.reduce((n, o) => n + o.accepted.length, 0),
        savings,
    };
}

function weighted(outcomes: Outcome[]): number | null {
    let sum = 0;
    let weights = 0;
    for (const o of outcomes) {
        if (o.passRate === null) continue;
        const w = WEIGHT[o.rule.severity];
        sum += w * o.passRate;
        weights += w;
    }
    return weights ? Math.round((sum / weights) * 100) : null;
}

export function grade(score: number | null): string {
    if (score === null) return '–';
    if (score >= 90) return 'A';
    if (score >= 75) return 'B';
    if (score >= 60) return 'C';
    if (score >= 40) return 'D';
    return 'E';
}

function sortFindings(list: Finding[]): Finding[] {
    return [...list].sort((a, b) => a.target.namespace.localeCompare(b.target.namespace) || a.target.name.localeCompare(b.target.name) || (a.target.container ?? '').localeCompare(b.target.container ?? ''));
}
