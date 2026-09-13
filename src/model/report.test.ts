import { describe, expect, it } from 'vitest';
import { buildCluster, type Snapshot } from './cluster';
import { container, deployment, NOW, snapshot } from './fixtures';
import { analyze, grade } from './report';
import type { Rule, RuleResult } from './rules';
import { DEFAULT_SETTINGS, IGNORE_ANNOTATION, withAccepted, withRule, type Settings } from './settings';
import { noUsage } from './usage';

function fake(id: string, severity: Rule['severity'], result: () => RuleResult, extra: Partial<Rule> = {}): Rule {
    return { id, title: id, category: 'reliability', severity, defaultOn: true, why: '', how: '', run: result, ...extra };
}

function report(rules: Rule[], settings: Settings = DEFAULT_SETTINGS, snap: Snapshot = snapshot({})) {
    return analyze(buildCluster(snap, noUsage('none'), { system: settings.system, now: NOW }), settings, rules);
}

const target = (name: string) => ({ kind: 'deployments', namespace: 'shop', name, label: `Deployment shop/${name}` });
const finding = (rule: string, name: string) => ({ rule, key: `${rule}:deployments/shop/${name}`, target: target(name), detail: '' });

describe('the score', () => {
    it('weighs pass rates by severity', () => {
        // high: 1 of 2 pass (0.5 × 5), low: all pass (1 × 1): 3.5 / 6.
        const r = report([
            fake('a', 'high', () => ({ eligible: 2, findings: [finding('a', 'x')] })),
            fake('b', 'low', () => ({ eligible: 4, findings: [] })),
        ]);
        expect(r.score).toBe(58);
        expect(r.grade).toBe('D');
        expect(r.open).toBe(1);
        expect(r.scored).toBe(2);
    });

    it('is 100 when nothing is wrong, and null when nothing could be looked at', () => {
        expect(report([fake('a', 'high', () => ({ eligible: 3, findings: [] }))]).score).toBe(100);
        expect(report([fake('a', 'high', () => ({ eligible: 0, findings: [] }))]).score).toBeNull();
    });

    it('leaves out a rule switched off, and one that could not look', () => {
        const rules = [
            fake('a', 'high', () => ({ eligible: 1, findings: [finding('a', 'x')] })),
            fake('b', 'low', () => ({ eligible: 1, findings: [] })),
            fake('c', 'high', () => ({ eligible: 0, findings: [], unavailable: 'no data' })),
        ];
        const off = report(rules, withRule(DEFAULT_SETTINGS, rules[0]!, false));
        expect(off.score).toBe(100);
        expect(off.scored).toBe(1);
        expect(off.outcomes[2]!.unavailable).toBe('no data');
    });

    it('counts a rule that is off by default only once it is switched on', () => {
        const rule = fake('a', 'high', () => ({ eligible: 1, findings: [finding('a', 'x')] }), { defaultOn: false });
        expect(report([rule]).score).toBeNull();
        expect(report([rule], withRule(DEFAULT_SETTINGS, rule, true)).score).toBe(0);
    });

    it('counts an accepted finding as passing, and still lists it', () => {
        const rule = fake('a', 'high', () => ({ eligible: 2, findings: [finding('a', 'x'), finding('a', 'y')] }));
        const r = report([rule], withAccepted(DEFAULT_SETTINGS, 'a:deployments/shop/x', true));
        expect(r.score).toBe(50);
        expect(r.outcomes[0]!.accepted.map((f) => f.target.name)).toEqual(['x']);
        expect(r.accepted).toBe(1);
    });

    it('honours the ignore annotation on the object and on its namespace', () => {
        const rule = fake('a', 'high', () => ({ eligible: 3, findings: [finding('a', 'x'), finding('a', 'y')] }));
        const x = deployment('x', [container('x')], { annotations: { [IGNORE_ANNOTATION]: 'other, a' } });
        const snap = snapshot({ deployments: [x] });
        expect(report([rule], DEFAULT_SETTINGS, snap).outcomes[0]!.accepted.map((f) => f.target.name)).toEqual(['x']);

        const ns = { metadata: { name: 'shop', annotations: { [IGNORE_ANNOTATION]: '*' } } };
        expect(report([rule], DEFAULT_SETTINGS, snapshot({ namespaces: [ns] })).score).toBe(100);
    });

    it('turns a rule that throws into one that could not look, and keeps the others', () => {
        const r = report([
            fake('boom', 'high', () => {
                throw new Error('odd object');
            }),
            fake('fine', 'low', () => ({ eligible: 1, findings: [] })),
        ]);
        expect(r.outcomes[0]!.unavailable).toContain('odd object');
        expect(r.score).toBe(100);
    });

    it('grades', () => {
        expect([95, 80, 65, 45, 10, null].map(grade)).toEqual(['A', 'B', 'C', 'D', 'E', '–']);
    });
});
