// The rules. Each one looks at the cluster and says how many things it
// checked ("eligible") and which of them it has a tip about ("findings").
// That pair is what the score is made of: a rule's pass rate is the share of
// what it checked that it had nothing to say about.
//
// No rule guesses. Every threshold is written here, every tip names the
// objects it is about, and a rule that cannot look -- a kind it could not
// read, no usage data, a single node -- says so instead of passing.

import type { Cluster } from './cluster';
import { active, APP_KIND, type WorkloadInfo, type WorkloadKind } from './inventory';
import { time, type Container, type KubeObject } from './kube';
import { cpuQuantity, formatBytes, formatCpu, memoryQuantity, parseQuantity } from './quantity';
import {
    cpuVerdict,
    effectiveContainers,
    limitOf,
    memoryVerdict,
    observed,
    recommendCpu,
    recommendMemory,
    requestOf,
    templateContainers,
    type Observed,
    type Resource,
    type Verdict,
} from './resources';
import { matches, matchesMap } from './selector';

export type Category = 'resources' | 'reliability' | 'scaling' | 'usage' | 'waste' | 'nodes' | 'security' | 'observability';

export const CATEGORIES: readonly { id: Category; label: string }[] = [
    { id: 'resources', label: 'Requests & limits' },
    { id: 'usage', label: 'Rightsizing' },
    { id: 'reliability', label: 'Reliability' },
    { id: 'scaling', label: 'Autoscaling' },
    { id: 'waste', label: 'Waste' },
    { id: 'nodes', label: 'Nodes' },
    { id: 'security', label: 'Security basics' },
    { id: 'observability', label: 'Observability' },
];

export type Severity = 'high' | 'medium' | 'low';

/** How much a rule weighs in the score. */
export const WEIGHT: Readonly<Record<Severity, number>> = { high: 5, medium: 3, low: 1 };

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { high: 0, medium: 1, low: 2 };

/** Orders by severity, high first. Ties are left to a stable sort, so the rules' own order holds within one severity. */
export function bySeverity(a: { severity: Severity }, b: { severity: Severity }): number {
    return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
}

export interface Target {
    /** The app's kind name (`deployments`), or '' for the cluster itself. */
    kind: string;
    namespace: string;
    name: string;
    /** "Deployment shop/web", as a person reads it. */
    label: string;
    container?: string;
}

/** A change to one container's resources that a finding can apply. */
export interface ResourceFix {
    kind: WorkloadKind;
    namespace: string;
    name: string;
    container: string;
    requests: Partial<Record<Resource, string>>;
    limits: Partial<Record<Resource, string>>;
}

export interface Finding {
    rule: string;
    /** Unique and stable: what accepting a finding remembers. */
    key: string;
    target: Target;
    detail: string;
    fix?: ResourceFix;
    /** Cores and bytes of requests the fix would free (negative: it would ask for more). */
    saving?: { cpu: number; memory: number };
}

export interface RuleResult {
    eligible: number;
    findings: Finding[];
    /** Set when the rule could not look at all; it is then left out of the score. */
    unavailable?: string;
}

export interface Rule {
    id: string;
    title: string;
    category: Category;
    severity: Severity;
    /** Whether the rule counts until the user says otherwise. */
    defaultOn: boolean;
    /** Why it matters, in a sentence or two. */
    why: string;
    /** What to change. */
    how: string;
    /** App kinds it reads beyond pods and workloads; unreadable ones make it unavailable. */
    needs?: string[];
    /** Whether it needs usage data. */
    usage?: boolean;
    run(c: Cluster): RuleResult;
}

// ----- helpers ---------------------------------------------------------------------

function workloadTarget(w: WorkloadInfo, container?: string): Target {
    return { kind: APP_KIND[w.kind] ?? '', namespace: w.namespace, name: w.name, label: `${w.kind} ${w.namespace}/${w.name}`, container };
}

function objectTarget(kind: string, obj: KubeObject): Target {
    const namespace = obj.metadata.namespace ?? '';
    return { kind: APP_KIND[kind] ?? '', namespace, name: obj.metadata.name, label: `${kind} ${namespace ? namespace + '/' : ''}${obj.metadata.name}` };
}

const CLUSTER: Target = { kind: '', namespace: '', name: '', label: 'This cluster' };

function finding(rule: string, target: Target, detail: string, extra: Partial<Finding> = {}): Finding {
    const key = `${rule}:${target.kind}/${target.namespace}/${target.name}${target.container ? '/' + target.container : ''}`;
    return { rule, key, target, detail, ...extra };
}

function workloads(c: Cluster, kinds?: WorkloadKind[]): WorkloadInfo[] {
    return c.inventory.workloads.filter((w) => c.inScope(w.namespace) && (!kinds || kinds.includes(w.kind)));
}

function scoped<T extends KubeObject>(c: Cluster, list: T[]): T[] {
    return list.filter((o) => c.inScope(o.metadata.namespace ?? ''));
}

const has = (q: string | undefined): boolean => Number.isFinite(parseQuantity(q));

/**
 * A rule over workloads' containers: `check` returns what is wrong with one
 * container, or null. One finding per workload, naming every container.
 */
function perContainer(
    id: string,
    kinds: WorkloadKind[] | undefined,
    containers: (w: WorkloadInfo) => Container[],
    check: (c: Container) => string | null,
): (c: Cluster) => RuleResult {
    return (cl) => {
        const list = workloads(cl, kinds);
        const findings: Finding[] = [];
        for (const w of list) {
            const problems = containers(w)
                .map((ct) => {
                    const p = check(ct);
                    return p ? `${ct.name}: ${p}` : null;
                })
                .filter((p): p is string => p !== null);
            if (problems.length) findings.push(finding(id, workloadTarget(w), problems.join('; ')));
        }
        return { eligible: list.length, findings };
    };
}

function replicated(c: Cluster, min: number): WorkloadInfo[] {
    return workloads(c, ['Deployment', 'StatefulSet']).filter((w) => (w.replicas ?? 0) >= min);
}

function schedulableNodes(c: Cluster): number {
    return c.nodes.filter((n) => !n.spec?.unschedulable).length;
}

/** Reads a tag off an image reference: '' for none, and the digest if pinned. */
export function imageTag(image: string): { tag: string; digest: boolean } {
    const at = image.indexOf('@');
    const digest = at >= 0;
    const name = digest ? image.slice(0, at) : image;
    const slash = name.lastIndexOf('/');
    const colon = name.lastIndexOf(':');
    return { tag: colon > slash ? name.slice(colon + 1) : '', digest };
}

interface NodeLoad {
    cpu: number;
    memory: number;
    memoryLimits: number;
    pods: number;
}

function nodeLoads(c: Cluster): Map<string, NodeLoad> {
    const out = new Map<string, NodeLoad>();
    for (const pod of c.pods) {
        const node = pod.spec?.nodeName;
        if (!node || !active(pod)) continue;
        const load = out.get(node) ?? { cpu: 0, memory: 0, memoryLimits: 0, pods: 0 };
        for (const ct of pod.spec?.containers ?? []) {
            load.cpu += requestOf(ct, 'cpu') || 0;
            load.memory += requestOf(ct, 'memory') || 0;
            load.memoryLimits += limitOf(ct, 'memory') || 0;
        }
        load.pods++;
        out.set(node, load);
    }
    return out;
}

function pct(part: number, whole: number): string {
    return `${Math.round((part / whole) * 100)}%`;
}

// ----- rightsizing -------------------------------------------------------------------

const PATCHABLE: ReadonlySet<WorkloadKind> = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob']);

export interface Sized {
    w: WorkloadInfo;
    container: Container;
    seen: Observed;
}

/** Every in-scope workload container that has usage readings. */
export function sized(c: Cluster): Sized[] {
    const out: Sized[] = [];
    for (const w of workloads(c)) {
        const seen = observed(w, c.usage);
        if (!seen.size) continue;
        for (const container of effectiveContainers(w)) {
            const s = seen.get(container.name);
            if (s) out.push({ w, container, seen: s });
        }
    }
    return out;
}

/**
 * A fix for one container that never leaves a request above its limit: raising
 * one raises the other with it.
 */
export function resourceFix(s: Sized, change: { requests?: Partial<Record<Resource, number>>; limits?: Partial<Record<Resource, number>> }): ResourceFix | undefined {
    if (!PATCHABLE.has(s.w.kind)) return undefined;
    const fix: ResourceFix = { kind: s.w.kind, namespace: s.w.namespace, name: s.w.name, container: s.container.name, requests: {}, limits: {} };
    for (const resource of ['cpu', 'memory'] as const) {
        const req = change.requests?.[resource];
        let lim = change.limits?.[resource];
        const currentLimit = limitOf(s.container, resource);
        if (req !== undefined && lim === undefined && Number.isFinite(currentLimit) && req > currentLimit) lim = req;
        const quantity = resource === 'cpu' ? cpuQuantity : memoryQuantity;
        if (req !== undefined) fix.requests[resource] = quantity(req);
        if (lim !== undefined) fix.limits[resource] = quantity(lim);
        const currentRequest = requestOf(s.container, resource);
        if (lim !== undefined && req === undefined && Number.isFinite(currentRequest) && currentRequest > lim) fix.requests[resource] = quantity(lim);
    }
    return fix;
}

function sizingRule(
    id: string,
    resource: Resource,
    verdict: Verdict,
    build: (s: Sized, history: boolean) => Pick<Finding, 'detail' | 'fix' | 'saving'>,
): (c: Cluster) => RuleResult {
    return (c) => {
        if (c.usage.source === 'none') return { eligible: 0, findings: [], unavailable: 'Needs usage data — Prometheus, VictoriaMetrics or metrics-server. See the tip under Observability.' };
        const history = c.usage.source === 'prometheus';
        let eligible = 0;
        const findings: Finding[] = [];
        for (const s of sized(c)) {
            const req = requestOf(s.container, resource);
            const v =
                resource === 'cpu' ? cpuVerdict(req, s.seen.cpu, history) : memoryVerdict(req, limitOf(s.container, 'memory'), s.seen.memory, history);
            if (v === 'unknown') continue;
            eligible++;
            if (v !== verdict) continue;
            const built = build(s, history);
            findings.push(finding(id, workloadTarget(s.w, s.container.name), built.detail, { fix: history ? built.fix : undefined, saving: built.saving }));
        }
        return { eligible, findings };
    };
}

function usedText(history: boolean): string {
    return history ? 'over the last day' : 'right now (one reading from metrics-server)';
}

function podCount(s: Sized): number {
    return Math.max(1, s.w.pods.filter(active).length);
}

// ----- the rules ---------------------------------------------------------------------

export const RULES: readonly Rule[] = [
    // --- requests & limits
    {
        id: 'requests-missing',
        title: 'Containers without CPU or memory requests',
        category: 'resources',
        severity: 'high',
        defaultOn: true,
        why: 'The scheduler places pods by their requests. A container without them is placed as if it needed nothing, lands on nodes that are already full, and is the first to be evicted when memory runs short.',
        how: 'Set resources.requests.cpu and resources.requests.memory on every container — the Rightsizing view suggests values from real usage — or give the namespace a LimitRange with defaults.',
        run: perContainer('requests-missing', undefined, effectiveContainers, (ct) => {
            const missing = (['cpu', 'memory'] as const).filter((r) => !Number.isFinite(requestOf(ct, r)));
            return missing.length ? `no ${missing.join(' or ')} request` : null;
        }),
    },
    {
        id: 'memory-limit-missing',
        title: 'Containers without a memory limit',
        category: 'resources',
        severity: 'medium',
        defaultOn: true,
        why: 'Memory cannot be taken back once it is used. A container with no limit can grow until the node itself runs out, and then the kernel picks what to kill — possibly something else.',
        how: 'Set resources.limits.memory, a little above the peak you see in Rightsizing.',
        run: perContainer('memory-limit-missing', undefined, effectiveContainers, (ct) => (has(ct.resources?.limits?.memory) ? null : 'no memory limit')),
    },
    {
        id: 'memory-limit-ratio',
        title: 'Memory limits far above requests',
        category: 'resources',
        severity: 'low',
        defaultOn: true,
        why: 'The scheduler plans for the request; the limit is what the container may actually take. A limit many times the request overcommits the node, and under pressure those pods are killed first.',
        how: 'Bring the memory request closer to the limit — at most four times smaller — or lower the limit.',
        run: perContainer('memory-limit-ratio', undefined, effectiveContainers, (ct) => {
            const req = parseQuantity(ct.resources?.requests?.memory);
            const lim = parseQuantity(ct.resources?.limits?.memory);
            if (!(req > 0) || !(lim > 0) || lim <= req * 4) return null;
            return `limit ${formatBytes(lim)} is ${Math.round(lim / req)}× the ${formatBytes(req)} request`;
        }),
    },
    {
        id: 'cpu-limits',
        title: 'CPU limits set',
        category: 'resources',
        severity: 'low',
        defaultOn: false,
        why: 'A CPU limit throttles a container even when the node has CPU to spare, which shows up as latency rather than as an error. Many teams set requests only and leave CPU unlimited; others want limits for fairness. Off by default for that reason.',
        how: 'Remove resources.limits.cpu, keeping a CPU request that matches real use.',
        run: perContainer('cpu-limits', undefined, effectiveContainers, (ct) => (has(ct.resources?.limits?.cpu) ? `CPU limit ${formatCpu(parseQuantity(ct.resources?.limits?.cpu))}` : null)),
    },
    {
        id: 'namespace-limitrange',
        title: 'Namespaces without a LimitRange',
        category: 'resources',
        severity: 'low',
        defaultOn: true,
        needs: ['limitranges', 'namespaces'],
        why: 'A LimitRange gives containers default requests and limits when they set none, so one forgotten manifest does not become a pod the scheduler knows nothing about.',
        how: 'Add a LimitRange with default and defaultRequest for cpu and memory to namespaces that run workloads.',
        run: (c) => {
            const withWorkloads = new Set(workloads(c).map((w) => w.namespace));
            const covered = new Set(c.limitranges.map((l) => l.metadata.namespace ?? ''));
            const list = scoped(c, c.namespaces).filter((ns) => withWorkloads.has(ns.metadata.name));
            const findings = list
                .filter((ns) => !covered.has(ns.metadata.name))
                .map((ns) => finding('namespace-limitrange', objectTarget('Namespace', ns), 'runs workloads and has no LimitRange'));
            return { eligible: list.length, findings };
        },
    },
    {
        id: 'namespace-quota',
        title: 'Namespaces without a ResourceQuota',
        category: 'resources',
        severity: 'low',
        defaultOn: false,
        needs: ['resourcequotas', 'namespaces'],
        why: 'A ResourceQuota caps what one namespace can ask for, so one team or one runaway deployment cannot take the whole cluster. Mostly useful on shared clusters; off by default.',
        how: 'Add a ResourceQuota with requests.cpu, requests.memory and limits.memory to each namespace.',
        run: (c) => {
            const withWorkloads = new Set(workloads(c).map((w) => w.namespace));
            const covered = new Set(c.resourcequotas.map((q) => q.metadata.namespace ?? ''));
            const list = scoped(c, c.namespaces).filter((ns) => withWorkloads.has(ns.metadata.name));
            const findings = list
                .filter((ns) => !covered.has(ns.metadata.name))
                .map((ns) => finding('namespace-quota', objectTarget('Namespace', ns), 'runs workloads and has no ResourceQuota'));
            return { eligible: list.length, findings };
        },
    },

    // --- rightsizing
    {
        id: 'cpu-overprovisioned',
        title: 'CPU requests far above use',
        category: 'usage',
        severity: 'medium',
        defaultOn: true,
        usage: true,
        why: 'A CPU request is reserved on the node whether it is used or not. Requests far above use make the cluster look full while its CPUs idle, and that is paid for in nodes.',
        how: 'Lower the request to the 95th percentile of use plus headroom. With Prometheus or VictoriaMetrics, Apply does it for you.',
        run: sizingRule('cpu-overprovisioned', 'cpu', 'over', (s, history) => {
            const req = requestOf(s.container, 'cpu');
            const rec = recommendCpu(s.seen.cpu);
            return {
                detail: `asks for ${formatCpu(req)}, uses ${formatCpu(s.seen.cpu)} ${usedText(history)} — ${formatCpu(parseQuantity(cpuQuantity(rec)))} would do`,
                fix: resourceFix(s, { requests: { cpu: rec } }),
                saving: { cpu: (req - rec) * podCount(s), memory: 0 },
            };
        }),
    },
    {
        id: 'memory-overprovisioned',
        title: 'Memory requests far above use',
        category: 'usage',
        severity: 'medium',
        defaultOn: true,
        usage: true,
        why: 'Requested memory is set aside on the node. Requests far above the peak keep other pods off nodes that have memory to spare.',
        how: 'Lower the request to the day’s peak plus headroom. With Prometheus or VictoriaMetrics, Apply does it for you.',
        run: sizingRule('memory-overprovisioned', 'memory', 'over', (s, history) => {
            const req = requestOf(s.container, 'memory');
            const rec = recommendMemory(s.seen.memory);
            return {
                detail: `asks for ${formatBytes(req)}, uses ${formatBytes(s.seen.memory)} ${history ? 'at its peak ' : ''}${usedText(history)} — ${memoryQuantity(rec)} would do`,
                fix: resourceFix(s, { requests: { memory: rec } }),
                saving: { cpu: 0, memory: (req - rec) * podCount(s) },
            };
        }),
    },
    {
        id: 'cpu-underprovisioned',
        title: 'CPU requests below use',
        category: 'usage',
        severity: 'medium',
        defaultOn: true,
        usage: true,
        why: 'A container that uses more CPU than it asks for is placed on nodes as if it were small; when the node is busy it gets only its share of the request, and slows down.',
        how: 'Raise the CPU request to the 95th percentile of use plus headroom.',
        run: sizingRule('cpu-underprovisioned', 'cpu', 'under', (s, history) => {
            const req = requestOf(s.container, 'cpu');
            const rec = recommendCpu(s.seen.cpu);
            const lim = limitOf(s.container, 'cpu');
            return {
                detail: `asks for ${formatCpu(req)}, uses ${formatCpu(s.seen.cpu)} ${usedText(history)}${Number.isFinite(lim) ? `; its ${formatCpu(lim)} limit throttles it` : ''}`,
                fix: resourceFix(s, { requests: { cpu: rec } }),
                saving: { cpu: (req - rec) * podCount(s), memory: 0 },
            };
        }),
    },
    {
        id: 'memory-underprovisioned',
        title: 'Memory requests below use',
        category: 'usage',
        severity: 'medium',
        defaultOn: true,
        usage: true,
        why: 'Pods using more memory than they request are the first the kubelet evicts when a node runs short, and they let the scheduler pack a node tighter than it can hold.',
        how: 'Raise the memory request to the day’s peak plus headroom.',
        run: sizingRule('memory-underprovisioned', 'memory', 'under', (s, history) => {
            const req = requestOf(s.container, 'memory');
            const rec = recommendMemory(s.seen.memory);
            return {
                detail: `asks for ${formatBytes(req)}, uses ${formatBytes(s.seen.memory)} ${usedText(history)}`,
                fix: resourceFix(s, { requests: { memory: rec } }),
                saving: { cpu: 0, memory: (req - rec) * podCount(s) },
            };
        }),
    },
    {
        id: 'memory-near-limit',
        title: 'Memory close to the limit',
        category: 'usage',
        severity: 'high',
        defaultOn: true,
        usage: true,
        why: 'A container that reaches its memory limit is killed (OOMKilled) and restarted. At 90% of the limit that is one busy moment away.',
        how: 'Raise the memory limit above the peak with headroom, or find out why it grows.',
        run: sizingRule('memory-near-limit', 'memory', 'near-limit', (s, history) => {
            const lim = limitOf(s.container, 'memory');
            const rec = recommendMemory(s.seen.memory);
            return {
                detail: `uses ${formatBytes(s.seen.memory)} of its ${formatBytes(lim)} limit ${usedText(history)} (${pct(s.seen.memory, lim)})`,
                fix: resourceFix(s, { limits: { memory: rec } }),
            };
        }),
    },

    // --- reliability
    {
        id: 'single-replica',
        title: 'Workloads with a single replica',
        category: 'reliability',
        severity: 'medium',
        defaultOn: true,
        needs: ['horizontalpodautoscalers'],
        why: 'One replica means every node drain, upgrade or crash is an outage, however short.',
        how: 'Run at least two replicas (and a PodDisruptionBudget), or accept the finding for things that may be down now and then.',
        run: (c) => {
            const scaled = new Set(
                c.horizontalpodautoscalers
                    .filter((h) => (h.spec?.minReplicas ?? 1) > 1)
                    .map((h) => `${h.spec?.scaleTargetRef?.kind}/${h.metadata.namespace}/${h.spec?.scaleTargetRef?.name}`),
            );
            const list = replicated(c, 1);
            const findings = list.filter((w) => w.replicas === 1 && !scaled.has(w.key)).map((w) => finding('single-replica', workloadTarget(w), 'runs one replica'));
            return { eligible: list.length, findings };
        },
    },
    {
        id: 'pdb-missing',
        title: 'Replicated workloads without a PodDisruptionBudget',
        category: 'reliability',
        severity: 'medium',
        defaultOn: true,
        needs: ['poddisruptionbudgets'],
        why: 'Without a PodDisruptionBudget a node drain may evict every replica at once, and the service goes down even though it runs several.',
        how: 'Add a PodDisruptionBudget with maxUnavailable: 1 selecting the workload’s pods.',
        run: (c) => {
            const list = replicated(c, 2);
            const findings = list
                .filter((w) => !c.poddisruptionbudgets.some((p) => p.metadata.namespace === w.namespace && matches(p.spec?.selector, w.template.metadata?.labels)))
                .map((w) => finding('pdb-missing', workloadTarget(w), `${w.replicas} replicas, no PodDisruptionBudget`));
            return { eligible: list.length, findings };
        },
    },
    {
        id: 'pdb-blocking',
        title: 'PodDisruptionBudgets that block every eviction',
        category: 'reliability',
        severity: 'high',
        defaultOn: true,
        needs: ['poddisruptionbudgets'],
        why: 'A budget that allows no disruptions while every pod is healthy — minAvailable equal to the replicas, or maxUnavailable: 0 — makes node drains hang. Upgrades and autoscaler scale-downs stall on it.',
        how: 'Allow at least one disruption: maxUnavailable: 1, or minAvailable below the replica count.',
        run: (c) => {
            const list = scoped(c, c.poddisruptionbudgets).filter((p) => (p.status?.expectedPods ?? 0) > 0);
            const findings = list
                .filter((p) => p.status?.disruptionsAllowed === 0 && (p.status?.currentHealthy ?? 0) >= (p.status?.desiredHealthy ?? Infinity))
                .map((p) => finding('pdb-blocking', objectTarget('PodDisruptionBudget', p), `allows 0 disruptions with all ${p.status?.currentHealthy} pods healthy`));
            return { eligible: list.length, findings };
        },
    },
    {
        id: 'readiness-probe',
        title: 'Containers without a readiness probe',
        category: 'reliability',
        severity: 'medium',
        defaultOn: true,
        why: 'Without a readiness probe a pod gets traffic the moment its process starts, before it can answer, and keeps getting it when it stops answering. Rollouts drop requests.',
        how: 'Add a readinessProbe that checks the container can serve — an HTTP health endpoint or a TCP port.',
        run: perContainer('readiness-probe', ['Deployment', 'StatefulSet'], templateContainers, (ct) => (ct.readinessProbe ? null : 'no readiness probe')),
    },
    {
        id: 'liveness-probe',
        title: 'Containers without a liveness probe',
        category: 'reliability',
        severity: 'low',
        defaultOn: false,
        why: 'A liveness probe restarts a container that is running but stuck. Useful for processes that can hang; harmful when it is too strict. Off by default.',
        how: 'Add a livenessProbe with generous timeouts, and a startupProbe for slow starters.',
        run: perContainer('liveness-probe', ['Deployment', 'StatefulSet', 'DaemonSet'], templateContainers, (ct) => (ct.livenessProbe ? null : 'no liveness probe')),
    },
    {
        id: 'topology-spread',
        title: 'Replicas that may all land on one node',
        category: 'reliability',
        severity: 'low',
        defaultOn: true,
        needs: ['nodes'],
        why: 'Several replicas on one node are one replica as far as that node failing is concerned. Without spread constraints or anti-affinity the scheduler may put them together.',
        how: 'Add topologySpreadConstraints on kubernetes.io/hostname (and topology.kubernetes.io/zone if you have zones), or a preferred podAntiAffinity.',
        run: (c) => {
            if (schedulableNodes(c) < 2) return { eligible: 0, findings: [], unavailable: 'Only one schedulable node: there is nowhere to spread to.' };
            const list = replicated(c, 2);
            const findings: Finding[] = [];
            for (const w of list) {
                const spec = w.template.spec;
                if (spec?.topologySpreadConstraints?.length || spec?.affinity?.podAntiAffinity) continue;
                const nodes = new Set(w.pods.filter(active).map((p) => p.spec?.nodeName).filter(Boolean));
                const running = w.pods.filter(active).length;
                const detail = running > 1 && nodes.size === 1 ? `all ${running} pods run on ${[...nodes][0]}` : 'no spread constraint or anti-affinity';
                findings.push(finding('topology-spread', workloadTarget(w), detail));
            }
            return { eligible: list.length, findings };
        },
    },
    {
        id: 'image-latest',
        title: 'Images on :latest or with no tag',
        category: 'reliability',
        severity: 'medium',
        defaultOn: true,
        why: 'What :latest runs depends on when each node pulled it: two replicas may run two builds, and a rollback goes nowhere.',
        how: 'Use a version tag, or better a digest (image@sha256:…).',
        run: perContainer('image-latest', undefined, templateContainers, (ct) => {
            const { tag, digest } = imageTag(ct.image ?? '');
            if (digest) return null;
            if (!tag) return `${ct.image} has no tag (means :latest)`;
            return tag === 'latest' ? `${ct.image}` : null;
        }),
    },
    {
        id: 'oom-killed',
        title: 'Containers killed for running out of memory',
        category: 'reliability',
        severity: 'high',
        defaultOn: true,
        why: 'OOMKilled means the container reached its memory limit and the kernel killed it. It restarts, and whatever it was doing is lost.',
        how: 'Raise the memory limit (and request) above the real peak, or fix what makes it grow.',
        run: (c) => {
            const list = workloads(c).filter((w) => w.pods.length > 0);
            const findings: Finding[] = [];
            for (const w of list) {
                const hit = new Map<string, number>();
                for (const pod of w.pods) {
                    for (const s of pod.status?.containerStatuses ?? []) {
                        if (s.lastState?.terminated?.reason === 'OOMKilled' || s.state?.terminated?.reason === 'OOMKilled') hit.set(s.name, (hit.get(s.name) ?? 0) + 1);
                    }
                }
                if (!hit.size) continue;
                const limits = new Map(effectiveContainers(w).map((ct) => [ct.name, limitOf(ct, 'memory')]));
                const text = [...hit]
                    .map(([name, pods]) => {
                        const lim = limits.get(name);
                        return `${name} in ${pods} pod${pods === 1 ? '' : 's'}${lim && Number.isFinite(lim) ? ` (limit ${formatBytes(lim)})` : ''}`;
                    })
                    .join('; ');
                findings.push(finding('oom-killed', workloadTarget(w), `OOMKilled: ${text}`));
            }
            return { eligible: list.length, findings };
        },
    },
    {
        id: 'crash-restarts',
        title: 'Containers that keep restarting',
        category: 'reliability',
        severity: 'medium',
        defaultOn: true,
        why: 'Frequent restarts are failures the cluster is hiding: requests fail while a container comes back, and CrashLoopBackOff waits longer each time.',
        how: 'Read the logs of the previous container (kubectl logs --previous) and the pod’s events.',
        run: (c) => {
            const list = workloads(c).filter((w) => w.pods.length > 0);
            const findings: Finding[] = [];
            for (const w of list) {
                let restarts = 0;
                let looping = false;
                for (const pod of w.pods) {
                    for (const s of pod.status?.containerStatuses ?? []) {
                        restarts += s.restartCount ?? 0;
                        if (s.state?.waiting?.reason === 'CrashLoopBackOff') looping = true;
                    }
                }
                if (restarts >= 5 || looping) findings.push(finding('crash-restarts', workloadTarget(w), `${restarts} restarts${looping ? ', in CrashLoopBackOff now' : ''}`));
            }
            return { eligible: list.length, findings };
        },
    },

    // --- autoscaling
    {
        id: 'hpa-no-requests',
        title: 'Autoscalers on a resource their target does not request',
        category: 'scaling',
        severity: 'high',
        defaultOn: true,
        needs: ['horizontalpodautoscalers'],
        why: 'An autoscaler on CPU or memory utilisation measures use as a share of the request. With no request there is nothing to divide by, and it never scales.',
        how: 'Set the request the autoscaler measures on every container of the target.',
        run: (c) => {
            const findings: Finding[] = [];
            let eligible = 0;
            for (const h of scoped(c, c.horizontalpodautoscalers)) {
                const resources = new Set<Resource>();
                if (h.spec?.targetCPUUtilizationPercentage) resources.add('cpu');
                for (const m of h.spec?.metrics ?? []) {
                    const name = m.type === 'Resource' ? m.resource?.name : m.type === 'ContainerResource' ? m.containerResource?.name : undefined;
                    if (name === 'cpu' || name === 'memory') resources.add(name);
                }
                const ref = h.spec?.scaleTargetRef;
                const target = ref ? c.inventory.byKey.get(`${ref.kind}/${h.metadata.namespace ?? ''}/${ref.name}`) : undefined;
                if (!resources.size || !target) continue;
                eligible++;
                const gaps = effectiveContainers(target).flatMap((ct) => [...resources].filter((r) => !Number.isFinite(requestOf(ct, r))).map((r) => `${ct.name} has no ${r} request`));
                if (gaps.length) findings.push(finding('hpa-no-requests', objectTarget('HorizontalPodAutoscaler', h), `scales ${target.kind} ${target.name}, but ${gaps.join('; ')}`));
            }
            return { eligible, findings };
        },
    },
    {
        id: 'hpa-at-max',
        title: 'Autoscalers stuck at their maximum',
        category: 'scaling',
        severity: 'medium',
        defaultOn: true,
        needs: ['horizontalpodautoscalers'],
        why: 'At maxReplicas the autoscaler cannot add capacity any more: load beyond this point is slower responses, not more pods.',
        how: 'Raise maxReplicas, or look at why the workload needs so many.',
        run: (c) => {
            const list = scoped(c, c.horizontalpodautoscalers).filter((h) => (h.spec?.maxReplicas ?? 0) > 0);
            const findings = list
                .filter((h) => (h.status?.currentReplicas ?? 0) >= (h.spec?.maxReplicas ?? Infinity))
                .map((h) => finding('hpa-at-max', objectTarget('HorizontalPodAutoscaler', h), `at ${h.status?.currentReplicas} of max ${h.spec?.maxReplicas} replicas`));
            return { eligible: list.length, findings };
        },
    },
    {
        id: 'hpa-fixed',
        title: 'Autoscalers with min equal to max',
        category: 'scaling',
        severity: 'low',
        defaultOn: true,
        needs: ['horizontalpodautoscalers'],
        why: 'An autoscaler whose minimum and maximum are the same never scales; it only adds a controller to reason about.',
        how: 'Widen the range, or remove the autoscaler and set replicas on the workload.',
        run: (c) => {
            const list = scoped(c, c.horizontalpodautoscalers);
            const findings = list
                .filter((h) => (h.spec?.minReplicas ?? 1) === h.spec?.maxReplicas)
                .map((h) => finding('hpa-fixed', objectTarget('HorizontalPodAutoscaler', h), `min and max are both ${h.spec?.maxReplicas}`));
            return { eligible: list.length, findings };
        },
    },

    // --- waste
    {
        id: 'pvc-pending',
        title: 'Volume claims stuck pending',
        category: 'waste',
        severity: 'medium',
        defaultOn: true,
        needs: ['persistentvolumeclaims'],
        why: 'A claim pending for more than a few minutes will not bind by itself: no storage class, no matching volume, or a provisioner that is failing. Whatever mounts it cannot start.',
        how: 'Look at the claim’s events; check its storageClassName exists and the provisioner is running.',
        run: (c) => {
            const list = scoped(c, c.persistentvolumeclaims);
            const findings = list
                .filter((p) => p.status?.phase === 'Pending' && c.now - time(p.metadata.creationTimestamp) > 10 * 60_000)
                .map((p) => finding('pvc-pending', objectTarget('PersistentVolumeClaim', p), `pending, storage class ${p.spec?.storageClassName ?? '(default)'}`));
            return { eligible: list.length, findings };
        },
    },
    {
        id: 'pvc-unused',
        title: 'Volume claims no pod uses',
        category: 'waste',
        severity: 'low',
        defaultOn: true,
        needs: ['persistentvolumeclaims'],
        why: 'A bound claim holds its disk, and is paid for, whether anything mounts it or not. Often left behind by a StatefulSet scaled down or a deleted app.',
        how: 'Delete the claim if the data is not needed (check the reclaim policy of its volume first).',
        run: (c) => {
            const used = new Set<string>();
            for (const pod of c.pods) {
                if (!active(pod)) continue;
                for (const v of pod.spec?.volumes ?? []) if (v.persistentVolumeClaim?.claimName) used.add(`${pod.metadata.namespace}/${v.persistentVolumeClaim.claimName}`);
            }
            const list = scoped(c, c.persistentvolumeclaims).filter((p) => p.status?.phase === 'Bound');
            const findings = list
                .filter((p) => !used.has(`${p.metadata.namespace}/${p.metadata.name}`))
                .map((p) => finding('pvc-unused', objectTarget('PersistentVolumeClaim', p), `${p.status?.capacity?.storage ?? '?'} on ${p.spec?.storageClassName ?? '(default)'}, mounted by no running pod`));
            return { eligible: list.length, findings };
        },
    },
    {
        id: 'pv-released',
        title: 'Released volumes nobody can use',
        category: 'waste',
        severity: 'low',
        defaultOn: true,
        needs: ['persistentvolumes'],
        why: 'A Released volume’s claim is gone, but with the Retain policy the disk stays. No new claim can bind to it until someone cleans it up.',
        how: 'Back up what you need, then delete the PersistentVolume (and the disk behind it, if the provisioner does not).',
        run: (c) => {
            const list = c.persistentvolumes;
            const findings = list
                .filter((p) => p.status?.phase === 'Released')
                .map((p) =>
                    finding(
                        'pv-released',
                        objectTarget('PersistentVolume', p),
                        `${p.spec?.capacity?.storage ?? '?'}, was ${p.spec?.claimRef?.namespace ?? '?'}/${p.spec?.claimRef?.name ?? '?'}, policy ${p.spec?.persistentVolumeReclaimPolicy ?? '?'}`,
                    ),
                );
            return { eligible: list.length, findings };
        },
    },
    {
        id: 'scaled-to-zero',
        title: 'Workloads scaled to zero',
        category: 'waste',
        severity: 'low',
        defaultOn: true,
        why: 'Scaled to zero is often something forgotten: its config, volumes and services stay behind. Accept the ones that are meant to be off.',
        how: 'Delete what is no longer needed, or accept the finding.',
        run: (c) => {
            const list = workloads(c, ['Deployment', 'StatefulSet']);
            const findings = list.filter((w) => w.replicas === 0).map((w) => finding('scaled-to-zero', workloadTarget(w), 'replicas: 0'));
            return { eligible: list.length, findings };
        },
    },
    {
        id: 'jobs-no-ttl',
        title: 'Finished Jobs kept around',
        category: 'waste',
        severity: 'low',
        defaultOn: true,
        why: 'A finished Job and its pods stay until someone deletes them. They pile up, and every controller and list call pays for them.',
        how: 'Set ttlSecondsAfterFinished on the Job so the cluster removes it, or run it from a CronJob with a history limit.',
        run: (c) => {
            const finished = (j: (typeof c.jobs)[number]): number => {
                const cond = j.status?.conditions?.find((k) => (k.type === 'Complete' || k.type === 'Failed') && k.status === 'True');
                return cond ? time(j.status?.completionTime) || time(cond.lastTransitionTime) || 1 : 0;
            };
            const list = workloads(c, ['Job']).filter((w) => finished(w.obj as (typeof c.jobs)[number]) > 0);
            const findings = list
                .filter((w) => {
                    const job = w.obj as (typeof c.jobs)[number];
                    return job.spec?.ttlSecondsAfterFinished === undefined && c.now - finished(job) > 86_400_000;
                })
                .map((w) => finding('jobs-no-ttl', workloadTarget(w), 'finished more than a day ago, no ttlSecondsAfterFinished'));
            return { eligible: list.length, findings };
        },
    },
    {
        id: 'service-no-pods',
        title: 'Services that select no pods',
        category: 'waste',
        severity: 'low',
        defaultOn: true,
        needs: ['services'],
        why: 'A Service whose selector matches no running pod answers nothing. A LoadBalancer one still costs a cloud load balancer.',
        how: 'Fix the selector, or delete the Service if the app is gone.',
        run: (c) => {
            const list = scoped(c, c.services).filter((s) => Object.keys(s.spec?.selector ?? {}).length > 0);
            const findings = list
                .filter((s) => !c.pods.some((p) => p.metadata.namespace === s.metadata.namespace && active(p) && matchesMap(s.spec?.selector, p.metadata.labels)))
                .map((s) => finding('service-no-pods', objectTarget('Service', s), `${s.spec?.type ?? 'ClusterIP'} selecting ${Object.entries(s.spec?.selector ?? {}).map(([k, v]) => `${k}=${v}`).join(',')} matches no running pod`));
            return { eligible: list.length, findings };
        },
    },

    // --- nodes
    {
        id: 'node-requests-high',
        title: 'Nodes nearly fully requested',
        category: 'nodes',
        severity: 'medium',
        defaultOn: true,
        needs: ['nodes'],
        why: 'Above 90% of a node’s CPU or memory requested, new pods and rollouts wait for room, and a node failing leaves nowhere to go.',
        how: 'Add a node or let the cluster autoscaler do it, or free requests with the rightsizing tips.',
        run: (c) => {
            const loads = nodeLoads(c);
            const list = c.nodes.filter((n) => !n.spec?.unschedulable);
            const findings: Finding[] = [];
            for (const n of list) {
                const load = loads.get(n.metadata.name);
                const cpu = parseQuantity(n.status?.allocatable?.cpu);
                const mem = parseQuantity(n.status?.allocatable?.memory);
                if (!load || !(cpu > 0) || !(mem > 0)) continue;
                const parts: string[] = [];
                if (load.cpu / cpu > 0.9) parts.push(`CPU ${pct(load.cpu, cpu)} requested`);
                if (load.memory / mem > 0.9) parts.push(`memory ${pct(load.memory, mem)} requested`);
                if (parts.length) findings.push(finding('node-requests-high', objectTarget('Node', n), parts.join(', ')));
            }
            return { eligible: list.length, findings };
        },
    },
    {
        id: 'node-idle',
        title: 'Nodes that are mostly empty',
        category: 'nodes',
        severity: 'low',
        defaultOn: true,
        needs: ['nodes'],
        why: 'A node with under a fifth of its CPU and memory requested is capacity paid for and not used. Its pods would usually fit elsewhere.',
        how: 'Let the cluster autoscaler (or Karpenter) consolidate, or use fewer, larger nodes.',
        run: (c) => {
            const list = c.nodes.filter((n) => !n.spec?.unschedulable);
            if (list.length < 3) return { eligible: 0, findings: [], unavailable: 'Fewer than three schedulable nodes: nothing to consolidate.' };
            const loads = nodeLoads(c);
            const findings: Finding[] = [];
            for (const n of list) {
                const load = loads.get(n.metadata.name) ?? { cpu: 0, memory: 0, memoryLimits: 0, pods: 0 };
                const cpu = parseQuantity(n.status?.allocatable?.cpu);
                const mem = parseQuantity(n.status?.allocatable?.memory);
                if (!(cpu > 0) || !(mem > 0)) continue;
                if (load.cpu / cpu < 0.2 && load.memory / mem < 0.2) {
                    findings.push(finding('node-idle', objectTarget('Node', n), `CPU ${pct(load.cpu, cpu)} and memory ${pct(load.memory, mem)} requested, ${load.pods} pods`));
                }
            }
            return { eligible: list.length, findings };
        },
    },
    {
        id: 'node-memory-overcommit',
        title: 'Nodes whose memory limits add up far past their memory',
        category: 'nodes',
        severity: 'medium',
        defaultOn: true,
        needs: ['nodes'],
        why: 'When the memory limits on a node add up to well over what it has, the pods can all be within their limits and still run the node out of memory together.',
        how: 'Bring memory limits closer to requests on the biggest pods, or move them apart.',
        run: (c) => {
            const loads = nodeLoads(c);
            const list = c.nodes;
            const findings: Finding[] = [];
            for (const n of list) {
                const load = loads.get(n.metadata.name);
                const mem = parseQuantity(n.status?.allocatable?.memory);
                if (!load || !(mem > 0)) continue;
                if (load.memoryLimits > mem * 1.5) findings.push(finding('node-memory-overcommit', objectTarget('Node', n), `memory limits add up to ${pct(load.memoryLimits, mem)} of ${formatBytes(mem)}`));
            }
            return { eligible: list.length, findings };
        },
    },

    // --- security basics
    {
        id: 'privileged',
        title: 'Privileged containers',
        category: 'security',
        severity: 'high',
        defaultOn: true,
        why: 'A privileged container has the host’s devices and kernel capabilities: escaping it is escaping to the node. Some node agents need it; application pods do not.',
        how: 'Remove securityContext.privileged, adding only the capabilities the container needs.',
        run: perContainer('privileged', undefined, templateContainers, (ct) => (ct.securityContext?.privileged ? 'privileged' : null)),
    },
    {
        id: 'run-as-non-root',
        title: 'Containers that may run as root',
        category: 'security',
        severity: 'low',
        defaultOn: false,
        why: 'A process running as root inside the container is one kernel bug away from root on the node. Off by default: many images still need it.',
        how: 'Set securityContext.runAsNonRoot: true (and a runAsUser) on the pod or container.',
        run: (c) => {
            const list = workloads(c);
            const findings: Finding[] = [];
            for (const w of list) {
                const pod = w.template.spec?.securityContext;
                const podSafe = pod?.runAsNonRoot === true || (pod?.runAsUser ?? 0) > 0;
                const names = templateContainers(w)
                    .filter((ct) => {
                        const sc = ct.securityContext;
                        if (sc?.runAsNonRoot === true || (sc?.runAsUser ?? 0) > 0) return false;
                        return !podSafe || sc?.runAsUser === 0;
                    })
                    .map((ct) => ct.name);
                if (names.length) findings.push(finding('run-as-non-root', workloadTarget(w), `${names.join(', ')}: runAsNonRoot not set`));
            }
            return { eligible: list.length, findings };
        },
    },
    {
        id: 'automount-token',
        title: 'Service account tokens mounted by default',
        category: 'security',
        severity: 'low',
        defaultOn: false,
        why: 'Every pod gets a token for the Kubernetes API unless told otherwise; most application pods never use it. Off by default.',
        how: 'Set automountServiceAccountToken: false on pods that do not talk to the API.',
        run: (c) => {
            const list = workloads(c);
            const findings = list
                .filter((w) => w.template.spec?.automountServiceAccountToken !== false)
                .map((w) => finding('automount-token', workloadTarget(w), 'automountServiceAccountToken not false'));
            return { eligible: list.length, findings };
        },
    },

    // --- observability
    {
        id: 'metrics-source',
        title: 'Usage history for rightsizing',
        category: 'observability',
        severity: 'low',
        defaultOn: true,
        why: 'Rightsizing needs to know what containers actually use. A day of history from Prometheus or VictoriaMetrics is what a request should be sized on; metrics-server has only the reading of right now.',
        how: 'Install kube-prometheus-stack, or victoria-metrics-k8s-stack — K8s Dockside finds either. If yours is not found, set its address in the cluster’s settings.',
        run: (c) => {
            const u = c.usage;
            if (u.source === 'prometheus' && !u.note) return { eligible: 1, findings: [] };
            let detail: string;
            if (u.source === 'prometheus') detail = u.note;
            else if (u.source === 'metrics-server')
                detail = `Usage comes from metrics-server: one reading, right now (${u.note}). With Prometheus or VictoriaMetrics, rightsizing would use a day of history and could apply its suggestions.`;
            else
                detail = `No usage data (${u.note}). Installing Prometheus or VictoriaMetrics would turn on the rightsizing tips with a day of history; metrics-server alone would give a reading of right now.`;
            return { eligible: 1, findings: [finding('metrics-source', CLUSTER, detail)] };
        },
    },
];

export function ruleById(id: string): Rule | undefined {
    return RULES.find((r) => r.id === id);
}
