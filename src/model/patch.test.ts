import { describe, expect, it } from 'vitest';
import type { CronJob, Workload } from './kube';
import { resourcesPatch } from './patch';
import type { ResourceFix } from './rules';

const fix: ResourceFix = { kind: 'Deployment', namespace: 'shop', name: 'api', container: 'api', requests: { cpu: '130m' }, limits: {} };

describe('resourcesPatch', () => {
    it('carries the whole containers list, changing only the one container', () => {
        const d: Workload = {
            metadata: { name: 'api', namespace: 'shop' },
            spec: {
                template: {
                    spec: {
                        containers: [
                            { name: 'api', image: 'api:1', resources: { requests: { cpu: '1', memory: '1Gi' }, limits: { memory: '1Gi' } } },
                            { name: 'proxy', image: 'envoy:1', resources: { requests: { cpu: '50m' } } },
                        ],
                    },
                },
            },
        };
        expect(resourcesPatch(d, fix)).toEqual({
            spec: {
                template: {
                    spec: {
                        containers: [
                            { name: 'api', image: 'api:1', resources: { requests: { cpu: '130m', memory: '1Gi' }, limits: { memory: '1Gi' } } },
                            { name: 'proxy', image: 'envoy:1', resources: { requests: { cpu: '50m' } } },
                        ],
                    },
                },
            },
        });
    });

    it('finds a CronJob’s containers in its job template', () => {
        const c: CronJob = { metadata: { name: 'nightly', namespace: 'shop' }, spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: 'api' }] } } } } } };
        expect(resourcesPatch(c, { ...fix, kind: 'CronJob', limits: { memory: '64Mi' } })).toEqual({
            spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: 'api', resources: { requests: { cpu: '130m' }, limits: { memory: '64Mi' } } }] } } } } },
        });
    });

    it('refuses when the container has gone since the tip was made', () => {
        const d: Workload = { metadata: { name: 'api', namespace: 'shop' }, spec: { template: { spec: { containers: [{ name: 'other' }] } } } };
        expect(() => resourcesPatch(d, fix)).toThrow(/no container called api/);
    });
});
