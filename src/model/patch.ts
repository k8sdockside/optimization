// A rightsizing fix as a JSON merge patch.
//
// A merge patch replaces a list whole, so the patch carries the workload's
// entire containers list -- read live, just before -- with only the one
// container's resources changed. Anything else in the list goes back exactly
// as it was.

import type { Container, KubeObject } from './kube';
import type { ResourceFix } from './rules';

export function resourcesPatch(obj: KubeObject, fix: ResourceFix): object {
    const podSpec = fix.kind === 'CronJob' ? dig(obj, ['spec', 'jobTemplate', 'spec', 'template', 'spec']) : dig(obj, ['spec', 'template', 'spec']);
    const containers = (podSpec?.containers ?? []) as Container[];
    if (!containers.some((c) => c.name === fix.container)) {
        throw new Error(`${fix.kind} ${fix.namespace}/${fix.name} has no container called ${fix.container} any more`);
    }
    const next = containers.map((c) => {
        if (c.name !== fix.container) return c;
        const resources = { ...(c.resources ?? {}) };
        if (Object.keys(fix.requests).length) resources.requests = { ...(resources.requests ?? {}), ...fix.requests };
        if (Object.keys(fix.limits).length) resources.limits = { ...(resources.limits ?? {}), ...fix.limits };
        return { ...c, resources };
    });
    const template = { spec: { containers: next } };
    return fix.kind === 'CronJob' ? { spec: { jobTemplate: { spec: { template } } } } : { spec: { template } };
}

function dig(obj: unknown, path: string[]): { containers?: unknown } | undefined {
    let at: unknown = obj;
    for (const key of path) {
        if (!at || typeof at !== 'object') return undefined;
        at = (at as Record<string, unknown>)[key];
    }
    return at && typeof at === 'object' ? (at as { containers?: unknown }) : undefined;
}
