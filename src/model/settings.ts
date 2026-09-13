// What the user has chosen: which rules count, which findings they accept,
// and whether system namespaces are looked at.
//
// A choice is live the moment it is made (and kept in the page's address, so
// it survives switching tabs). Saving writes it to a ConfigMap in the cluster,
// where it outlives the app and is shared with everyone looking at the same
// cluster. An object can also opt out on its own, with an annotation -- the
// way to keep an exception in Git beside the workload it is about.

export interface Settings {
    /** Rule id -> on or off, only where it differs from the rule's default. */
    rules: Record<string, boolean>;
    /** Keys of findings the user accepts. */
    accepted: string[];
    /** Whether kube-* and *-system namespaces are checked too. */
    system: boolean;
}

export const DEFAULT_SETTINGS: Settings = { rules: {}, accepted: [], system: false };

export const CONFIGMAP = { namespace: 'default', name: 'k8sdockside-optimization', key: 'settings.json' } as const;

/** `optimization.k8sdockside.io/ignore: "single-replica,pdb-missing"`, or `"*"` for every rule. */
export const IGNORE_ANNOTATION = 'optimization.k8sdockside.io/ignore';

export function ignoredBy(annotations: Record<string, string> | undefined, ruleId: string): boolean {
    const value = annotations?.[IGNORE_ANNOTATION];
    if (!value) return false;
    return value.split(',').some((part) => {
        const id = part.trim();
        return id === '*' || id === ruleId;
    });
}

export function ruleEnabled(settings: Settings, rule: { id: string; defaultOn: boolean }): boolean {
    return settings.rules[rule.id] ?? rule.defaultOn;
}

export function withRule(settings: Settings, rule: { id: string; defaultOn: boolean }, on: boolean): Settings {
    const rules = { ...settings.rules };
    if (on === rule.defaultOn) delete rules[rule.id];
    else rules[rule.id] = on;
    return { ...settings, rules };
}

export function withAccepted(settings: Settings, key: string, accept: boolean): Settings {
    const rest = settings.accepted.filter((k) => k !== key);
    return { ...settings, accepted: accept ? [...rest, key].sort() : rest };
}

/** Stable JSON: the same choices always write the same text, so "unsaved" is a string comparison. */
export function encodeSettings(settings: Settings): string {
    const rules: Record<string, boolean> = {};
    for (const id of Object.keys(settings.rules).sort()) rules[id] = settings.rules[id]!;
    return JSON.stringify({ rules, accepted: [...new Set(settings.accepted)].sort(), system: settings.system });
}

/** Reads settings back, keeping what makes sense of text somebody may have edited by hand. */
export function decodeSettings(text: string | undefined | null): Settings {
    if (!text) return DEFAULT_SETTINGS;
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return DEFAULT_SETTINGS;
    }
    if (!raw || typeof raw !== 'object') return DEFAULT_SETTINGS;
    const obj = raw as Record<string, unknown>;
    const rules: Record<string, boolean> = {};
    if (obj.rules && typeof obj.rules === 'object') {
        for (const [id, on] of Object.entries(obj.rules as Record<string, unknown>)) {
            if (typeof on === 'boolean') rules[id] = on;
        }
    }
    const accepted = Array.isArray(obj.accepted) ? obj.accepted.filter((k): k is string => typeof k === 'string') : [];
    return { rules, accepted, system: obj.system === true };
}
