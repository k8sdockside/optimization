// Everything the rules look at, read once: the lists the bridge returned,
// which of them could not be read, the usage readings, and which namespaces
// are in scope.

import { buildInventory, type Inventory } from './inventory';
import type { CronJob, Hpa, Job, KubeObject, Node, Pdb, Pod, Pv, Pvc, Service, Workload } from './kube';
import type { Usage } from './usage';

export interface Snapshot {
    pods: Pod[];
    deployments: Workload[];
    statefulsets: Workload[];
    daemonsets: Workload[];
    cronjobs: CronJob[];
    jobs: Job[];
    nodes: Node[];
    namespaces: KubeObject[];
    services: Service[];
    horizontalpodautoscalers: Hpa[];
    poddisruptionbudgets: Pdb[];
    persistentvolumeclaims: Pvc[];
    persistentvolumes: Pv[];
    limitranges: KubeObject[];
    resourcequotas: KubeObject[];
    /** App kind -> why it could not be read. A kind in here reads as an empty list above. */
    missing: Map<string, string>;
}

/** The kinds a snapshot is made of, as the bridge names them. */
export const SNAPSHOT_KINDS = [
    'pods',
    'deployments',
    'statefulsets',
    'daemonsets',
    'cronjobs',
    'jobs',
    'nodes',
    'namespaces',
    'services',
    'horizontalpodautoscalers',
    'poddisruptionbudgets',
    'persistentvolumeclaims',
    'persistentvolumes',
    'limitranges',
    'resourcequotas',
] as const satisfies readonly (keyof Snapshot)[];

export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number];

export function emptySnapshot(): Snapshot {
    const snap = { missing: new Map<string, string>() } as Snapshot;
    for (const kind of SNAPSHOT_KINDS) (snap[kind] as KubeObject[]) = [];
    return snap;
}

export interface Cluster extends Snapshot {
    inventory: Inventory;
    usage: Usage;
    now: number;
    /** Whether a namespace is checked. Cluster-scoped objects always are. */
    inScope(namespace: string): boolean;
    /** The annotations of an object by app kind, namespace and name; for the ignore annotation. */
    annotationsOf(kind: string, namespace: string, name: string): Record<string, string> | undefined;
}

/** kube-system, kube-public, kube-node-lease and anything ending in -system. */
export function isSystemNamespace(namespace: string): boolean {
    return namespace.startsWith('kube-') || namespace.endsWith('-system');
}

export function buildCluster(snap: Snapshot, usage: Usage, opts: { system: boolean; now?: number }): Cluster {
    const inventory = buildInventory(snap);
    const objects = new Map<string, KubeObject>();
    for (const kind of SNAPSHOT_KINDS) {
        for (const obj of snap[kind] as KubeObject[]) {
            objects.set(`${kind}/${obj.metadata.namespace ?? ''}/${obj.metadata.name}`, obj);
        }
    }
    return {
        ...snap,
        inventory,
        usage,
        now: opts.now ?? Date.now(),
        inScope: (namespace) => !namespace || opts.system || !isSystemNamespace(namespace),
        annotationsOf: (kind, namespace, name) => objects.get(`${kind}/${namespace}/${name}`)?.metadata.annotations,
    };
}
