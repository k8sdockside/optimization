// What containers actually use, from the best source the cluster has.
//
//   1. Prometheus or VictoriaMetrics -- a day of history: the 95th percentile
//      of CPU and the peak of memory. What a request should be sized against.
//   2. metrics-server -- one reading, right now. Enough to spot a container
//      asking for ten times what it uses, not enough to size one.
//   3. Neither -- the usage rules say what they would need, and the rest of
//      the rules work as before.
//
// None of the three is an error. A cluster without monitoring is an ordinary
// cluster; the advisor turns that into a tip.

import type { PodMetrics } from './kube';
import { parseQuantity } from './quantity';

export const CPU_CHART = 'usage-cpu-p95';
export const MEMORY_CHART = 'usage-memory-peak';

export type UsageSource = 'prometheus' | 'metrics-server' | 'none';

export interface ContainerUsage {
    /** Cores: the day's 95th percentile, or the reading now. NaN when unknown. */
    cpu: number;
    /** Bytes: the day's peak working set, or the reading now. NaN when unknown. */
    memory: number;
}

export interface Usage {
    source: UsageSource;
    /** Where the readings came from, for a person. */
    where: string;
    /** "namespace/pod/container" -> usage. */
    byContainer: Map<string, ContainerUsage>;
    /** Why the best source was not used; '' when it was. */
    note: string;
}

export function containerKey(namespace: string, pod: string, container: string): string {
    return `${namespace}/${pod}/${container}`;
}

export function noUsage(note: string): Usage {
    return { source: 'none', where: '', byContainer: new Map(), note };
}

export type ChartsOutcome = { usage: Usage; problem?: undefined } | { usage?: undefined; problem: string };

/** The plugin's two usage charts, read as numbers. `problem` says why they could not be. */
export function usageFromCharts(panel: K8sDockside.ChartsPanel): ChartsOutcome {
    const source = panel.source;
    if (!source.available) {
        return { problem: source.error ? `could not look for Prometheus: ${source.error}` : 'no Prometheus or VictoriaMetrics was found in this cluster' };
    }
    const cpu = panel.charts.find((c) => c.id === CPU_CHART);
    const memory = panel.charts.find((c) => c.id === MEMORY_CHART);
    const where = source.describe;
    if ((!cpu || cpu.error) && (!memory || memory.error)) {
        return { problem: `${where} did not answer: ${cpu?.error || memory?.error || 'no charts came back'}` };
    }

    const byContainer = new Map<string, ContainerUsage>();
    const read = (chart: K8sDockside.Chart | undefined, field: keyof ContainerUsage): void => {
        for (const series of chart?.series ?? []) {
            const value = latest(series.points);
            if (!series.name || !Number.isFinite(value)) continue;
            const entry = byContainer.get(series.name) ?? { cpu: NaN, memory: NaN };
            entry[field] = value;
            byContainer.set(series.name, entry);
        }
    };
    read(cpu, 'cpu');
    read(memory, 'memory');

    if (!byContainer.size) {
        return { problem: `${where} answered, but has no per-container metrics (cAdvisor's container_cpu_usage_seconds_total and container_memory_working_set_bytes are not scraped)` };
    }
    const partial = cpu?.error ? `CPU history failed (${cpu.error}); ` : memory?.error ? `memory history failed (${memory.error}); ` : '';
    return { usage: { source: 'prometheus', where, byContainer, note: partial ? partial + 'the rest is from ' + where : '' } };
}

function latest(points: K8sDockside.ChartPoint[]): number {
    for (let i = points.length - 1; i >= 0; i--) {
        const v = points[i]!.v;
        if (Number.isFinite(v)) return v;
    }
    return NaN;
}

/** metrics-server's PodMetrics list, as one reading per container. */
export function usageFromPodMetrics(items: PodMetrics[], note: string): Usage {
    const byContainer = new Map<string, ContainerUsage>();
    for (const item of items) {
        const namespace = item.metadata.namespace ?? '';
        for (const c of item.containers ?? []) {
            byContainer.set(containerKey(namespace, item.metadata.name, c.name), {
                cpu: parseQuantity(c.usage?.cpu),
                memory: parseQuantity(c.usage?.memory),
            });
        }
    }
    return { source: 'metrics-server', where: 'metrics-server', byContainer, note };
}
