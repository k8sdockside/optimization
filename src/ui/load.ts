// Reading the cluster through the bridge, and writing back to it.

import { emptySnapshot, SNAPSHOT_KINDS, type Snapshot } from '../model/cluster';
import { APP_KIND } from '../model/inventory';
import type { ConfigMap, KubeObject, PodMetrics } from '../model/kube';
import { resourcesPatch } from '../model/patch';
import type { ResourceFix } from '../model/rules';
import { CONFIGMAP, DEFAULT_SETTINGS, decodeSettings, encodeSettings, type Settings } from '../model/settings';
import { noUsage, usageFromCharts, usageFromPodMetrics, type Usage } from '../model/usage';
import { message, sdk } from './page';

/** How far back the usage charts are asked for. Their queries already look a day back; this is only the window of the answer. */
const USAGE_MINUTES = 5;

/**
 * Every kind the rules read, in parallel. A kind that cannot be read -- not
 * allowed, not served -- is recorded as missing and read as empty, so the
 * rules that need it say so and the rest carry on.
 */
export async function loadSnapshot(): Promise<Snapshot> {
    const snap = emptySnapshot();
    const lists = snap as unknown as Record<string, KubeObject[]>;
    await Promise.all(
        SNAPSHOT_KINDS.map(async (kind) => {
            try {
                lists[kind] = await sdk.list({ kind, namespace: '' });
            } catch (err) {
                snap.missing.set(kind, message(err));
            }
        }),
    );
    return snap;
}

/**
 * Usage from the best source there is: Prometheus or VictoriaMetrics, then
 * metrics-server, then none. Never rejects -- no monitoring is an ordinary
 * cluster, and the reason goes into the usage for the page to turn into a tip.
 */
export async function loadUsage(): Promise<Usage> {
    let note: string;
    try {
        const outcome = usageFromCharts(await sdk.charts({ minutes: USAGE_MINUTES }));
        if (outcome.usage) return outcome.usage;
        note = outcome.problem;
    } catch (err) {
        note = `could not ask for charts (${message(err)})`;
    }
    try {
        const items = await sdk.list<PodMetrics>({ kind: 'crd:pods.metrics.k8s.io', namespace: '' });
        return usageFromPodMetrics(items, note);
    } catch (err) {
        return noUsage(`${note}; ${metricsServerProblem(err)}`);
    }
}

function metricsServerProblem(err: unknown): string {
    const text = message(err);
    if (/not served|could not find the requested resource|no matches for|not found/i.test(text)) return 'metrics-server is not installed';
    if (/service unavailable|503/i.test(text)) return 'metrics-server is installed but not answering';
    return `metrics-server did not answer (${text})`;
}

export interface Saved {
    settings: Settings;
    /** The saved choices as text, to tell unsaved changes by. */
    text: string;
    /** Whether the ConfigMap exists, so saving knows to create or patch it. */
    exists: boolean;
    /** Why the saved choices could not be read; '' when they could, or there are none. */
    error: string;
}

export async function loadSaved(): Promise<Saved> {
    try {
        const cm = await sdk.get<ConfigMap>({ kind: 'configmaps', namespace: CONFIGMAP.namespace, name: CONFIGMAP.name });
        const settings = decodeSettings(cm.data?.[CONFIGMAP.key]);
        return { settings, text: encodeSettings(settings), exists: true, error: '' };
    } catch (err) {
        const text = message(err);
        const none = /not found/i.test(text);
        return { settings: DEFAULT_SETTINGS, text: encodeSettings(DEFAULT_SETTINGS), exists: false, error: none ? '' : text };
    }
}

/** Writes the choices to the ConfigMap -- creating it the first time. The user confirms either way. */
export async function saveSettings(settings: Settings, exists: boolean): Promise<void> {
    const data = { [CONFIGMAP.key]: encodeSettings(settings) };
    if (exists) {
        await sdk.patch({ kind: 'configmaps', namespace: CONFIGMAP.namespace, name: CONFIGMAP.name, patch: { data } });
        return;
    }
    await sdk.create({
        kind: 'configmaps',
        namespace: CONFIGMAP.namespace,
        object: {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: CONFIGMAP.name, labels: { 'app.kubernetes.io/managed-by': 'k8sdockside-optimization' } },
            data,
        },
    });
}

/** Applies a rightsizing fix to the workload as it is now. The user sees the patch and confirms. */
export async function applyFix(fix: ResourceFix): Promise<void> {
    const kind = APP_KIND[fix.kind]!;
    const obj = await sdk.get({ kind, namespace: fix.namespace, name: fix.name });
    await sdk.patch({ kind, namespace: fix.namespace, name: fix.name, patch: resourcesPatch(obj, fix) });
}
