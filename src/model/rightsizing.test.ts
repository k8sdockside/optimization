import { describe, expect, it } from 'vitest';
import { buildCluster } from './cluster';
import { container, deployment, MI, NOW, podOf, snapshot } from './fixtures';
import type { Workload } from './kube';
import { sizingRows } from './rightsizing';
import { containerKey, type Usage } from './usage';

const GI = 2 ** 30;

function rows(workloads: { d: Workload; pods: number; cpu: number; memory: number }[]) {
    const pods = workloads.flatMap(({ d, pods }) => Array.from({ length: pods }, (_, i) => podOf(d, i)));
    const byContainer = new Map<string, { cpu: number; memory: number }>();
    for (const { d, cpu, memory } of workloads) {
        for (const p of pods.filter((p) => p.metadata.name.startsWith(d.metadata.name + '-'))) {
            byContainer.set(containerKey('shop', p.metadata.name, d.metadata.name), { cpu, memory });
        }
    }
    const usage: Usage = { source: 'prometheus', where: 'prometheus', byContainer, note: '' };
    return sizingRows(buildCluster(snapshot({ deployments: workloads.map((w) => w.d), pods }), usage, { system: false, now: NOW }));
}

const sized = (name: string, cpu: string, memory: string): Workload =>
    deployment(name, [container(name, { requests: { cpu, memory }, limits: { memory: '8Gi' } })]);

describe('sizingRows', () => {
    it('puts the biggest change first, summed over the pods', () => {
        const list = rows([
            // 1 core asked, 0.1 used, one pod: frees 0.87 core.
            { d: sized('small', '1', '256Mi'), pods: 1, cpu: 0.1, memory: 200 * MI },
            // The same gap on five pods: frees 4.35 cores.
            { d: sized('wide', '1', '256Mi'), pods: 5, cpu: 0.1, memory: 200 * MI },
            // Sized about right: no change.
            { d: sized('fine', '100m', '256Mi'), pods: 3, cpu: 0.09, memory: 200 * MI },
        ]);
        expect(list.map((r) => r.s.w.name)).toEqual(['wide', 'small', 'fine']);
        expect(list[0]!.change.cpu).toBeCloseTo(-(1 - 0.13) * 5);
        expect(list[0]!.change.pods).toBe(5);
        expect(list[2]!.impact).toBe(0);
    });

    it('weighs memory against CPU at four GiB to a core', () => {
        const list = rows([
            // Frees about 0.87 core.
            { d: sized('cpu', '1', '256Mi'), pods: 1, cpu: 0.1, memory: 200 * MI },
            // Frees about 6.7 GiB of memory: worth about 1.7 cores.
            { d: sized('memory', '100m', '8Gi'), pods: 1, cpu: 0.09, memory: GI },
        ]);
        expect(list.map((r) => r.s.w.name)).toEqual(['memory', 'cpu']);
        expect(list[0]!.change.memory).toBeCloseTo(-(8 * GI - 1.3 * GI));
        expect(list[0]!.impact).toBeCloseTo((8 - 1.3) / 4);
    });

    it('counts asking for more as change too', () => {
        const list = rows([
            { d: sized('starved', '100m', '256Mi'), pods: 2, cpu: 1, memory: 200 * MI },
            { d: sized('small', '1', '256Mi'), pods: 1, cpu: 0.1, memory: 200 * MI },
        ]);
        expect(list[0]!.s.w.name).toBe('starved');
        expect(list[0]!.change.cpu).toBeCloseTo((1.3 - 0.1) * 2);
    });
});
