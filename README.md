# Optimization advisor

A [K8s Dockside](https://github.com/k8sdockside/k8sdockside) plugin that checks a
cluster against a set of plain rules, gives it a score from 0 to 100, and says what to
change to raise it. No AI and no guesswork: every tip names the objects it is about,
why it matters, and what to do.

- **Overview**: the score, a score per category, where usage data comes from, and
  every rule as a checklist. Untick a rule to leave it out of the score; **Accept** a
  finding you have decided to live with. **Save to cluster** keeps your choices.
- **Rightsizing**: every container's CPU and memory, as requested, as used and as
  suggested, with **Apply** to write the suggestion.

It works on any cluster: it reads core kinds only, and never Secrets. Every change
(a fix, saving your choices) is shown to you in the app before it is made.

## Install

**Settings → Plugins → Available → Optimization advisor → Install**, or install from
`https://github.com/k8sdockside/optimization.git`. It needs
K8s Dockside 0.0.17 or later.

## Where usage comes from

The rightsizing rules need to know what containers actually use. The advisor takes the
best source the cluster has:

| Source | What it gives | Rightsizing |
| --- | --- | --- |
| **Prometheus** or **VictoriaMetrics** | a day of history: CPU at its 95th percentile, memory at its peak (cAdvisor) | tips, and **Apply** |
| **metrics-server** | one reading, right now | tips with stricter thresholds, no Apply |
| neither | — | the rules say what they need; a tip under *Observability* says what to install |

None of this is an error: a cluster without monitoring is an ordinary cluster, and
every other rule works without it. K8s Dockside finds Prometheus and VictoriaMetrics
(a `vmsingle`, or a cluster's `vmselect`) by itself; if yours is not found, set its
address in the cluster's settings. The two queries are in `plugin.json` under `charts`.

## The score

```
score = 100 × Σ weight × (checked − open) / checked  ÷  Σ weight
```

over the rules that are switched on, could look, and had something to check. A
high-severity rule weighs 5, medium 3, low 1. An accepted finding counts as passing
but stays listed; a rule switched off drops out. A rule that cannot look — a kind it
may not read, no usage data, a single node — is shown as such and left out, never
counted as passing. Grades: A ≥ 90, B ≥ 75, C ≥ 60, D ≥ 40, E below.

System namespaces (`kube-*`, `*-system`) are left out unless you tick *Include system
namespaces*.

## Your choices

- Live at once, and kept in the tab's address while you switch tabs.
- **Save to cluster** writes them to the ConfigMap `default/k8sdockside-optimization`
  (key `settings.json`), so they are there next time and for everyone else using the
  cluster. That is why the plugin declares `configmaps`: it only ever reads that one.
- To opt an object out in Git instead, annotate it (or its namespace):

  ```yaml
  metadata:
    annotations:
      optimization.k8sdockside.io/ignore: "single-replica,pdb-missing"   # or "*"
  ```

## Rules

| Category | Rule | Severity | Default |
| --- | --- | --- | --- |
| Requests & limits | `requests-missing` containers without CPU or memory requests | high | on |
| | `memory-limit-missing` containers without a memory limit | medium | on |
| | `memory-limit-ratio` memory limit more than 4× the request | low | on |
| | `cpu-limits` CPU limits set (they throttle) | low | off |
| | `namespace-limitrange` namespaces with workloads and no LimitRange | low | on |
| | `namespace-quota` namespaces with workloads and no ResourceQuota | low | off |
| Rightsizing | `cpu-overprovisioned` CPU request > 3× the p95 (5× from one reading) | medium | on |
| | `memory-overprovisioned` memory request > 2× the peak (3× from one reading) | medium | on |
| | `cpu-underprovisioned` CPU use > 1.5× the request | medium | on |
| | `memory-underprovisioned` memory use > 1.5× the request | medium | on |
| | `memory-near-limit` memory use at 90% of the limit | high | on |
| Reliability | `single-replica` one replica, not kept higher by an autoscaler | medium | on |
| | `pdb-missing` 2+ replicas and no PodDisruptionBudget | medium | on |
| | `pdb-blocking` a budget allowing 0 disruptions with every pod healthy | high | on |
| | `readiness-probe` Deployment/StatefulSet containers without one | medium | on |
| | `liveness-probe` containers without one | low | off |
| | `topology-spread` 2+ replicas with no spread or anti-affinity | low | on |
| | `image-latest` `:latest` or untagged images | medium | on |
| | `oom-killed` containers killed for memory | high | on |
| | `crash-restarts` 5+ restarts, or CrashLoopBackOff | medium | on |
| Autoscaling | `hpa-no-requests` HPA on CPU/memory whose target has no such request | high | on |
| | `hpa-at-max` HPA at maxReplicas | medium | on |
| | `hpa-fixed` HPA with min = max | low | on |
| Waste | `pvc-pending` claims pending over 10 minutes | medium | on |
| | `pvc-unused` bound claims no running pod mounts | low | on |
| | `pv-released` Released volumes | low | on |
| | `scaled-to-zero` Deployments/StatefulSets at 0 replicas | low | on |
| | `jobs-no-ttl` Jobs finished over a day ago without ttlSecondsAfterFinished | low | on |
| | `service-no-pods` Services whose selector matches no running pod | low | on |
| Nodes | `node-requests-high` over 90% of CPU or memory requested | medium | on |
| | `node-idle` under 20% of both requested (3+ nodes) | low | on |
| | `node-memory-overcommit` memory limits over 150% of the node | medium | on |
| Security basics | `privileged` privileged containers | high | on |
| | `run-as-non-root` containers that may run as root | low | off |
| | `automount-token` service account tokens mounted by default | low | off |
| Observability | `metrics-source` usage history for rightsizing (the tip above) | low | on |

The thresholds are in [`src/model/rules.ts`](src/model/rules.ts) and
[`src/model/resources.ts`](src/model/resources.ts). A suggested request is the p95
(CPU) or peak (memory) plus 30% headroom, rounded up.

## Developing

```sh
npm ci
npm run build      # src/ -> ui/ (commit ui/: installing clones, it does not build)
npm run watch      # rebuild on change; reopen the tab to see it
npm test           # the rules, the score, usage parsing, the patch
npm run check      # typecheck + tests + ui/ matches a fresh build (what CI runs)
```

To try it in the app without publishing, copy or symlink this folder into the plugins
folder shown under **Settings → Plugins**, or use **Settings → Plugins → From a
folder**. The layout is the same as the
[TypeScript example plugin](https://github.com/k8sdockside/image-inventory):
`src/model` is plain logic with tests, `src/ui` draws, `src/pages` are the two pages.
