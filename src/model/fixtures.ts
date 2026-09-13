// Small builders for the tests: objects with just the fields the rules read.

import { emptySnapshot, type Snapshot } from './cluster';
import type { Container, ContainerStatus, Node, Pod, Workload } from './kube';

export function container(name: string, resources?: Container['resources'], extra: Partial<Container> = {}): Container {
    return { name, image: `registry.example.com/${name}:1.0`, resources, readinessProbe: {}, ...extra };
}

export function deployment(
    name: string,
    containers: Container[],
    opts: { replicas?: number; namespace?: string; annotations?: Record<string, string> } = {},
): Workload {
    const labels = { app: name };
    return {
        metadata: { name, namespace: opts.namespace ?? 'shop', annotations: opts.annotations },
        spec: { replicas: opts.replicas ?? 2, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: { containers } } },
    };
}

/** A pod of a Deployment, owned the way the Deployment controller owns one: through its ReplicaSet. */
export function podOf(d: Workload, index: number, opts: { node?: string; statuses?: ContainerStatus[]; phase?: string; containers?: Container[] } = {}): Pod {
    const hash = '5d8f7c9b4';
    return {
        metadata: {
            name: `${d.metadata.name}-${hash}-${index}`,
            namespace: d.metadata.namespace,
            labels: { ...(d.spec?.template?.metadata?.labels ?? {}), 'pod-template-hash': hash },
            ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: `${d.metadata.name}-${hash}`, uid: 'rs', controller: true }],
        },
        spec: { ...d.spec?.template?.spec, containers: opts.containers ?? d.spec?.template?.spec?.containers, nodeName: opts.node ?? 'node-a' },
        status: { phase: opts.phase ?? 'Running', containerStatuses: opts.statuses },
    };
}

export function node(name: string, cpu = '4', memory = '16Gi'): Node {
    return { metadata: { name }, status: { allocatable: { cpu, memory } } };
}

export function snapshot(parts: Partial<Snapshot>): Snapshot {
    return { ...emptySnapshot(), ...parts };
}

export const NOW = Date.parse('2026-09-13T12:00:00Z');
export const MI = 2 ** 20;
