// The fields of Kubernetes objects the rules read, and nothing more.
//
// The bridge hands objects back whole, as the API server wrote them; these
// describe only what is used, so a typo in a field name is a compile error
// rather than an `undefined` on screen. Everything is optional: a half-created
// object, an older or newer cluster, or a kind that could not be read at all
// must never take the page down.

export type KubeObject = K8sDockside.KubeObject;

export interface ResourceList {
    cpu?: string;
    memory?: string;
    [name: string]: string | undefined;
}

export interface Resources {
    requests?: ResourceList;
    limits?: ResourceList;
}

export interface SecurityContext {
    privileged?: boolean;
    runAsNonRoot?: boolean;
    runAsUser?: number;
}

export interface Container {
    name: string;
    image?: string;
    resources?: Resources;
    readinessProbe?: unknown;
    livenessProbe?: unknown;
    startupProbe?: unknown;
    securityContext?: SecurityContext;
}

export interface Volume {
    name: string;
    persistentVolumeClaim?: { claimName?: string };
}

export interface PodSpec {
    containers?: Container[];
    initContainers?: Container[];
    nodeName?: string;
    affinity?: { podAntiAffinity?: unknown };
    topologySpreadConstraints?: unknown[];
    securityContext?: { runAsNonRoot?: boolean; runAsUser?: number };
    automountServiceAccountToken?: boolean;
    volumes?: Volume[];
}

export interface PodTemplate {
    metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> };
    spec?: PodSpec;
}

export interface ContainerStatus {
    name: string;
    ready?: boolean;
    restartCount?: number;
    state?: { waiting?: { reason?: string }; running?: unknown; terminated?: { reason?: string } };
    lastState?: { terminated?: { reason?: string; finishedAt?: string } };
}

export interface Pod extends KubeObject {
    spec?: PodSpec;
    status?: { phase?: string; containerStatuses?: ContainerStatus[] };
}

export interface LabelSelectorRequirement {
    key: string;
    operator: string;
    values?: string[];
}

export interface LabelSelector {
    matchLabels?: Record<string, string>;
    matchExpressions?: LabelSelectorRequirement[];
}

/** A Deployment, StatefulSet or DaemonSet: a pod template behind a selector. */
export interface Workload extends KubeObject {
    spec?: { replicas?: number; selector?: LabelSelector; template?: PodTemplate };
}

export interface CronJob extends KubeObject {
    spec?: { suspend?: boolean; jobTemplate?: { spec?: { template?: PodTemplate } } };
}

export interface Job extends KubeObject {
    spec?: { ttlSecondsAfterFinished?: number; template?: PodTemplate };
    status?: {
        completionTime?: string;
        conditions?: { type: string; status: string; lastTransitionTime?: string }[];
    };
}

export interface Node extends KubeObject {
    spec?: { unschedulable?: boolean };
    status?: { allocatable?: ResourceList };
}

export interface HpaMetric {
    type: string;
    resource?: { name?: string };
    containerResource?: { name?: string; container?: string };
}

export interface Hpa extends KubeObject {
    spec?: {
        scaleTargetRef?: { kind?: string; name?: string };
        minReplicas?: number;
        maxReplicas?: number;
        metrics?: HpaMetric[];
        /** autoscaling/v1 */
        targetCPUUtilizationPercentage?: number;
    };
    status?: { currentReplicas?: number; desiredReplicas?: number };
}

export interface Pdb extends KubeObject {
    spec?: { selector?: LabelSelector; minAvailable?: number | string; maxUnavailable?: number | string };
    status?: { disruptionsAllowed?: number; expectedPods?: number; currentHealthy?: number; desiredHealthy?: number };
}

export interface Pvc extends KubeObject {
    spec?: { storageClassName?: string; resources?: { requests?: ResourceList } };
    status?: { phase?: string; capacity?: ResourceList };
}

export interface Pv extends KubeObject {
    spec?: { capacity?: ResourceList; persistentVolumeReclaimPolicy?: string; claimRef?: { namespace?: string; name?: string } };
    status?: { phase?: string };
}

export interface Service extends KubeObject {
    spec?: { type?: string; selector?: Record<string, string> };
}

export interface PodMetrics extends KubeObject {
    containers?: { name: string; usage?: ResourceList }[];
}

export interface ConfigMap extends KubeObject {
    data?: Record<string, string>;
}

/** The owner that controls an object: the one with `controller: true`, or else the first. */
export function controllerOf(obj: KubeObject): K8sDockside.OwnerReference | null {
    const owners = obj.metadata.ownerReferences ?? [];
    return owners.find((o) => o.controller) ?? owners[0] ?? null;
}

/** Milliseconds since the epoch, or 0 when the text is not a time. */
export function time(text: string | undefined): number {
    const t = Date.parse(text ?? '');
    return Number.isFinite(t) ? t : 0;
}
