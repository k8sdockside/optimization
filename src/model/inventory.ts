// The workloads in the cluster, each with the pods it runs.
//
// Most rules are about what a workload *declares* -- its pod template -- and a
// few about what its pods are *doing*: restarting, being killed for memory,
// using less than they ask for. Both need a pod traced back to the workload
// that owns it, which is what this does.
//
// A pod's owner is a ReplicaSet for a Deployment. The ReplicaSet is named
// after the Deployment plus the pod's `pod-template-hash` label, so the
// Deployment is found from the pod alone, without reading ReplicaSets.

import { controllerOf, type CronJob, type Job, type KubeObject, type Pod, type PodTemplate, type Workload } from './kube';

export type WorkloadKind = 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'CronJob' | 'Job';

/** The app's name for each Kubernetes kind the rules point at. */
export const APP_KIND: Readonly<Record<string, string>> = {
    Deployment: 'deployments',
    StatefulSet: 'statefulsets',
    DaemonSet: 'daemonsets',
    CronJob: 'cronjobs',
    Job: 'jobs',
    Pod: 'pods',
    Node: 'nodes',
    Namespace: 'namespaces',
    Service: 'services',
    HorizontalPodAutoscaler: 'horizontalpodautoscalers',
    PodDisruptionBudget: 'poddisruptionbudgets',
    PersistentVolumeClaim: 'persistentvolumeclaims',
    PersistentVolume: 'persistentvolumes',
};

export interface WorkloadInfo {
    kind: WorkloadKind;
    namespace: string;
    name: string;
    key: string;
    obj: KubeObject;
    template: PodTemplate;
    /** Desired replicas of a Deployment or StatefulSet; null for the kinds that have none. */
    replicas: number | null;
    pods: Pod[];
}

export function workloadKey(kind: string, namespace: string, name: string): string {
    return `${kind}/${namespace}/${name}`;
}

export interface InventoryInput {
    deployments: Workload[];
    statefulsets: Workload[];
    daemonsets: Workload[];
    cronjobs: CronJob[];
    jobs: Job[];
    pods: Pod[];
}

export interface Inventory {
    workloads: WorkloadInfo[];
    byKey: Map<string, WorkloadInfo>;
    /** "namespace/pod" -> the workload that owns the pod. */
    ownerOfPod: Map<string, WorkloadInfo>;
}

export function buildInventory(input: InventoryInput): Inventory {
    const workloads: WorkloadInfo[] = [];
    const byKey = new Map<string, WorkloadInfo>();
    const put = (kind: WorkloadKind, obj: KubeObject, template: PodTemplate | undefined, replicas: number | null): void => {
        const namespace = obj.metadata.namespace ?? '';
        const name = obj.metadata.name;
        const info: WorkloadInfo = { kind, namespace, name, key: workloadKey(kind, namespace, name), obj, template: template ?? {}, replicas, pods: [] };
        workloads.push(info);
        byKey.set(info.key, info);
    };

    for (const d of input.deployments) put('Deployment', d, d.spec?.template, d.spec?.replicas ?? 1);
    for (const s of input.statefulsets) put('StatefulSet', s, s.spec?.template, s.spec?.replicas ?? 1);
    for (const d of input.daemonsets) put('DaemonSet', d, d.spec?.template, null);
    for (const c of input.cronjobs) put('CronJob', c, c.spec?.jobTemplate?.spec?.template, null);

    // A Job a CronJob made belongs to the CronJob; only the others are workloads of their own.
    const cronOfJob = new Map<string, string>();
    for (const j of input.jobs) {
        const owner = controllerOf(j);
        if (owner?.kind === 'CronJob') cronOfJob.set(`${j.metadata.namespace ?? ''}/${j.metadata.name}`, owner.name);
        else put('Job', j, j.spec?.template, null);
    }

    const ownerOfPod = new Map<string, WorkloadInfo>();
    for (const pod of input.pods) {
        const namespace = pod.metadata.namespace ?? '';
        const key = ownerKey(pod, namespace, cronOfJob);
        const info = key ? byKey.get(key) : undefined;
        if (!info) continue;
        info.pods.push(pod);
        ownerOfPod.set(`${namespace}/${pod.metadata.name}`, info);
    }

    return { workloads, byKey, ownerOfPod };
}

function ownerKey(pod: Pod, namespace: string, cronOfJob: Map<string, string>): string | null {
    const owner = controllerOf(pod);
    if (!owner) return null;
    switch (owner.kind) {
        case 'ReplicaSet': {
            const hash = pod.metadata.labels?.['pod-template-hash'];
            if (!hash || !owner.name.endsWith('-' + hash)) return null;
            return workloadKey('Deployment', namespace, owner.name.slice(0, -(hash.length + 1)));
        }
        case 'StatefulSet':
        case 'DaemonSet':
            return workloadKey(owner.kind, namespace, owner.name);
        case 'Job': {
            const cron = cronOfJob.get(`${namespace}/${owner.name}`);
            return cron ? workloadKey('CronJob', namespace, cron) : workloadKey('Job', namespace, owner.name);
        }
        default:
            return null;
    }
}

/** Whether a pod still holds its resources on a node. */
export function active(pod: Pod): boolean {
    const phase = pod.status?.phase;
    return phase !== 'Succeeded' && phase !== 'Failed' && !pod.metadata.deletionTimestamp;
}
