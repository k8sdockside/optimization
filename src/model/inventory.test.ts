import { describe, expect, it } from 'vitest';
import { container, deployment, podOf } from './fixtures';
import { buildInventory } from './inventory';
import type { CronJob, Job, Pod } from './kube';

describe('buildInventory', () => {
    it('finds a pod’s Deployment through its ReplicaSet’s name and pod-template-hash', () => {
        const d = deployment('api', [container('api')]);
        const inv = buildInventory({ deployments: [d], statefulsets: [], daemonsets: [], cronjobs: [], jobs: [], pods: [podOf(d, 0), podOf(d, 1)] });
        expect(inv.byKey.get('Deployment/shop/api')!.pods).toHaveLength(2);
    });

    it('gives a CronJob’s pods to the CronJob, and a Job of its own to itself', () => {
        const cron: CronJob = { metadata: { name: 'nightly', namespace: 'shop' }, spec: { jobTemplate: { spec: { template: { spec: { containers: [] } } } } } };
        const made: Job = { metadata: { name: 'nightly-2901', namespace: 'shop', ownerReferences: [{ apiVersion: 'batch/v1', kind: 'CronJob', name: 'nightly', uid: 'c', controller: true }] } };
        const own: Job = { metadata: { name: 'migrate', namespace: 'shop' } };
        const pod = (name: string, job: string): Pod => ({
            metadata: { name, namespace: 'shop', ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name: job, uid: 'j', controller: true }] },
        });
        const inv = buildInventory({ deployments: [], statefulsets: [], daemonsets: [], cronjobs: [cron], jobs: [made, own], pods: [pod('a', 'nightly-2901'), pod('b', 'migrate')] });
        expect(inv.workloads.map((w) => w.key)).toEqual(['CronJob/shop/nightly', 'Job/shop/migrate']);
        expect(inv.ownerOfPod.get('shop/a')!.key).toBe('CronJob/shop/nightly');
        expect(inv.ownerOfPod.get('shop/b')!.key).toBe('Job/shop/migrate');
    });

    it('leaves out a pod whose owner it cannot trace', () => {
        const stray: Pod = { metadata: { name: 'debug', namespace: 'shop' } };
        const inv = buildInventory({ deployments: [], statefulsets: [], daemonsets: [], cronjobs: [], jobs: [], pods: [stray] });
        expect(inv.ownerOfPod.size).toBe(0);
    });
});
