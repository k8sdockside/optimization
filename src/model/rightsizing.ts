// One row per workload container with usage readings: what it asks for, what
// it uses, and what it should ask for. The Rightsizing view's table, biggest
// change first.

import type { Cluster } from './cluster';
import { cpuVerdict, limitOf, memoryVerdict, recommendCpu, recommendMemory, requestOf, type Resource, type Verdict } from './resources';
import { resourceFix, sized, type ResourceFix, type Sized } from './rules';

/**
 * How many GiB of memory weigh as much as one core when rows are ranked. Four
 * is the shape of a general-purpose node -- 4 cores and 16 GiB, 8 and 32 --
 * so a change of one core and a change of 4 GiB take about the same share of
 * one.
 */
export const GIB_PER_CORE = 4;
const GIB = 2 ** 30;

export interface Sizing {
    request: number;
    limit: number;
    used: number;
    suggested: number;
    verdict: Verdict;
}

/**
 * What following the row would change, summed over the pods measured: cores
 * and bytes, negative where it frees requests, positive where it asks for
 * more. 0 for what it leaves alone.
 */
export interface Change {
    cpu: number;
    memory: number;
    memoryLimit: number;
    pods: number;
}

export interface SizingRow {
    s: Sized;
    key: string;
    cpu: Sizing;
    memory: Sizing;
    change: Change;
    /** The size of the change in one number -- cores, with memory at GIB_PER_CORE -- to rank rows by. */
    impact: number;
    /** Set only with a day of history: one reading is not enough to write a request from. */
    fix?: ResourceFix;
}

export function sizingRows(c: Cluster): SizingRow[] {
    const history = c.usage.source === 'prometheus';
    return sized(c)
        .map((s): SizingRow => {
            const cpu: Sizing = {
                request: requestOf(s.container, 'cpu'),
                limit: limitOf(s.container, 'cpu'),
                used: s.seen.cpu,
                suggested: Number.isFinite(s.seen.cpu) ? recommendCpu(s.seen.cpu) : NaN,
                verdict: 'unknown',
            };
            cpu.verdict = cpuVerdict(cpu.request, cpu.used, history);
            const memory: Sizing = {
                request: requestOf(s.container, 'memory'),
                limit: limitOf(s.container, 'memory'),
                used: s.seen.memory,
                suggested: Number.isFinite(s.seen.memory) ? recommendMemory(s.seen.memory) : NaN,
                verdict: 'unknown',
            };
            memory.verdict = memoryVerdict(memory.request, memory.limit, memory.used, history);

            const requests: Partial<Record<Resource, number>> = {};
            const limits: Partial<Record<Resource, number>> = {};
            for (const [resource, sizing] of [
                ['cpu', cpu],
                ['memory', memory],
            ] as const) {
                const off = sizing.verdict === 'over' || sizing.verdict === 'under' || !Number.isFinite(sizing.request);
                if (off && Number.isFinite(sizing.suggested)) requests[resource] = sizing.suggested;
            }
            if (memory.verdict === 'near-limit') limits.memory = memory.suggested;

            const pods = Math.max(1, s.seen.pods);
            const from = (n: number): number => (Number.isFinite(n) ? n : 0);
            const change: Change = {
                cpu: requests.cpu !== undefined ? (requests.cpu - from(cpu.request)) * pods : 0,
                memory: requests.memory !== undefined ? (requests.memory - from(memory.request)) * pods : 0,
                memoryLimit: limits.memory !== undefined && Number.isFinite(memory.limit) ? (limits.memory - memory.limit) * pods : 0,
                pods,
            };
            const impact = Math.abs(change.cpu) + (Math.abs(change.memory) + Math.abs(change.memoryLimit)) / GIB / GIB_PER_CORE;

            const anything = Object.keys(requests).length || Object.keys(limits).length;
            return {
                s,
                key: `${s.w.key}/${s.container.name}`,
                cpu,
                memory,
                change,
                impact,
                fix: history && anything ? resourceFix(s, { requests, limits }) : undefined,
            };
        })
        .sort((a, b) => b.impact - a.impact || a.key.localeCompare(b.key));
}
