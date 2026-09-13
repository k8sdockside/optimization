// Requests, limits and usage of one workload's containers, and what they
// should be. Shared by the rightsizing rules and the Rightsizing view, so the
// two can never disagree about a container.

import { active, type WorkloadInfo } from './inventory';
import type { Container } from './kube';
import { parseQuantity } from './quantity';
import { containerKey, type Usage } from './usage';

export const MI = 2 ** 20;

/** Headroom on top of observed use: a request sized to the 95th percentile plus 30%. */
export const HEADROOM = 1.3;
const MIN_CPU = 0.01;
const MIN_MEMORY = 32 * MI;

/** Below these a request is too small for rightsizing to be worth a tip. */
export const CPU_FLOOR = 0.1;
export const MEMORY_FLOOR = 128 * MI;

/**
 * The containers as admitted: a running pod's, when there is one, since a
 * LimitRange may have filled in requests the template does not have. The
 * template's otherwise.
 */
export function effectiveContainers(w: WorkloadInfo): Container[] {
    const pod = w.pods.find(active);
    return pod?.spec?.containers ?? w.template.spec?.containers ?? [];
}

export function templateContainers(w: WorkloadInfo): Container[] {
    return w.template.spec?.containers ?? [];
}

export type Resource = 'cpu' | 'memory';

/** A container's request, falling back to its limit the way the API server does. NaN when it has neither. */
export function requestOf(c: Container, resource: Resource): number {
    const r = parseQuantity(c.resources?.requests?.[resource]);
    return Number.isFinite(r) ? r : parseQuantity(c.resources?.limits?.[resource]);
}

export function limitOf(c: Container, resource: Resource): number {
    return parseQuantity(c.resources?.limits?.[resource]);
}

export interface Observed {
    /** The highest of the pods' readings. NaN when none had one. */
    cpu: number;
    memory: number;
    /** How many pods had a reading. */
    pods: number;
}

/**
 * Usage by container name across a workload's running pods, taking the
 * highest pod: sizing to the busiest replica is the safe direction.
 */
export function observed(w: WorkloadInfo, usage: Usage): Map<string, Observed> {
    const out = new Map<string, Observed>();
    for (const pod of w.pods) {
        if (!active(pod)) continue;
        for (const c of pod.spec?.containers ?? []) {
            const u = usage.byContainer.get(containerKey(w.namespace, pod.metadata.name, c.name));
            if (!u) continue;
            const entry = out.get(c.name) ?? { cpu: NaN, memory: NaN, pods: 0 };
            entry.cpu = higher(entry.cpu, u.cpu);
            entry.memory = higher(entry.memory, u.memory);
            entry.pods++;
            out.set(c.name, entry);
        }
    }
    return out;
}

function higher(a: number, b: number): number {
    if (!Number.isFinite(a)) return b;
    if (!Number.isFinite(b)) return a;
    return Math.max(a, b);
}

export type Verdict = 'over' | 'under' | 'near-limit' | 'ok' | 'unknown';

/**
 * How a container's CPU request compares with its use. A day of history
 * (`history`) earns a tighter threshold than one reading of right now.
 */
export function cpuVerdict(request: number, used: number, history: boolean): Verdict {
    if (!Number.isFinite(used) || !Number.isFinite(request)) return 'unknown';
    if (request >= CPU_FLOOR && used * (history ? 3 : 5) < request) return 'over';
    if (request > 0 && used > request * (history ? 1.5 : 2)) return 'under';
    return 'ok';
}

export function memoryVerdict(request: number, limit: number, used: number, history: boolean): Verdict {
    if (!Number.isFinite(used)) return 'unknown';
    if (Number.isFinite(limit) && used >= 0.9 * limit) return 'near-limit';
    if (!Number.isFinite(request)) return 'unknown';
    if (request >= MEMORY_FLOOR && used * (history ? 2 : 3) < request) return 'over';
    if (request > 0 && used > request * (history ? 1.5 : 2)) return 'under';
    return 'ok';
}

export function recommendCpu(used: number): number {
    return Math.max(used * HEADROOM, MIN_CPU);
}

export function recommendMemory(used: number): number {
    return Math.max(used * HEADROOM, MIN_MEMORY);
}
