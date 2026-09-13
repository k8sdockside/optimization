import { describe, expect, it } from 'vitest';
import { buildCluster, type Snapshot } from './cluster';
import { container, deployment, MI, node, NOW, podOf, snapshot } from './fixtures';
import type { Hpa, Pdb, Service } from './kube';
import { bySeverity, imageTag, ruleById, RULES, type RuleResult } from './rules';
import { containerKey, noUsage, type Usage } from './usage';

function run(id: string, snap: Snapshot, usage: Usage = noUsage('nothing installed'), system = false): RuleResult {
    const rule = ruleById(id);
    if (!rule) throw new Error(`no rule ${id}`);
    return rule.run(buildCluster(snap, usage, { system, now: NOW }));
}

function prometheus(readings: Record<string, { cpu?: number; memory?: number }>): Usage {
    const byContainer = new Map(Object.entries(readings).map(([k, v]) => [k, { cpu: v.cpu ?? NaN, memory: v.memory ?? NaN }]));
    return { source: 'prometheus', where: 'monitoring/prometheus-operated:web', byContainer, note: '' };
}

const sized = { requests: { cpu: '100m', memory: '128Mi' }, limits: { memory: '256Mi' } };

describe('the rule list', () => {
    it('has unique ids, and a why and a how for every rule', () => {
        const ids = RULES.map((r) => r.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const r of RULES) {
            expect(r.why.length, r.id).toBeGreaterThan(20);
            expect(r.how.length, r.id).toBeGreaterThan(10);
        }
    });

    it('sorts high, then medium, then low, keeping the rules’ own order within one severity', () => {
        const reliability = RULES.filter((r) => r.category === 'reliability');
        const sorted = [...reliability].sort(bySeverity);
        expect(sorted.map((r) => r.severity)).toEqual([...sorted.map((r) => r.severity)].sort((a, b) => ['high', 'medium', 'low'].indexOf(a) - ['high', 'medium', 'low'].indexOf(b)));
        expect(sorted[0]!.severity).toBe('high');
        expect(sorted[sorted.length - 1]!.severity).toBe('low');
        const mediums = sorted.filter((r) => r.severity === 'medium').map((r) => r.id);
        expect(mediums).toEqual(reliability.filter((r) => r.severity === 'medium').map((r) => r.id));
    });
});

describe('requests-missing', () => {
    it('flags a container with no requests, not one whose limits stand in for them', () => {
        const bare = deployment('api', [container('api')]);
        const limited = deployment('web', [container('web', { limits: { cpu: '500m', memory: '256Mi' } })]);
        const result = run('requests-missing', snapshot({ deployments: [bare, limited] }));
        expect(result.eligible).toBe(2);
        expect(result.findings.map((f) => f.target.name)).toEqual(['api']);
        expect(result.findings[0]!.detail).toContain('no cpu or memory request');
    });

    it('reads the running pod over the template, since a LimitRange fills requests in at admission', () => {
        const d = deployment('api', [container('api')]);
        const pod = podOf(d, 0, { containers: [container('api', sized)] });
        expect(run('requests-missing', snapshot({ deployments: [d], pods: [pod] })).findings).toEqual([]);
    });

    it('leaves system namespaces out unless asked', () => {
        const d = deployment('coredns', [container('coredns')], { namespace: 'kube-system' });
        expect(run('requests-missing', snapshot({ deployments: [d] })).eligible).toBe(0);
        expect(run('requests-missing', snapshot({ deployments: [d] }), undefined, true).findings).toHaveLength(1);
    });
});

describe('reliability', () => {
    it('single-replica passes a workload an autoscaler keeps above one', () => {
        const one = deployment('api', [container('api', sized)], { replicas: 1 });
        const scaled = deployment('web', [container('web', sized)], { replicas: 1 });
        const hpa: Hpa = { metadata: { name: 'web', namespace: 'shop' }, spec: { scaleTargetRef: { kind: 'Deployment', name: 'web' }, minReplicas: 2, maxReplicas: 5 } };
        const result = run('single-replica', snapshot({ deployments: [one, scaled], horizontalpodautoscalers: [hpa] }));
        expect(result.findings.map((f) => f.target.name)).toEqual(['api']);
    });

    it('pdb-missing matches budgets by their selector', () => {
        const covered = deployment('api', [container('api', sized)], { replicas: 3 });
        const bare = deployment('web', [container('web', sized)], { replicas: 3 });
        const pdb: Pdb = { metadata: { name: 'api', namespace: 'shop' }, spec: { selector: { matchLabels: { app: 'api' } }, maxUnavailable: 1 } };
        const result = run('pdb-missing', snapshot({ deployments: [covered, bare], poddisruptionbudgets: [pdb] }));
        expect(result.eligible).toBe(2);
        expect(result.findings.map((f) => f.target.name)).toEqual(['web']);
    });

    it('pdb-blocking flags a budget that blocks while everything is healthy, not one waiting on a sick pod', () => {
        const blocking: Pdb = { metadata: { name: 'db', namespace: 'shop' }, status: { expectedPods: 3, currentHealthy: 3, desiredHealthy: 3, disruptionsAllowed: 0 } };
        const degraded: Pdb = { metadata: { name: 'api', namespace: 'shop' }, status: { expectedPods: 3, currentHealthy: 2, desiredHealthy: 3, disruptionsAllowed: 0 } };
        const result = run('pdb-blocking', snapshot({ poddisruptionbudgets: [blocking, degraded] }));
        expect(result.findings.map((f) => f.target.name)).toEqual(['db']);
    });

    it('topology-spread cannot check a single-node cluster, and says all pods share a node', () => {
        const d = deployment('api', [container('api', sized)], { replicas: 2 });
        const pods = [podOf(d, 0), podOf(d, 1)];
        expect(run('topology-spread', snapshot({ deployments: [d], pods, nodes: [node('node-a')] })).unavailable).toContain('one schedulable node');
        const two = run('topology-spread', snapshot({ deployments: [d], pods, nodes: [node('node-a'), node('node-b')] }));
        expect(two.findings[0]!.detail).toBe('all 2 pods run on node-a');
    });

    it('oom-killed traces the pod back to its Deployment', () => {
        const d = deployment('api', [container('api', sized)]);
        const pod = podOf(d, 0, { statuses: [{ name: 'api', restartCount: 1, lastState: { terminated: { reason: 'OOMKilled' } } }] });
        const result = run('oom-killed', snapshot({ deployments: [d], pods: [pod] }));
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]!.target.label).toBe('Deployment shop/api');
        expect(result.findings[0]!.detail).toContain('limit 256Mi');
    });

    it('reads image tags, including registries with a port', () => {
        expect(imageTag('nginx')).toEqual({ tag: '', digest: false });
        expect(imageTag('registry:5000/app')).toEqual({ tag: '', digest: false });
        expect(imageTag('registry:5000/app:1.2')).toEqual({ tag: '1.2', digest: false });
        expect(imageTag('app:latest@sha256:abc')).toEqual({ tag: 'latest', digest: true });
    });
});

describe('waste and nodes', () => {
    it('service-no-pods flags a selector that matches no running pod', () => {
        const d = deployment('api', [container('api', sized)]);
        const ok: Service = { metadata: { name: 'api', namespace: 'shop' }, spec: { selector: { app: 'api' } } };
        const lost: Service = { metadata: { name: 'old', namespace: 'shop' }, spec: { type: 'LoadBalancer', selector: { app: 'old' } } };
        const headless: Service = { metadata: { name: 'ext', namespace: 'shop' }, spec: {} };
        const result = run('service-no-pods', snapshot({ deployments: [d], pods: [podOf(d, 0)], services: [ok, lost, headless] }));
        expect(result.eligible).toBe(2);
        expect(result.findings.map((f) => f.target.name)).toEqual(['old']);
    });

    it('node-requests-high adds up the requests of the pods on each node', () => {
        const big = deployment('big', [container('big', { requests: { cpu: '1900m', memory: '1Gi' } })]);
        const pods = [podOf(big, 0, { node: 'node-a' }), podOf(big, 1, { node: 'node-b' }), podOf(big, 2, { node: 'node-a', phase: 'Succeeded' })];
        const result = run('node-requests-high', snapshot({ deployments: [big], pods, nodes: [node('node-a', '2'), node('node-b', '4')] }));
        expect(result.findings.map((f) => f.target.name)).toEqual(['node-a']);
        expect(result.findings[0]!.detail).toBe('CPU 95% requested');
    });
});

describe('rightsizing', () => {
    const d = deployment('api', [container('api', { requests: { cpu: '1', memory: '1Gi' }, limits: { memory: '1Gi' } })]);
    const pods = [podOf(d, 0), podOf(d, 1)];
    const key = (i: number): string => containerKey('shop', pods[i]!.metadata.name, 'api');

    it('is unavailable without usage data, and the observability tip says what to install', () => {
        const snap = snapshot({ deployments: [d], pods });
        expect(run('cpu-overprovisioned', snap).unavailable).toContain('Needs usage data');
        const tip = run('metrics-source', snap);
        expect(tip.findings[0]!.detail).toContain('Prometheus or VictoriaMetrics');
    });

    it('passes the observability tip with a day of history', () => {
        expect(run('metrics-source', snapshot({}), prometheus({})).findings).toEqual([]);
    });

    it('suggests a CPU request from a day of history, sized to the busiest pod, with a fix', () => {
        const usage = prometheus({ [key(0)]: { cpu: 0.05, memory: 700 * MI }, [key(1)]: { cpu: 0.1, memory: 600 * MI } });
        const result = run('cpu-overprovisioned', snapshot({ deployments: [d], pods }), usage);
        expect(result.eligible).toBe(1);
        const f = result.findings[0]!;
        expect(f.target.container).toBe('api');
        expect(f.fix).toMatchObject({ kind: 'Deployment', container: 'api', requests: { cpu: '130m' }, limits: {} });
        expect(f.saving!.cpu).toBeCloseTo((1 - 0.13) * 2);
    });

    it('names the tip from metrics-server but offers no fix: one reading does not size a request', () => {
        const usage: Usage = { ...prometheus({ [key(0)]: { cpu: 0.05, memory: 100 * MI } }), source: 'metrics-server' };
        const result = run('cpu-overprovisioned', snapshot({ deployments: [d], pods }), usage);
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]!.fix).toBeUndefined();
        expect(result.findings[0]!.detail).toContain('one reading');
    });

    it('memory-near-limit raises the limit, never leaving a request above it', () => {
        const usage = prometheus({ [key(0)]: { cpu: 0.9, memory: 980 * MI } });
        const result = run('memory-near-limit', snapshot({ deployments: [d], pods }), usage);
        expect(result.findings[0]!.fix).toMatchObject({ limits: { memory: '1280Mi' }, requests: {} });
    });

    it('raising a request above the limit raises the limit with it', () => {
        const tight = deployment('api', [container('api', { requests: { cpu: '100m', memory: '64Mi' }, limits: { cpu: '200m', memory: '1Gi' } })]);
        const p = podOf(tight, 0);
        const usage = prometheus({ [containerKey('shop', p.metadata.name, 'api')]: { cpu: 0.4 } });
        const f = run('cpu-underprovisioned', snapshot({ deployments: [tight], pods: [p] }), usage).findings[0]!;
        expect(f.fix).toMatchObject({ requests: { cpu: '520m' }, limits: { cpu: '520m' } });
        expect(f.detail).toContain('limit throttles it');
    });
});
