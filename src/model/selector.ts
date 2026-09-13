// Label selectors, as a PodDisruptionBudget or a Service uses them.

import type { LabelSelector } from './kube';

/**
 * Whether `labels` satisfy a set-based selector. An empty selector matches
 * everything, as the API server reads it for a PodDisruptionBudget.
 */
export function matches(selector: LabelSelector | undefined, labels: Record<string, string> | undefined): boolean {
    if (!selector) return false;
    const have = labels ?? {};
    for (const [key, value] of Object.entries(selector.matchLabels ?? {})) {
        if (have[key] !== value) return false;
    }
    for (const req of selector.matchExpressions ?? []) {
        const present = Object.prototype.hasOwnProperty.call(have, req.key);
        const value = have[req.key];
        switch (req.operator) {
            case 'In':
                if (!present || !(req.values ?? []).includes(value ?? '')) return false;
                break;
            case 'NotIn':
                if (present && (req.values ?? []).includes(value ?? '')) return false;
                break;
            case 'Exists':
                if (!present) return false;
                break;
            case 'DoesNotExist':
                if (present) return false;
                break;
            default:
                return false;
        }
    }
    return true;
}

/** Whether `labels` carry every pair of a Service's plain selector. An empty one matches nothing. */
export function matchesMap(selector: Record<string, string> | undefined, labels: Record<string, string> | undefined): boolean {
    const entries = Object.entries(selector ?? {});
    if (!entries.length) return false;
    const have = labels ?? {};
    return entries.every(([key, value]) => have[key] === value);
}
