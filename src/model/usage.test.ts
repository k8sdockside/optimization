import { describe, expect, it } from 'vitest';
import { CPU_CHART, MEMORY_CHART, usageFromCharts, usageFromPodMetrics } from './usage';

function panel(opts: { available?: boolean; error?: string; charts?: { id: string; error?: string; series: { name: string; values: number[] }[] }[] }): K8sDockside.ChartsPanel {
    return {
        attached: true,
        range: 5,
        source: {
            endpoint: { namespace: 'monitoring', service: 'prometheus-operated', port: 'web', url: '', source: 'discovered' },
            configured: '',
            available: opts.available ?? true,
            error: opts.error ?? '',
            describe: 'monitoring/prometheus-operated:web',
        },
        charts: (opts.charts ?? []).map((c) => ({
            id: c.id,
            label: c.id,
            unit: '',
            description: '',
            error: c.error ?? '',
            series: c.series.map((s) => ({ name: s.name, points: s.values.map((v, i) => ({ t: i * 15, v })) })),
        })),
    } as unknown as K8sDockside.ChartsPanel;
}

describe('usageFromCharts', () => {
    it('says no Prometheus or VictoriaMetrics was found, as a reason rather than an error', () => {
        const out = usageFromCharts(panel({ available: false }));
        expect(out.usage).toBeUndefined();
        expect(out.problem).toBe('no Prometheus or VictoriaMetrics was found in this cluster');
    });

    it('reads the last value of every series, keyed namespace/pod/container', () => {
        const out = usageFromCharts(
            panel({
                charts: [
                    { id: CPU_CHART, series: [{ name: 'shop/api-1/api', values: [0.2, NaN, 0.3] }] },
                    { id: MEMORY_CHART, series: [{ name: 'shop/api-1/api', values: [100, 200] }] },
                ],
            }),
        );
        expect(out.usage?.source).toBe('prometheus');
        expect(out.usage?.byContainer.get('shop/api-1/api')).toEqual({ cpu: 0.3, memory: 200 });
        expect(out.usage?.note).toBe('');
    });

    it('explains a Prometheus without cAdvisor metrics', () => {
        const out = usageFromCharts(panel({ charts: [{ id: CPU_CHART, series: [] }, { id: MEMORY_CHART, series: [] }] }));
        expect(out.problem).toContain('cAdvisor');
    });

    it('keeps what answered when one of the two queries failed', () => {
        const out = usageFromCharts(
            panel({ charts: [{ id: CPU_CHART, error: 'query timed out', series: [] }, { id: MEMORY_CHART, series: [{ name: 'shop/a/a', values: [5] }] }] }),
        );
        expect(out.usage?.byContainer.get('shop/a/a')).toEqual({ cpu: NaN, memory: 5 });
        expect(out.usage?.note).toContain('query timed out');
    });
});

describe('usageFromPodMetrics', () => {
    it('reads metrics-server nanocores and KiB', () => {
        const u = usageFromPodMetrics([{ metadata: { name: 'api-1', namespace: 'shop' }, containers: [{ name: 'api', usage: { cpu: '12500000n', memory: '20480Ki' } }] }], 'no Prometheus');
        expect(u.source).toBe('metrics-server');
        expect(u.byContainer.get('shop/api-1/api')!.cpu).toBeCloseTo(0.0125);
        expect(u.byContainer.get('shop/api-1/api')!.memory).toBe(20 * 2 ** 20);
        expect(u.note).toBe('no Prometheus');
    });
});
