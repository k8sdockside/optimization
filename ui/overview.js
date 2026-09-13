// Built by scripts/build.mjs from src/ -- edit the TypeScript there, not this file.
"use strict";
(() => {
  // src/model/kube.ts
  function controllerOf(obj) {
    const owners = obj.metadata.ownerReferences ?? [];
    return owners.find((o) => o.controller) ?? owners[0] ?? null;
  }
  function time(text) {
    const t = Date.parse(text ?? "");
    return Number.isFinite(t) ? t : 0;
  }

  // src/model/inventory.ts
  var APP_KIND = {
    Deployment: "deployments",
    StatefulSet: "statefulsets",
    DaemonSet: "daemonsets",
    CronJob: "cronjobs",
    Job: "jobs",
    Pod: "pods",
    Node: "nodes",
    Namespace: "namespaces",
    Service: "services",
    HorizontalPodAutoscaler: "horizontalpodautoscalers",
    PodDisruptionBudget: "poddisruptionbudgets",
    PersistentVolumeClaim: "persistentvolumeclaims",
    PersistentVolume: "persistentvolumes"
  };
  function workloadKey(kind, namespace, name) {
    return `${kind}/${namespace}/${name}`;
  }
  function buildInventory(input) {
    const workloads2 = [];
    const byKey = /* @__PURE__ */ new Map();
    const put = (kind, obj, template, replicas) => {
      const namespace = obj.metadata.namespace ?? "";
      const name = obj.metadata.name;
      const info = { kind, namespace, name, key: workloadKey(kind, namespace, name), obj, template: template ?? {}, replicas, pods: [] };
      workloads2.push(info);
      byKey.set(info.key, info);
    };
    for (const d of input.deployments) put("Deployment", d, d.spec?.template, d.spec?.replicas ?? 1);
    for (const s of input.statefulsets) put("StatefulSet", s, s.spec?.template, s.spec?.replicas ?? 1);
    for (const d of input.daemonsets) put("DaemonSet", d, d.spec?.template, null);
    for (const c of input.cronjobs) put("CronJob", c, c.spec?.jobTemplate?.spec?.template, null);
    const cronOfJob = /* @__PURE__ */ new Map();
    for (const j of input.jobs) {
      const owner = controllerOf(j);
      if (owner?.kind === "CronJob") cronOfJob.set(`${j.metadata.namespace ?? ""}/${j.metadata.name}`, owner.name);
      else put("Job", j, j.spec?.template, null);
    }
    const ownerOfPod = /* @__PURE__ */ new Map();
    for (const pod of input.pods) {
      const namespace = pod.metadata.namespace ?? "";
      const key = ownerKey(pod, namespace, cronOfJob);
      const info = key ? byKey.get(key) : void 0;
      if (!info) continue;
      info.pods.push(pod);
      ownerOfPod.set(`${namespace}/${pod.metadata.name}`, info);
    }
    return { workloads: workloads2, byKey, ownerOfPod };
  }
  function ownerKey(pod, namespace, cronOfJob) {
    const owner = controllerOf(pod);
    if (!owner) return null;
    switch (owner.kind) {
      case "ReplicaSet": {
        const hash = pod.metadata.labels?.["pod-template-hash"];
        if (!hash || !owner.name.endsWith("-" + hash)) return null;
        return workloadKey("Deployment", namespace, owner.name.slice(0, -(hash.length + 1)));
      }
      case "StatefulSet":
      case "DaemonSet":
        return workloadKey(owner.kind, namespace, owner.name);
      case "Job": {
        const cron = cronOfJob.get(`${namespace}/${owner.name}`);
        return cron ? workloadKey("CronJob", namespace, cron) : workloadKey("Job", namespace, owner.name);
      }
      default:
        return null;
    }
  }
  function active(pod) {
    const phase = pod.status?.phase;
    return phase !== "Succeeded" && phase !== "Failed" && !pod.metadata.deletionTimestamp;
  }

  // src/model/cluster.ts
  var SNAPSHOT_KINDS = [
    "pods",
    "deployments",
    "statefulsets",
    "daemonsets",
    "cronjobs",
    "jobs",
    "nodes",
    "namespaces",
    "services",
    "horizontalpodautoscalers",
    "poddisruptionbudgets",
    "persistentvolumeclaims",
    "persistentvolumes",
    "limitranges",
    "resourcequotas"
  ];
  function emptySnapshot() {
    const snap = { missing: /* @__PURE__ */ new Map() };
    for (const kind of SNAPSHOT_KINDS) snap[kind] = [];
    return snap;
  }
  function isSystemNamespace(namespace) {
    return namespace.startsWith("kube-") || namespace.endsWith("-system");
  }
  function buildCluster(snap, usage, opts) {
    const inventory = buildInventory(snap);
    const objects = /* @__PURE__ */ new Map();
    for (const kind of SNAPSHOT_KINDS) {
      for (const obj of snap[kind]) {
        objects.set(`${kind}/${obj.metadata.namespace ?? ""}/${obj.metadata.name}`, obj);
      }
    }
    return {
      ...snap,
      inventory,
      usage,
      now: opts.now ?? Date.now(),
      inScope: (namespace) => !namespace || opts.system || !isSystemNamespace(namespace),
      annotationsOf: (kind, namespace, name) => objects.get(`${kind}/${namespace}/${name}`)?.metadata.annotations
    };
  }

  // src/model/quantity.ts
  var BINARY = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
  var DECIMAL = { n: 1e-9, u: 1e-6, m: 1e-3, "": 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
  var SHAPE = /^([+-]?(?:\d+\.?\d*|\.\d+))(?:([eE][+-]?\d+)|(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|M|G|T|P|E))?$/;
  function parseQuantity(text) {
    if (typeof text === "number") return text;
    if (!text) return NaN;
    const match = SHAPE.exec(text.trim());
    if (!match) return NaN;
    const value = Number(match[1]);
    if (match[2]) return value * 10 ** Number(match[2].slice(1));
    const suffix = match[3] ?? "";
    return value * (BINARY[suffix] ?? DECIMAL[suffix] ?? NaN);
  }
  var MI = 2 ** 20;
  function formatCpu(cores) {
    if (!Number.isFinite(cores)) return "—";
    if (cores < 1) return `${Math.max(Math.round(cores * 1e3), cores > 0 ? 1 : 0)}m`;
    return String(Math.round(cores * 100) / 100);
  }
  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "—";
    const units = ["", "Ki", "Mi", "Gi", "Ti"];
    let n = bytes;
    let i = 0;
    while (Math.abs(n) >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    const text = n >= 100 || i === 0 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
    return text + units[i];
  }
  function cpuQuantity(cores) {
    const milli = Math.max(1, Math.ceil(cores * 1e3));
    const step = milli < 1e3 ? 5 : 50;
    return `${Math.ceil(milli / step) * step}m`;
  }
  function memoryQuantity(bytes) {
    const mi = Math.max(16, Math.ceil(bytes / MI));
    return `${Math.ceil(mi / 16) * 16}Mi`;
  }

  // src/model/usage.ts
  var CPU_CHART = "usage-cpu-p95";
  var MEMORY_CHART = "usage-memory-peak";
  function containerKey(namespace, pod, container) {
    return `${namespace}/${pod}/${container}`;
  }
  function noUsage(note) {
    return { source: "none", where: "", byContainer: /* @__PURE__ */ new Map(), note };
  }
  function usageFromCharts(panel) {
    const source = panel.source;
    if (!source.available) {
      return { problem: source.error ? `could not look for Prometheus: ${source.error}` : "no Prometheus or VictoriaMetrics was found in this cluster" };
    }
    const cpu = panel.charts.find((c) => c.id === CPU_CHART);
    const memory = panel.charts.find((c) => c.id === MEMORY_CHART);
    const where = source.describe;
    if ((!cpu || cpu.error) && (!memory || memory.error)) {
      return { problem: `${where} did not answer: ${cpu?.error || memory?.error || "no charts came back"}` };
    }
    const byContainer = /* @__PURE__ */ new Map();
    const read = (chart, field) => {
      for (const series of chart?.series ?? []) {
        const value = latest(series.points);
        if (!series.name || !Number.isFinite(value)) continue;
        const entry = byContainer.get(series.name) ?? { cpu: NaN, memory: NaN };
        entry[field] = value;
        byContainer.set(series.name, entry);
      }
    };
    read(cpu, "cpu");
    read(memory, "memory");
    if (!byContainer.size) {
      return { problem: `${where} answered, but has no per-container metrics (cAdvisor's container_cpu_usage_seconds_total and container_memory_working_set_bytes are not scraped)` };
    }
    const partial = cpu?.error ? `CPU history failed (${cpu.error}); ` : memory?.error ? `memory history failed (${memory.error}); ` : "";
    return { usage: { source: "prometheus", where, byContainer, note: partial ? partial + "the rest is from " + where : "" } };
  }
  function latest(points) {
    for (let i = points.length - 1; i >= 0; i--) {
      const v = points[i].v;
      if (Number.isFinite(v)) return v;
    }
    return NaN;
  }
  function usageFromPodMetrics(items, note) {
    const byContainer = /* @__PURE__ */ new Map();
    for (const item of items) {
      const namespace = item.metadata.namespace ?? "";
      for (const c of item.containers ?? []) {
        byContainer.set(containerKey(namespace, item.metadata.name, c.name), {
          cpu: parseQuantity(c.usage?.cpu),
          memory: parseQuantity(c.usage?.memory)
        });
      }
    }
    return { source: "metrics-server", where: "metrics-server", byContainer, note };
  }

  // src/model/resources.ts
  var MI2 = 2 ** 20;
  var HEADROOM = 1.3;
  var MIN_CPU = 0.01;
  var MIN_MEMORY = 32 * MI2;
  var CPU_FLOOR = 0.1;
  var MEMORY_FLOOR = 128 * MI2;
  function effectiveContainers(w) {
    const pod = w.pods.find(active);
    return pod?.spec?.containers ?? w.template.spec?.containers ?? [];
  }
  function templateContainers(w) {
    return w.template.spec?.containers ?? [];
  }
  function requestOf(c, resource) {
    const r = parseQuantity(c.resources?.requests?.[resource]);
    return Number.isFinite(r) ? r : parseQuantity(c.resources?.limits?.[resource]);
  }
  function limitOf(c, resource) {
    return parseQuantity(c.resources?.limits?.[resource]);
  }
  function observed(w, usage) {
    const out = /* @__PURE__ */ new Map();
    for (const pod of w.pods) {
      if (!active(pod)) continue;
      for (const c of pod.spec?.containers ?? []) {
        const u = usage.byContainer.get(containerKey(w.namespace, pod.metadata.name, c.name));
        if (!u) continue;
        const entry = out.get(c.name) ?? { cpu: NaN, memory: NaN, pods: 0 };
        entry.cpu = higher(entry.cpu, u.cpu);
        entry.memory = higher(entry.memory, u.memory);
        entry.pods++;
        out.set(c.name, entry);
      }
    }
    return out;
  }
  function higher(a, b) {
    if (!Number.isFinite(a)) return b;
    if (!Number.isFinite(b)) return a;
    return Math.max(a, b);
  }
  function cpuVerdict(request, used, history2) {
    if (!Number.isFinite(used) || !Number.isFinite(request)) return "unknown";
    if (request >= CPU_FLOOR && used * (history2 ? 3 : 5) < request) return "over";
    if (request > 0 && used > request * (history2 ? 1.5 : 2)) return "under";
    return "ok";
  }
  function memoryVerdict(request, limit, used, history2) {
    if (!Number.isFinite(used)) return "unknown";
    if (Number.isFinite(limit) && used >= 0.9 * limit) return "near-limit";
    if (!Number.isFinite(request)) return "unknown";
    if (request >= MEMORY_FLOOR && used * (history2 ? 2 : 3) < request) return "over";
    if (request > 0 && used > request * (history2 ? 1.5 : 2)) return "under";
    return "ok";
  }
  function recommendCpu(used) {
    return Math.max(used * HEADROOM, MIN_CPU);
  }
  function recommendMemory(used) {
    return Math.max(used * HEADROOM, MIN_MEMORY);
  }

  // src/model/selector.ts
  function matches(selector, labels) {
    if (!selector) return false;
    const have = labels ?? {};
    for (const [key, value] of Object.entries(selector.matchLabels ?? {})) {
      if (have[key] !== value) return false;
    }
    for (const req of selector.matchExpressions ?? []) {
      const present = Object.prototype.hasOwnProperty.call(have, req.key);
      const value = have[req.key];
      switch (req.operator) {
        case "In":
          if (!present || !(req.values ?? []).includes(value ?? "")) return false;
          break;
        case "NotIn":
          if (present && (req.values ?? []).includes(value ?? "")) return false;
          break;
        case "Exists":
          if (!present) return false;
          break;
        case "DoesNotExist":
          if (present) return false;
          break;
        default:
          return false;
      }
    }
    return true;
  }
  function matchesMap(selector, labels) {
    const entries = Object.entries(selector ?? {});
    if (!entries.length) return false;
    const have = labels ?? {};
    return entries.every(([key, value]) => have[key] === value);
  }

  // src/model/rules.ts
  var CATEGORIES = [
    { id: "resources", label: "Requests & limits" },
    { id: "usage", label: "Rightsizing" },
    { id: "reliability", label: "Reliability" },
    { id: "scaling", label: "Autoscaling" },
    { id: "waste", label: "Waste" },
    { id: "nodes", label: "Nodes" },
    { id: "security", label: "Security basics" },
    { id: "observability", label: "Observability" }
  ];
  var WEIGHT = { high: 5, medium: 3, low: 1 };
  var SEVERITY_RANK = { high: 0, medium: 1, low: 2 };
  function bySeverity(a, b) {
    return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  }
  function workloadTarget(w, container) {
    return { kind: APP_KIND[w.kind] ?? "", namespace: w.namespace, name: w.name, label: `${w.kind} ${w.namespace}/${w.name}`, container };
  }
  function objectTarget(kind, obj) {
    const namespace = obj.metadata.namespace ?? "";
    return { kind: APP_KIND[kind] ?? "", namespace, name: obj.metadata.name, label: `${kind} ${namespace ? namespace + "/" : ""}${obj.metadata.name}` };
  }
  var CLUSTER = { kind: "", namespace: "", name: "", label: "This cluster" };
  function finding(rule, target, detail, extra = {}) {
    const key = `${rule}:${target.kind}/${target.namespace}/${target.name}${target.container ? "/" + target.container : ""}`;
    return { rule, key, target, detail, ...extra };
  }
  function workloads(c, kinds) {
    return c.inventory.workloads.filter((w) => c.inScope(w.namespace) && (!kinds || kinds.includes(w.kind)));
  }
  function scoped(c, list) {
    return list.filter((o) => c.inScope(o.metadata.namespace ?? ""));
  }
  var has = (q) => Number.isFinite(parseQuantity(q));
  function perContainer(id, kinds, containers, check) {
    return (cl) => {
      const list = workloads(cl, kinds);
      const findings = [];
      for (const w of list) {
        const problems = containers(w).map((ct) => {
          const p = check(ct);
          return p ? `${ct.name}: ${p}` : null;
        }).filter((p) => p !== null);
        if (problems.length) findings.push(finding(id, workloadTarget(w), problems.join("; ")));
      }
      return { eligible: list.length, findings };
    };
  }
  function replicated(c, min) {
    return workloads(c, ["Deployment", "StatefulSet"]).filter((w) => (w.replicas ?? 0) >= min);
  }
  function schedulableNodes(c) {
    return c.nodes.filter((n) => !n.spec?.unschedulable).length;
  }
  function imageTag(image) {
    const at = image.indexOf("@");
    const digest = at >= 0;
    const name = digest ? image.slice(0, at) : image;
    const slash = name.lastIndexOf("/");
    const colon = name.lastIndexOf(":");
    return { tag: colon > slash ? name.slice(colon + 1) : "", digest };
  }
  function nodeLoads(c) {
    const out = /* @__PURE__ */ new Map();
    for (const pod of c.pods) {
      const node = pod.spec?.nodeName;
      if (!node || !active(pod)) continue;
      const load = out.get(node) ?? { cpu: 0, memory: 0, memoryLimits: 0, pods: 0 };
      for (const ct of pod.spec?.containers ?? []) {
        load.cpu += requestOf(ct, "cpu") || 0;
        load.memory += requestOf(ct, "memory") || 0;
        load.memoryLimits += limitOf(ct, "memory") || 0;
      }
      load.pods++;
      out.set(node, load);
    }
    return out;
  }
  function pct(part, whole) {
    return `${Math.round(part / whole * 100)}%`;
  }
  var PATCHABLE = /* @__PURE__ */ new Set(["Deployment", "StatefulSet", "DaemonSet", "CronJob"]);
  function sized(c) {
    const out = [];
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
  function resourceFix(s, change2) {
    if (!PATCHABLE.has(s.w.kind)) return void 0;
    const fix = { kind: s.w.kind, namespace: s.w.namespace, name: s.w.name, container: s.container.name, requests: {}, limits: {} };
    for (const resource of ["cpu", "memory"]) {
      const req = change2.requests?.[resource];
      let lim = change2.limits?.[resource];
      const currentLimit = limitOf(s.container, resource);
      if (req !== void 0 && lim === void 0 && Number.isFinite(currentLimit) && req > currentLimit) lim = req;
      const quantity = resource === "cpu" ? cpuQuantity : memoryQuantity;
      if (req !== void 0) fix.requests[resource] = quantity(req);
      if (lim !== void 0) fix.limits[resource] = quantity(lim);
      const currentRequest = requestOf(s.container, resource);
      if (lim !== void 0 && req === void 0 && Number.isFinite(currentRequest) && currentRequest > lim) fix.requests[resource] = quantity(lim);
    }
    return fix;
  }
  function sizingRule(id, resource, verdict, build) {
    return (c) => {
      if (c.usage.source === "none") return { eligible: 0, findings: [], unavailable: "Needs usage data — Prometheus, VictoriaMetrics or metrics-server. See the tip under Observability." };
      const history2 = c.usage.source === "prometheus";
      let eligible = 0;
      const findings = [];
      for (const s of sized(c)) {
        const req = requestOf(s.container, resource);
        const v = resource === "cpu" ? cpuVerdict(req, s.seen.cpu, history2) : memoryVerdict(req, limitOf(s.container, "memory"), s.seen.memory, history2);
        if (v === "unknown") continue;
        eligible++;
        if (v !== verdict) continue;
        const built = build(s, history2);
        findings.push(finding(id, workloadTarget(s.w, s.container.name), built.detail, { fix: history2 ? built.fix : void 0, saving: built.saving }));
      }
      return { eligible, findings };
    };
  }
  function usedText(history2) {
    return history2 ? "over the last day" : "right now (one reading from metrics-server)";
  }
  function podCount(s) {
    return Math.max(1, s.w.pods.filter(active).length);
  }
  var RULES = [
    // --- requests & limits
    {
      id: "requests-missing",
      title: "Containers without CPU or memory requests",
      category: "resources",
      severity: "high",
      defaultOn: true,
      why: "The scheduler places pods by their requests. A container without them is placed as if it needed nothing, lands on nodes that are already full, and is the first to be evicted when memory runs short.",
      how: "Set resources.requests.cpu and resources.requests.memory on every container — the Rightsizing view suggests values from real usage — or give the namespace a LimitRange with defaults.",
      run: perContainer("requests-missing", void 0, effectiveContainers, (ct) => {
        const missing = ["cpu", "memory"].filter((r) => !Number.isFinite(requestOf(ct, r)));
        return missing.length ? `no ${missing.join(" or ")} request` : null;
      })
    },
    {
      id: "memory-limit-missing",
      title: "Containers without a memory limit",
      category: "resources",
      severity: "medium",
      defaultOn: true,
      why: "Memory cannot be taken back once it is used. A container with no limit can grow until the node itself runs out, and then the kernel picks what to kill — possibly something else.",
      how: "Set resources.limits.memory, a little above the peak you see in Rightsizing.",
      run: perContainer("memory-limit-missing", void 0, effectiveContainers, (ct) => has(ct.resources?.limits?.memory) ? null : "no memory limit")
    },
    {
      id: "memory-limit-ratio",
      title: "Memory limits far above requests",
      category: "resources",
      severity: "low",
      defaultOn: true,
      why: "The scheduler plans for the request; the limit is what the container may actually take. A limit many times the request overcommits the node, and under pressure those pods are killed first.",
      how: "Bring the memory request closer to the limit — at most four times smaller — or lower the limit.",
      run: perContainer("memory-limit-ratio", void 0, effectiveContainers, (ct) => {
        const req = parseQuantity(ct.resources?.requests?.memory);
        const lim = parseQuantity(ct.resources?.limits?.memory);
        if (!(req > 0) || !(lim > 0) || lim <= req * 4) return null;
        return `limit ${formatBytes(lim)} is ${Math.round(lim / req)}× the ${formatBytes(req)} request`;
      })
    },
    {
      id: "cpu-limits",
      title: "CPU limits set",
      category: "resources",
      severity: "low",
      defaultOn: false,
      why: "A CPU limit throttles a container even when the node has CPU to spare, which shows up as latency rather than as an error. Many teams set requests only and leave CPU unlimited; others want limits for fairness. Off by default for that reason.",
      how: "Remove resources.limits.cpu, keeping a CPU request that matches real use.",
      run: perContainer("cpu-limits", void 0, effectiveContainers, (ct) => has(ct.resources?.limits?.cpu) ? `CPU limit ${formatCpu(parseQuantity(ct.resources?.limits?.cpu))}` : null)
    },
    {
      id: "namespace-limitrange",
      title: "Namespaces without a LimitRange",
      category: "resources",
      severity: "low",
      defaultOn: true,
      needs: ["limitranges", "namespaces"],
      why: "A LimitRange gives containers default requests and limits when they set none, so one forgotten manifest does not become a pod the scheduler knows nothing about.",
      how: "Add a LimitRange with default and defaultRequest for cpu and memory to namespaces that run workloads.",
      run: (c) => {
        const withWorkloads = new Set(workloads(c).map((w) => w.namespace));
        const covered = new Set(c.limitranges.map((l) => l.metadata.namespace ?? ""));
        const list = scoped(c, c.namespaces).filter((ns) => withWorkloads.has(ns.metadata.name));
        const findings = list.filter((ns) => !covered.has(ns.metadata.name)).map((ns) => finding("namespace-limitrange", objectTarget("Namespace", ns), "runs workloads and has no LimitRange"));
        return { eligible: list.length, findings };
      }
    },
    {
      id: "namespace-quota",
      title: "Namespaces without a ResourceQuota",
      category: "resources",
      severity: "low",
      defaultOn: false,
      needs: ["resourcequotas", "namespaces"],
      why: "A ResourceQuota caps what one namespace can ask for, so one team or one runaway deployment cannot take the whole cluster. Mostly useful on shared clusters; off by default.",
      how: "Add a ResourceQuota with requests.cpu, requests.memory and limits.memory to each namespace.",
      run: (c) => {
        const withWorkloads = new Set(workloads(c).map((w) => w.namespace));
        const covered = new Set(c.resourcequotas.map((q) => q.metadata.namespace ?? ""));
        const list = scoped(c, c.namespaces).filter((ns) => withWorkloads.has(ns.metadata.name));
        const findings = list.filter((ns) => !covered.has(ns.metadata.name)).map((ns) => finding("namespace-quota", objectTarget("Namespace", ns), "runs workloads and has no ResourceQuota"));
        return { eligible: list.length, findings };
      }
    },
    // --- rightsizing
    {
      id: "cpu-overprovisioned",
      title: "CPU requests far above use",
      category: "usage",
      severity: "medium",
      defaultOn: true,
      usage: true,
      why: "A CPU request is reserved on the node whether it is used or not. Requests far above use make the cluster look full while its CPUs idle, and that is paid for in nodes.",
      how: "Lower the request to the 95th percentile of use plus headroom. With Prometheus or VictoriaMetrics, Apply does it for you.",
      run: sizingRule("cpu-overprovisioned", "cpu", "over", (s, history2) => {
        const req = requestOf(s.container, "cpu");
        const rec = recommendCpu(s.seen.cpu);
        return {
          detail: `asks for ${formatCpu(req)}, uses ${formatCpu(s.seen.cpu)} ${usedText(history2)} — ${formatCpu(parseQuantity(cpuQuantity(rec)))} would do`,
          fix: resourceFix(s, { requests: { cpu: rec } }),
          saving: { cpu: (req - rec) * podCount(s), memory: 0 }
        };
      })
    },
    {
      id: "memory-overprovisioned",
      title: "Memory requests far above use",
      category: "usage",
      severity: "medium",
      defaultOn: true,
      usage: true,
      why: "Requested memory is set aside on the node. Requests far above the peak keep other pods off nodes that have memory to spare.",
      how: "Lower the request to the day’s peak plus headroom. With Prometheus or VictoriaMetrics, Apply does it for you.",
      run: sizingRule("memory-overprovisioned", "memory", "over", (s, history2) => {
        const req = requestOf(s.container, "memory");
        const rec = recommendMemory(s.seen.memory);
        return {
          detail: `asks for ${formatBytes(req)}, uses ${formatBytes(s.seen.memory)} ${history2 ? "at its peak " : ""}${usedText(history2)} — ${memoryQuantity(rec)} would do`,
          fix: resourceFix(s, { requests: { memory: rec } }),
          saving: { cpu: 0, memory: (req - rec) * podCount(s) }
        };
      })
    },
    {
      id: "cpu-underprovisioned",
      title: "CPU requests below use",
      category: "usage",
      severity: "medium",
      defaultOn: true,
      usage: true,
      why: "A container that uses more CPU than it asks for is placed on nodes as if it were small; when the node is busy it gets only its share of the request, and slows down.",
      how: "Raise the CPU request to the 95th percentile of use plus headroom.",
      run: sizingRule("cpu-underprovisioned", "cpu", "under", (s, history2) => {
        const req = requestOf(s.container, "cpu");
        const rec = recommendCpu(s.seen.cpu);
        const lim = limitOf(s.container, "cpu");
        return {
          detail: `asks for ${formatCpu(req)}, uses ${formatCpu(s.seen.cpu)} ${usedText(history2)}${Number.isFinite(lim) ? `; its ${formatCpu(lim)} limit throttles it` : ""}`,
          fix: resourceFix(s, { requests: { cpu: rec } }),
          saving: { cpu: (req - rec) * podCount(s), memory: 0 }
        };
      })
    },
    {
      id: "memory-underprovisioned",
      title: "Memory requests below use",
      category: "usage",
      severity: "medium",
      defaultOn: true,
      usage: true,
      why: "Pods using more memory than they request are the first the kubelet evicts when a node runs short, and they let the scheduler pack a node tighter than it can hold.",
      how: "Raise the memory request to the day’s peak plus headroom.",
      run: sizingRule("memory-underprovisioned", "memory", "under", (s, history2) => {
        const req = requestOf(s.container, "memory");
        const rec = recommendMemory(s.seen.memory);
        return {
          detail: `asks for ${formatBytes(req)}, uses ${formatBytes(s.seen.memory)} ${usedText(history2)}`,
          fix: resourceFix(s, { requests: { memory: rec } }),
          saving: { cpu: 0, memory: (req - rec) * podCount(s) }
        };
      })
    },
    {
      id: "memory-near-limit",
      title: "Memory close to the limit",
      category: "usage",
      severity: "high",
      defaultOn: true,
      usage: true,
      why: "A container that reaches its memory limit is killed (OOMKilled) and restarted. At 90% of the limit that is one busy moment away.",
      how: "Raise the memory limit above the peak with headroom, or find out why it grows.",
      run: sizingRule("memory-near-limit", "memory", "near-limit", (s, history2) => {
        const lim = limitOf(s.container, "memory");
        const rec = recommendMemory(s.seen.memory);
        return {
          detail: `uses ${formatBytes(s.seen.memory)} of its ${formatBytes(lim)} limit ${usedText(history2)} (${pct(s.seen.memory, lim)})`,
          fix: resourceFix(s, { limits: { memory: rec } })
        };
      })
    },
    // --- reliability
    {
      id: "single-replica",
      title: "Workloads with a single replica",
      category: "reliability",
      severity: "medium",
      defaultOn: true,
      needs: ["horizontalpodautoscalers"],
      why: "One replica means every node drain, upgrade or crash is an outage, however short.",
      how: "Run at least two replicas (and a PodDisruptionBudget), or accept the finding for things that may be down now and then.",
      run: (c) => {
        const scaled = new Set(
          c.horizontalpodautoscalers.filter((h) => (h.spec?.minReplicas ?? 1) > 1).map((h) => `${h.spec?.scaleTargetRef?.kind}/${h.metadata.namespace}/${h.spec?.scaleTargetRef?.name}`)
        );
        const list = replicated(c, 1);
        const findings = list.filter((w) => w.replicas === 1 && !scaled.has(w.key)).map((w) => finding("single-replica", workloadTarget(w), "runs one replica"));
        return { eligible: list.length, findings };
      }
    },
    {
      id: "pdb-missing",
      title: "Replicated workloads without a PodDisruptionBudget",
      category: "reliability",
      severity: "medium",
      defaultOn: true,
      needs: ["poddisruptionbudgets"],
      why: "Without a PodDisruptionBudget a node drain may evict every replica at once, and the service goes down even though it runs several.",
      how: "Add a PodDisruptionBudget with maxUnavailable: 1 selecting the workload’s pods.",
      run: (c) => {
        const list = replicated(c, 2);
        const findings = list.filter((w) => !c.poddisruptionbudgets.some((p) => p.metadata.namespace === w.namespace && matches(p.spec?.selector, w.template.metadata?.labels))).map((w) => finding("pdb-missing", workloadTarget(w), `${w.replicas} replicas, no PodDisruptionBudget`));
        return { eligible: list.length, findings };
      }
    },
    {
      id: "pdb-blocking",
      title: "PodDisruptionBudgets that block every eviction",
      category: "reliability",
      severity: "high",
      defaultOn: true,
      needs: ["poddisruptionbudgets"],
      why: "A budget that allows no disruptions while every pod is healthy — minAvailable equal to the replicas, or maxUnavailable: 0 — makes node drains hang. Upgrades and autoscaler scale-downs stall on it.",
      how: "Allow at least one disruption: maxUnavailable: 1, or minAvailable below the replica count.",
      run: (c) => {
        const list = scoped(c, c.poddisruptionbudgets).filter((p) => (p.status?.expectedPods ?? 0) > 0);
        const findings = list.filter((p) => p.status?.disruptionsAllowed === 0 && (p.status?.currentHealthy ?? 0) >= (p.status?.desiredHealthy ?? Infinity)).map((p) => finding("pdb-blocking", objectTarget("PodDisruptionBudget", p), `allows 0 disruptions with all ${p.status?.currentHealthy} pods healthy`));
        return { eligible: list.length, findings };
      }
    },
    {
      id: "readiness-probe",
      title: "Containers without a readiness probe",
      category: "reliability",
      severity: "medium",
      defaultOn: true,
      why: "Without a readiness probe a pod gets traffic the moment its process starts, before it can answer, and keeps getting it when it stops answering. Rollouts drop requests.",
      how: "Add a readinessProbe that checks the container can serve — an HTTP health endpoint or a TCP port.",
      run: perContainer("readiness-probe", ["Deployment", "StatefulSet"], templateContainers, (ct) => ct.readinessProbe ? null : "no readiness probe")
    },
    {
      id: "liveness-probe",
      title: "Containers without a liveness probe",
      category: "reliability",
      severity: "low",
      defaultOn: false,
      why: "A liveness probe restarts a container that is running but stuck. Useful for processes that can hang; harmful when it is too strict. Off by default.",
      how: "Add a livenessProbe with generous timeouts, and a startupProbe for slow starters.",
      run: perContainer("liveness-probe", ["Deployment", "StatefulSet", "DaemonSet"], templateContainers, (ct) => ct.livenessProbe ? null : "no liveness probe")
    },
    {
      id: "topology-spread",
      title: "Replicas that may all land on one node",
      category: "reliability",
      severity: "low",
      defaultOn: true,
      needs: ["nodes"],
      why: "Several replicas on one node are one replica as far as that node failing is concerned. Without spread constraints or anti-affinity the scheduler may put them together.",
      how: "Add topologySpreadConstraints on kubernetes.io/hostname (and topology.kubernetes.io/zone if you have zones), or a preferred podAntiAffinity.",
      run: (c) => {
        if (schedulableNodes(c) < 2) return { eligible: 0, findings: [], unavailable: "Only one schedulable node: there is nowhere to spread to." };
        const list = replicated(c, 2);
        const findings = [];
        for (const w of list) {
          const spec = w.template.spec;
          if (spec?.topologySpreadConstraints?.length || spec?.affinity?.podAntiAffinity) continue;
          const nodes = new Set(w.pods.filter(active).map((p) => p.spec?.nodeName).filter(Boolean));
          const running = w.pods.filter(active).length;
          const detail = running > 1 && nodes.size === 1 ? `all ${running} pods run on ${[...nodes][0]}` : "no spread constraint or anti-affinity";
          findings.push(finding("topology-spread", workloadTarget(w), detail));
        }
        return { eligible: list.length, findings };
      }
    },
    {
      id: "image-latest",
      title: "Images on :latest or with no tag",
      category: "reliability",
      severity: "medium",
      defaultOn: true,
      why: "What :latest runs depends on when each node pulled it: two replicas may run two builds, and a rollback goes nowhere.",
      how: "Use a version tag, or better a digest (image@sha256:…).",
      run: perContainer("image-latest", void 0, templateContainers, (ct) => {
        const { tag, digest } = imageTag(ct.image ?? "");
        if (digest) return null;
        if (!tag) return `${ct.image} has no tag (means :latest)`;
        return tag === "latest" ? `${ct.image}` : null;
      })
    },
    {
      id: "oom-killed",
      title: "Containers killed for running out of memory",
      category: "reliability",
      severity: "high",
      defaultOn: true,
      why: "OOMKilled means the container reached its memory limit and the kernel killed it. It restarts, and whatever it was doing is lost.",
      how: "Raise the memory limit (and request) above the real peak, or fix what makes it grow.",
      run: (c) => {
        const list = workloads(c).filter((w) => w.pods.length > 0);
        const findings = [];
        for (const w of list) {
          const hit = /* @__PURE__ */ new Map();
          for (const pod of w.pods) {
            for (const s of pod.status?.containerStatuses ?? []) {
              if (s.lastState?.terminated?.reason === "OOMKilled" || s.state?.terminated?.reason === "OOMKilled") hit.set(s.name, (hit.get(s.name) ?? 0) + 1);
            }
          }
          if (!hit.size) continue;
          const limits = new Map(effectiveContainers(w).map((ct) => [ct.name, limitOf(ct, "memory")]));
          const text = [...hit].map(([name, pods]) => {
            const lim = limits.get(name);
            return `${name} in ${pods} pod${pods === 1 ? "" : "s"}${lim && Number.isFinite(lim) ? ` (limit ${formatBytes(lim)})` : ""}`;
          }).join("; ");
          findings.push(finding("oom-killed", workloadTarget(w), `OOMKilled: ${text}`));
        }
        return { eligible: list.length, findings };
      }
    },
    {
      id: "crash-restarts",
      title: "Containers that keep restarting",
      category: "reliability",
      severity: "medium",
      defaultOn: true,
      why: "Frequent restarts are failures the cluster is hiding: requests fail while a container comes back, and CrashLoopBackOff waits longer each time.",
      how: "Read the logs of the previous container (kubectl logs --previous) and the pod’s events.",
      run: (c) => {
        const list = workloads(c).filter((w) => w.pods.length > 0);
        const findings = [];
        for (const w of list) {
          let restarts = 0;
          let looping = false;
          for (const pod of w.pods) {
            for (const s of pod.status?.containerStatuses ?? []) {
              restarts += s.restartCount ?? 0;
              if (s.state?.waiting?.reason === "CrashLoopBackOff") looping = true;
            }
          }
          if (restarts >= 5 || looping) findings.push(finding("crash-restarts", workloadTarget(w), `${restarts} restarts${looping ? ", in CrashLoopBackOff now" : ""}`));
        }
        return { eligible: list.length, findings };
      }
    },
    // --- autoscaling
    {
      id: "hpa-no-requests",
      title: "Autoscalers on a resource their target does not request",
      category: "scaling",
      severity: "high",
      defaultOn: true,
      needs: ["horizontalpodautoscalers"],
      why: "An autoscaler on CPU or memory utilisation measures use as a share of the request. With no request there is nothing to divide by, and it never scales.",
      how: "Set the request the autoscaler measures on every container of the target.",
      run: (c) => {
        const findings = [];
        let eligible = 0;
        for (const h of scoped(c, c.horizontalpodautoscalers)) {
          const resources = /* @__PURE__ */ new Set();
          if (h.spec?.targetCPUUtilizationPercentage) resources.add("cpu");
          for (const m of h.spec?.metrics ?? []) {
            const name = m.type === "Resource" ? m.resource?.name : m.type === "ContainerResource" ? m.containerResource?.name : void 0;
            if (name === "cpu" || name === "memory") resources.add(name);
          }
          const ref = h.spec?.scaleTargetRef;
          const target = ref ? c.inventory.byKey.get(`${ref.kind}/${h.metadata.namespace ?? ""}/${ref.name}`) : void 0;
          if (!resources.size || !target) continue;
          eligible++;
          const gaps = effectiveContainers(target).flatMap((ct) => [...resources].filter((r) => !Number.isFinite(requestOf(ct, r))).map((r) => `${ct.name} has no ${r} request`));
          if (gaps.length) findings.push(finding("hpa-no-requests", objectTarget("HorizontalPodAutoscaler", h), `scales ${target.kind} ${target.name}, but ${gaps.join("; ")}`));
        }
        return { eligible, findings };
      }
    },
    {
      id: "hpa-at-max",
      title: "Autoscalers stuck at their maximum",
      category: "scaling",
      severity: "medium",
      defaultOn: true,
      needs: ["horizontalpodautoscalers"],
      why: "At maxReplicas the autoscaler cannot add capacity any more: load beyond this point is slower responses, not more pods.",
      how: "Raise maxReplicas, or look at why the workload needs so many.",
      run: (c) => {
        const list = scoped(c, c.horizontalpodautoscalers).filter((h) => (h.spec?.maxReplicas ?? 0) > 0);
        const findings = list.filter((h) => (h.status?.currentReplicas ?? 0) >= (h.spec?.maxReplicas ?? Infinity)).map((h) => finding("hpa-at-max", objectTarget("HorizontalPodAutoscaler", h), `at ${h.status?.currentReplicas} of max ${h.spec?.maxReplicas} replicas`));
        return { eligible: list.length, findings };
      }
    },
    {
      id: "hpa-fixed",
      title: "Autoscalers with min equal to max",
      category: "scaling",
      severity: "low",
      defaultOn: true,
      needs: ["horizontalpodautoscalers"],
      why: "An autoscaler whose minimum and maximum are the same never scales; it only adds a controller to reason about.",
      how: "Widen the range, or remove the autoscaler and set replicas on the workload.",
      run: (c) => {
        const list = scoped(c, c.horizontalpodautoscalers);
        const findings = list.filter((h) => (h.spec?.minReplicas ?? 1) === h.spec?.maxReplicas).map((h) => finding("hpa-fixed", objectTarget("HorizontalPodAutoscaler", h), `min and max are both ${h.spec?.maxReplicas}`));
        return { eligible: list.length, findings };
      }
    },
    // --- waste
    {
      id: "pvc-pending",
      title: "Volume claims stuck pending",
      category: "waste",
      severity: "medium",
      defaultOn: true,
      needs: ["persistentvolumeclaims"],
      why: "A claim pending for more than a few minutes will not bind by itself: no storage class, no matching volume, or a provisioner that is failing. Whatever mounts it cannot start.",
      how: "Look at the claim’s events; check its storageClassName exists and the provisioner is running.",
      run: (c) => {
        const list = scoped(c, c.persistentvolumeclaims);
        const findings = list.filter((p) => p.status?.phase === "Pending" && c.now - time(p.metadata.creationTimestamp) > 10 * 6e4).map((p) => finding("pvc-pending", objectTarget("PersistentVolumeClaim", p), `pending, storage class ${p.spec?.storageClassName ?? "(default)"}`));
        return { eligible: list.length, findings };
      }
    },
    {
      id: "pvc-unused",
      title: "Volume claims no pod uses",
      category: "waste",
      severity: "low",
      defaultOn: true,
      needs: ["persistentvolumeclaims"],
      why: "A bound claim holds its disk, and is paid for, whether anything mounts it or not. Often left behind by a StatefulSet scaled down or a deleted app.",
      how: "Delete the claim if the data is not needed (check the reclaim policy of its volume first).",
      run: (c) => {
        const used = /* @__PURE__ */ new Set();
        for (const pod of c.pods) {
          if (!active(pod)) continue;
          for (const v of pod.spec?.volumes ?? []) if (v.persistentVolumeClaim?.claimName) used.add(`${pod.metadata.namespace}/${v.persistentVolumeClaim.claimName}`);
        }
        const list = scoped(c, c.persistentvolumeclaims).filter((p) => p.status?.phase === "Bound");
        const findings = list.filter((p) => !used.has(`${p.metadata.namespace}/${p.metadata.name}`)).map((p) => finding("pvc-unused", objectTarget("PersistentVolumeClaim", p), `${p.status?.capacity?.storage ?? "?"} on ${p.spec?.storageClassName ?? "(default)"}, mounted by no running pod`));
        return { eligible: list.length, findings };
      }
    },
    {
      id: "pv-released",
      title: "Released volumes nobody can use",
      category: "waste",
      severity: "low",
      defaultOn: true,
      needs: ["persistentvolumes"],
      why: "A Released volume’s claim is gone, but with the Retain policy the disk stays. No new claim can bind to it until someone cleans it up.",
      how: "Back up what you need, then delete the PersistentVolume (and the disk behind it, if the provisioner does not).",
      run: (c) => {
        const list = c.persistentvolumes;
        const findings = list.filter((p) => p.status?.phase === "Released").map(
          (p) => finding(
            "pv-released",
            objectTarget("PersistentVolume", p),
            `${p.spec?.capacity?.storage ?? "?"}, was ${p.spec?.claimRef?.namespace ?? "?"}/${p.spec?.claimRef?.name ?? "?"}, policy ${p.spec?.persistentVolumeReclaimPolicy ?? "?"}`
          )
        );
        return { eligible: list.length, findings };
      }
    },
    {
      id: "scaled-to-zero",
      title: "Workloads scaled to zero",
      category: "waste",
      severity: "low",
      defaultOn: true,
      why: "Scaled to zero is often something forgotten: its config, volumes and services stay behind. Accept the ones that are meant to be off.",
      how: "Delete what is no longer needed, or accept the finding.",
      run: (c) => {
        const list = workloads(c, ["Deployment", "StatefulSet"]);
        const findings = list.filter((w) => w.replicas === 0).map((w) => finding("scaled-to-zero", workloadTarget(w), "replicas: 0"));
        return { eligible: list.length, findings };
      }
    },
    {
      id: "jobs-no-ttl",
      title: "Finished Jobs kept around",
      category: "waste",
      severity: "low",
      defaultOn: true,
      why: "A finished Job and its pods stay until someone deletes them. They pile up, and every controller and list call pays for them.",
      how: "Set ttlSecondsAfterFinished on the Job so the cluster removes it, or run it from a CronJob with a history limit.",
      run: (c) => {
        const finished = (j) => {
          const cond = j.status?.conditions?.find((k) => (k.type === "Complete" || k.type === "Failed") && k.status === "True");
          return cond ? time(j.status?.completionTime) || time(cond.lastTransitionTime) || 1 : 0;
        };
        const list = workloads(c, ["Job"]).filter((w) => finished(w.obj) > 0);
        const findings = list.filter((w) => {
          const job = w.obj;
          return job.spec?.ttlSecondsAfterFinished === void 0 && c.now - finished(job) > 864e5;
        }).map((w) => finding("jobs-no-ttl", workloadTarget(w), "finished more than a day ago, no ttlSecondsAfterFinished"));
        return { eligible: list.length, findings };
      }
    },
    {
      id: "service-no-pods",
      title: "Services that select no pods",
      category: "waste",
      severity: "low",
      defaultOn: true,
      needs: ["services"],
      why: "A Service whose selector matches no running pod answers nothing. A LoadBalancer one still costs a cloud load balancer.",
      how: "Fix the selector, or delete the Service if the app is gone.",
      run: (c) => {
        const list = scoped(c, c.services).filter((s) => Object.keys(s.spec?.selector ?? {}).length > 0);
        const findings = list.filter((s) => !c.pods.some((p) => p.metadata.namespace === s.metadata.namespace && active(p) && matchesMap(s.spec?.selector, p.metadata.labels))).map((s) => finding("service-no-pods", objectTarget("Service", s), `${s.spec?.type ?? "ClusterIP"} selecting ${Object.entries(s.spec?.selector ?? {}).map(([k, v]) => `${k}=${v}`).join(",")} matches no running pod`));
        return { eligible: list.length, findings };
      }
    },
    // --- nodes
    {
      id: "node-requests-high",
      title: "Nodes nearly fully requested",
      category: "nodes",
      severity: "medium",
      defaultOn: true,
      needs: ["nodes"],
      why: "Above 90% of a node’s CPU or memory requested, new pods and rollouts wait for room, and a node failing leaves nowhere to go.",
      how: "Add a node or let the cluster autoscaler do it, or free requests with the rightsizing tips.",
      run: (c) => {
        const loads = nodeLoads(c);
        const list = c.nodes.filter((n) => !n.spec?.unschedulable);
        const findings = [];
        for (const n of list) {
          const load = loads.get(n.metadata.name);
          const cpu = parseQuantity(n.status?.allocatable?.cpu);
          const mem = parseQuantity(n.status?.allocatable?.memory);
          if (!load || !(cpu > 0) || !(mem > 0)) continue;
          const parts = [];
          if (load.cpu / cpu > 0.9) parts.push(`CPU ${pct(load.cpu, cpu)} requested`);
          if (load.memory / mem > 0.9) parts.push(`memory ${pct(load.memory, mem)} requested`);
          if (parts.length) findings.push(finding("node-requests-high", objectTarget("Node", n), parts.join(", ")));
        }
        return { eligible: list.length, findings };
      }
    },
    {
      id: "node-idle",
      title: "Nodes that are mostly empty",
      category: "nodes",
      severity: "low",
      defaultOn: true,
      needs: ["nodes"],
      why: "A node with under a fifth of its CPU and memory requested is capacity paid for and not used. Its pods would usually fit elsewhere.",
      how: "Let the cluster autoscaler (or Karpenter) consolidate, or use fewer, larger nodes.",
      run: (c) => {
        const list = c.nodes.filter((n) => !n.spec?.unschedulable);
        if (list.length < 3) return { eligible: 0, findings: [], unavailable: "Fewer than three schedulable nodes: nothing to consolidate." };
        const loads = nodeLoads(c);
        const findings = [];
        for (const n of list) {
          const load = loads.get(n.metadata.name) ?? { cpu: 0, memory: 0, memoryLimits: 0, pods: 0 };
          const cpu = parseQuantity(n.status?.allocatable?.cpu);
          const mem = parseQuantity(n.status?.allocatable?.memory);
          if (!(cpu > 0) || !(mem > 0)) continue;
          if (load.cpu / cpu < 0.2 && load.memory / mem < 0.2) {
            findings.push(finding("node-idle", objectTarget("Node", n), `CPU ${pct(load.cpu, cpu)} and memory ${pct(load.memory, mem)} requested, ${load.pods} pods`));
          }
        }
        return { eligible: list.length, findings };
      }
    },
    {
      id: "node-memory-overcommit",
      title: "Nodes whose memory limits add up far past their memory",
      category: "nodes",
      severity: "medium",
      defaultOn: true,
      needs: ["nodes"],
      why: "When the memory limits on a node add up to well over what it has, the pods can all be within their limits and still run the node out of memory together.",
      how: "Bring memory limits closer to requests on the biggest pods, or move them apart.",
      run: (c) => {
        const loads = nodeLoads(c);
        const list = c.nodes;
        const findings = [];
        for (const n of list) {
          const load = loads.get(n.metadata.name);
          const mem = parseQuantity(n.status?.allocatable?.memory);
          if (!load || !(mem > 0)) continue;
          if (load.memoryLimits > mem * 1.5) findings.push(finding("node-memory-overcommit", objectTarget("Node", n), `memory limits add up to ${pct(load.memoryLimits, mem)} of ${formatBytes(mem)}`));
        }
        return { eligible: list.length, findings };
      }
    },
    // --- security basics
    {
      id: "privileged",
      title: "Privileged containers",
      category: "security",
      severity: "high",
      defaultOn: true,
      why: "A privileged container has the host’s devices and kernel capabilities: escaping it is escaping to the node. Some node agents need it; application pods do not.",
      how: "Remove securityContext.privileged, adding only the capabilities the container needs.",
      run: perContainer("privileged", void 0, templateContainers, (ct) => ct.securityContext?.privileged ? "privileged" : null)
    },
    {
      id: "run-as-non-root",
      title: "Containers that may run as root",
      category: "security",
      severity: "low",
      defaultOn: false,
      why: "A process running as root inside the container is one kernel bug away from root on the node. Off by default: many images still need it.",
      how: "Set securityContext.runAsNonRoot: true (and a runAsUser) on the pod or container.",
      run: (c) => {
        const list = workloads(c);
        const findings = [];
        for (const w of list) {
          const pod = w.template.spec?.securityContext;
          const podSafe = pod?.runAsNonRoot === true || (pod?.runAsUser ?? 0) > 0;
          const names = templateContainers(w).filter((ct) => {
            const sc = ct.securityContext;
            if (sc?.runAsNonRoot === true || (sc?.runAsUser ?? 0) > 0) return false;
            return !podSafe || sc?.runAsUser === 0;
          }).map((ct) => ct.name);
          if (names.length) findings.push(finding("run-as-non-root", workloadTarget(w), `${names.join(", ")}: runAsNonRoot not set`));
        }
        return { eligible: list.length, findings };
      }
    },
    {
      id: "automount-token",
      title: "Service account tokens mounted by default",
      category: "security",
      severity: "low",
      defaultOn: false,
      why: "Every pod gets a token for the Kubernetes API unless told otherwise; most application pods never use it. Off by default.",
      how: "Set automountServiceAccountToken: false on pods that do not talk to the API.",
      run: (c) => {
        const list = workloads(c);
        const findings = list.filter((w) => w.template.spec?.automountServiceAccountToken !== false).map((w) => finding("automount-token", workloadTarget(w), "automountServiceAccountToken not false"));
        return { eligible: list.length, findings };
      }
    },
    // --- observability
    {
      id: "metrics-source",
      title: "Usage history for rightsizing",
      category: "observability",
      severity: "low",
      defaultOn: true,
      why: "Rightsizing needs to know what containers actually use. A day of history from Prometheus or VictoriaMetrics is what a request should be sized on; metrics-server has only the reading of right now.",
      how: "Install kube-prometheus-stack, or victoria-metrics-k8s-stack — K8s Dockside finds either. If yours is not found, set its address in the cluster’s settings.",
      run: (c) => {
        const u = c.usage;
        if (u.source === "prometheus" && !u.note) return { eligible: 1, findings: [] };
        let detail;
        if (u.source === "prometheus") detail = u.note;
        else if (u.source === "metrics-server")
          detail = `Usage comes from metrics-server: one reading, right now (${u.note}). With Prometheus or VictoriaMetrics, rightsizing would use a day of history and could apply its suggestions.`;
        else
          detail = `No usage data (${u.note}). Installing Prometheus or VictoriaMetrics would turn on the rightsizing tips with a day of history; metrics-server alone would give a reading of right now.`;
        return { eligible: 1, findings: [finding("metrics-source", CLUSTER, detail)] };
      }
    }
  ];

  // src/model/settings.ts
  var DEFAULT_SETTINGS = { rules: {}, accepted: [], system: false };
  var CONFIGMAP = { namespace: "default", name: "k8sdockside-optimization", key: "settings.json" };
  var IGNORE_ANNOTATION = "optimization.k8sdockside.io/ignore";
  function ignoredBy(annotations, ruleId) {
    const value = annotations?.[IGNORE_ANNOTATION];
    if (!value) return false;
    return value.split(",").some((part) => {
      const id = part.trim();
      return id === "*" || id === ruleId;
    });
  }
  function ruleEnabled(settings, rule) {
    return settings.rules[rule.id] ?? rule.defaultOn;
  }
  function withRule(settings, rule, on) {
    const rules = { ...settings.rules };
    if (on === rule.defaultOn) delete rules[rule.id];
    else rules[rule.id] = on;
    return { ...settings, rules };
  }
  function withAccepted(settings, key, accept) {
    const rest = settings.accepted.filter((k) => k !== key);
    return { ...settings, accepted: accept ? [...rest, key].sort() : rest };
  }
  function encodeSettings(settings) {
    const rules = {};
    for (const id of Object.keys(settings.rules).sort()) rules[id] = settings.rules[id];
    return JSON.stringify({ rules, accepted: [...new Set(settings.accepted)].sort(), system: settings.system });
  }
  function decodeSettings(text) {
    if (!text) return DEFAULT_SETTINGS;
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      return DEFAULT_SETTINGS;
    }
    if (!raw || typeof raw !== "object") return DEFAULT_SETTINGS;
    const obj = raw;
    const rules = {};
    if (obj.rules && typeof obj.rules === "object") {
      for (const [id, on] of Object.entries(obj.rules)) {
        if (typeof on === "boolean") rules[id] = on;
      }
    }
    const accepted = Array.isArray(obj.accepted) ? obj.accepted.filter((k) => typeof k === "string") : [];
    return { rules, accepted, system: obj.system === true };
  }

  // src/model/report.ts
  function analyze(c, settings, rules = RULES) {
    const acceptedKeys = new Set(settings.accepted);
    const outcomes = rules.map((rule) => {
      const enabled = ruleEnabled(settings, rule);
      const missing = (rule.needs ?? []).filter((k) => c.missing.has(k));
      if (missing.length) {
        const kind = missing[0];
        return { rule, enabled, eligible: 0, open: [], accepted: [], unavailable: `Could not read ${kind}: ${c.missing.get(kind)}`, passRate: null };
      }
      let result;
      try {
        result = rule.run(c);
      } catch (err) {
        return { rule, enabled, eligible: 0, open: [], accepted: [], unavailable: `This rule failed: ${err instanceof Error ? err.message : String(err)}`, passRate: null };
      }
      const open = [];
      const accepted = [];
      for (const f of sortFindings(result.findings)) {
        const t = f.target;
        const byAnnotation = t.kind !== "" && (ignoredBy(c.annotationsOf(t.kind, t.namespace, t.name), rule.id) || t.namespace !== "" && ignoredBy(c.annotationsOf("namespaces", "", t.namespace), rule.id));
        (acceptedKeys.has(f.key) || byAnnotation ? accepted : open).push(f);
      }
      const unavailable = result.unavailable ?? "";
      const eligible = Math.max(result.eligible, result.findings.length);
      const passRate = unavailable || !eligible ? null : (eligible - open.length) / eligible;
      return { rule, enabled, eligible, open, accepted, unavailable, passRate };
    });
    const counted = outcomes.filter((o) => o.enabled && o.passRate !== null);
    const categories = CATEGORIES.map(({ id, label }) => {
      const mine = counted.filter((o) => o.rule.category === id);
      return { category: id, label, score: weighted(mine), open: mine.reduce((n, o) => n + o.open.length, 0) };
    }).filter((cat) => outcomes.some((o) => o.rule.category === cat.category));
    const savings = { cpu: 0, memory: 0 };
    for (const o of counted) {
      for (const f of o.open) {
        if (f.saving && f.saving.cpu > 0) savings.cpu += f.saving.cpu;
        if (f.saving && f.saving.memory > 0) savings.memory += f.saving.memory;
      }
    }
    const score = weighted(counted);
    return {
      outcomes,
      score,
      grade: grade(score),
      categories,
      scored: counted.length,
      total: outcomes.length,
      open: counted.reduce((n, o) => n + o.open.length, 0),
      accepted: counted.reduce((n, o) => n + o.accepted.length, 0),
      savings
    };
  }
  function weighted(outcomes) {
    let sum = 0;
    let weights = 0;
    for (const o of outcomes) {
      if (o.passRate === null) continue;
      const w = WEIGHT[o.rule.severity];
      sum += w * o.passRate;
      weights += w;
    }
    return weights ? Math.round(sum / weights * 100) : null;
  }
  function grade(score) {
    if (score === null) return "–";
    if (score >= 90) return "A";
    if (score >= 75) return "B";
    if (score >= 60) return "C";
    if (score >= 40) return "D";
    return "E";
  }
  function sortFindings(list) {
    return [...list].sort((a, b) => a.target.namespace.localeCompare(b.target.namespace) || a.target.name.localeCompare(b.target.name) || (a.target.container ?? "").localeCompare(b.target.container ?? ""));
  }

  // src/ui/icons.ts
  var ICONS = {
    gauge: ["M4.2 16.5a8.5 8.5 0 1 1 15.6 0", "M12 13.5l4-5", "M12 14.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"],
    resources: ["M7 4h10v16H7z", "M4 8h3", "M4 12h3", "M4 16h3", "M17 8h3", "M17 12h3", "M17 16h3"],
    reliability: ["M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z", "M8.5 12l2.5 2.5 4.5-5"],
    scaling: ["M4 20V14", "M9 20V10", "M14 20V7", "M19 20V4"],
    waste: ["M5 7h14", "M9 7V4.5h6V7", "M6.5 7l1 13h9l1-13", "M10 11v5", "M14 11v5"],
    node: ["M4 5h16v5H4z", "M4 14h16v5H4z", "M7.5 7.5h.01", "M7.5 16.5h.01"],
    security: ["M6 10.5h12v9.5H6z", "M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"],
    usage: ["M3 12h4l3-7 4 14 3-7h4"],
    observability: ["M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
    pod: ["M12 3l8 4.5v9L12 21l-8-4.5v-9z", "M12 12l8-4.5", "M12 12v9", "M12 12L4 7.5"],
    deployment: ["M3 7l9-4 9 4-9 4-9-4z", "M3 12l9 4 9-4", "M3 17l9 4 9-4"],
    statefulset: ["M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3z", "M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6", "M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"],
    daemonset: ["M17 2l4 4-4 4", "M3 11V9a4 4 0 0 1 4-4h14", "M7 22l-4-4 4-4", "M21 13v2a4 4 0 0 1-4 4H3"],
    cronjob: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 7v5l3 2"],
    job: ["M9 11.5l2.5 2.5L20 5.5", "M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"],
    namespace: ["M4 6h6l2 2h8v10H4z"],
    volume: ["M4 6.5c0-1.4 3.6-2.5 8-2.5s8 1.1 8 2.5-3.6 2.5-8 2.5-8-1.1-8-2.5z", "M4 6.5v11c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-11"],
    service: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M3 12h18", "M12 3a14 14 0 0 1 0 18", "M12 3a14 14 0 0 0 0 18"],
    cluster: ["M12 3l8 4.5v9L12 21l-8-4.5v-9z"],
    alert: ["M12 3.5l9.5 17h-19z", "M12 10v4", "M12 17.2h.01"],
    check: ["M4.5 12.5l5 5L19.5 7"],
    close: ["M6.5 6.5l11 11", "M17.5 6.5l-11 11"],
    info: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 11v6", "M12 7.5h.01"],
    tip: ["M9 18h6", "M10 21h4", "M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"],
    chevron: ["M9.5 6l6 6-6 6"],
    "chevron-down": ["M6 9.5l6 6 6-6"],
    open: ["M14 4h6v6", "M20 4l-9 9", "M18 14v6H4V6h6"],
    edit: ["M4 20h4L19 9l-4-4L4 16z", "M14 6l4 4"],
    save: ["M5 4h11l3 3v13H5z", "M8 4v5h7V4", "M8 20v-6h8v6"],
    undo: ["M9 14L4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 0 11H11"],
    refresh: ["M20.5 12a8.5 8.5 0 1 1-2.6-6.1", "M20.5 4v5h-5"],
    wand: ["M4 20L15 9", "M14 4v2", "M18 8h2", "M17.5 5.5l1.5-1.5", "M11 5l.8 1.5", "M19 11l-1.5-.8"],
    accept: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M8.5 12l2.5 2.5 4.5-5"],
    book: ["M12 6.5c-1.5-1.3-3.8-2-7-2v13c3.2 0 5.5.7 7 2 1.5-1.3 3.8-2 7-2v-13c-3.2 0-5.5.7-7 2z", "M12 6.5v13"],
    link: ["M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7l-1.2 1.2", "M13.5 10.5a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 0 0 5.7 5.7l1.2-1.2"]
  };
  function kindIcon(appKind) {
    switch (appKind) {
      case "deployments":
        return "deployment";
      case "statefulsets":
        return "statefulset";
      case "daemonsets":
        return "daemonset";
      case "cronjobs":
        return "cronjob";
      case "jobs":
        return "job";
      case "pods":
        return "pod";
      case "nodes":
        return "node";
      case "namespaces":
        return "namespace";
      case "persistentvolumeclaims":
      case "persistentvolumes":
        return "volume";
      case "services":
        return "service";
      case "horizontalpodautoscalers":
        return "scaling";
      case "poddisruptionbudgets":
        return "reliability";
      default:
        return "cluster";
    }
  }

  // src/ui/dom.ts
  var SVG_NS = "http://www.w3.org/2000/svg";
  function el(tag, className = "", text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== void 0) node.textContent = String(text);
    return node;
  }
  function add(parent, ...children) {
    for (const child of children) {
      if (child === null || child === void 0 || child === false) continue;
      parent.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return parent;
  }
  function svg(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  }
  function clear(node) {
    node.textContent = "";
  }
  function byId(id) {
    const node = document.getElementById(id);
    if (!node) throw new Error(`the page has no #${id}`);
    return node;
  }
  function icon(name, className = "") {
    const node = svg("svg", { viewBox: "0 0 24 24", class: "ico" + (className ? " " + className : ""), "aria-hidden": "true" });
    for (const d of ICONS[name]) node.appendChild(svg("path", { d }));
    return node;
  }
  function chip(text, tone = "", iconName, title) {
    const node = el("span", "chip" + (tone ? " " + tone : ""));
    if (iconName) node.appendChild(icon(iconName));
    node.appendChild(el("span", "", text));
    if (title) node.title = title;
    return node;
  }
  function button(text, className, iconName, onClick) {
    const node = el("button", className);
    node.type = "button";
    if (iconName) node.appendChild(icon(iconName));
    if (text) node.appendChild(el("span", "", text));
    node.addEventListener("click", onClick);
    return node;
  }
  function linkButton(text, onClick, title) {
    const node = el("button", "link", text);
    node.type = "button";
    if (title) node.title = title;
    node.addEventListener("click", onClick);
    return node;
  }

  // src/ui/format.ts
  function plural(n, one, many = one + "s") {
    return `${n} ${n === 1 ? one : many}`;
  }

  // src/model/patch.ts
  function resourcesPatch(obj, fix) {
    const podSpec = fix.kind === "CronJob" ? dig(obj, ["spec", "jobTemplate", "spec", "template", "spec"]) : dig(obj, ["spec", "template", "spec"]);
    const containers = podSpec?.containers ?? [];
    if (!containers.some((c) => c.name === fix.container)) {
      throw new Error(`${fix.kind} ${fix.namespace}/${fix.name} has no container called ${fix.container} any more`);
    }
    const next = containers.map((c) => {
      if (c.name !== fix.container) return c;
      const resources = { ...c.resources ?? {} };
      if (Object.keys(fix.requests).length) resources.requests = { ...resources.requests ?? {}, ...fix.requests };
      if (Object.keys(fix.limits).length) resources.limits = { ...resources.limits ?? {}, ...fix.limits };
      return { ...c, resources };
    });
    const template = { spec: { containers: next } };
    return fix.kind === "CronJob" ? { spec: { jobTemplate: { spec: { template } } } } : { spec: { template } };
  }
  function dig(obj, path) {
    let at = obj;
    for (const key of path) {
      if (!at || typeof at !== "object") return void 0;
      at = at[key];
    }
    return at && typeof at === "object" ? at : void 0;
  }

  // src/ui/page.ts
  var sdk = k8sdockside;
  function message(err) {
    return err instanceof Error ? err.message : String(err);
  }
  function declined(err) {
    return /declined/.test(message(err));
  }
  var banner = {
    show(err) {
      const node = byId("error");
      node.textContent = message(err);
      node.hidden = false;
    },
    clear() {
      byId("error").hidden = true;
    }
  };
  function every(ms, fn, onError = banner.show) {
    let stopped = false;
    let timer;
    const run = () => {
      Promise.resolve().then(fn).catch((err) => {
        if (!stopped) onError(err);
      }).then(() => {
        if (!stopped) timer = setTimeout(run, ms);
      });
    };
    run();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }
  function readHash() {
    const out = {};
    for (const pair of location.hash.replace(/^#/, "").split("&")) {
      const cut = pair.indexOf("=");
      if (cut <= 0) continue;
      try {
        out[pair.slice(0, cut)] = decodeURIComponent(pair.slice(cut + 1));
      } catch {
      }
    }
    return out;
  }
  function writeHash(values) {
    const text = Object.entries(values).filter((entry) => typeof entry[1] === "string" && entry[1] !== "").map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    const hash = text ? "#" + text : "";
    if (hash === location.hash || !hash && !location.hash) return;
    try {
      history.replaceState(null, "", hash || location.pathname);
    } catch {
      try {
        location.hash = text;
      } catch {
      }
    }
  }
  function politely(root, redraw) {
    let pressed = false;
    let owed = false;
    const busy = () => {
      if (pressed) return true;
      const active2 = document.activeElement;
      if (active2 && root.contains(active2) && /^(INPUT|SELECT|TEXTAREA)$/.test(active2.tagName)) return true;
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed && selection.anchorNode && root.contains(selection.anchorNode)) return true;
      return false;
    };
    const settle = () => {
      if (owed && !busy()) {
        owed = false;
        keepFocus(root, redraw);
      }
    };
    root.addEventListener("pointerdown", () => pressed = true);
    window.addEventListener("pointerup", () => {
      pressed = false;
      setTimeout(settle, 0);
    });
    window.addEventListener("pointercancel", () => {
      pressed = false;
      settle();
    });
    root.addEventListener("focusout", () => setTimeout(settle, 0));
    document.addEventListener("selectionchange", () => {
      if (owed) setTimeout(settle, 0);
    });
    return () => {
      if (busy()) owed = true;
      else keepFocus(root, redraw);
    };
  }
  function keepFocus(root, redraw) {
    const active2 = document.activeElement;
    const key = active2 instanceof HTMLElement && root.contains(active2) ? active2.dataset.focus : void 0;
    redraw();
    if (key) {
      const again = [...root.querySelectorAll("[data-focus]")].find((n) => n.dataset.focus === key);
      again?.focus({ preventScroll: true });
    }
  }

  // src/ui/load.ts
  var USAGE_MINUTES = 5;
  async function loadSnapshot() {
    const snap = emptySnapshot();
    const lists = snap;
    await Promise.all(
      SNAPSHOT_KINDS.map(async (kind) => {
        try {
          lists[kind] = await sdk.list({ kind, namespace: "" });
        } catch (err) {
          snap.missing.set(kind, message(err));
        }
      })
    );
    return snap;
  }
  async function loadUsage() {
    let note;
    try {
      const outcome = usageFromCharts(await sdk.charts({ minutes: USAGE_MINUTES }));
      if (outcome.usage) return outcome.usage;
      note = outcome.problem;
    } catch (err) {
      note = `could not ask for charts (${message(err)})`;
    }
    try {
      const items = await sdk.list({ kind: "crd:pods.metrics.k8s.io", namespace: "" });
      return usageFromPodMetrics(items, note);
    } catch (err) {
      return noUsage(`${note}; ${metricsServerProblem(err)}`);
    }
  }
  function metricsServerProblem(err) {
    const text = message(err);
    if (/not served|could not find the requested resource|no matches for|not found/i.test(text)) return "metrics-server is not installed";
    if (/service unavailable|503/i.test(text)) return "metrics-server is installed but not answering";
    return `metrics-server did not answer (${text})`;
  }
  async function loadSaved() {
    try {
      const cm = await sdk.get({ kind: "configmaps", namespace: CONFIGMAP.namespace, name: CONFIGMAP.name });
      const settings = decodeSettings(cm.data?.[CONFIGMAP.key]);
      return { settings, text: encodeSettings(settings), exists: true, error: "" };
    } catch (err) {
      const text = message(err);
      const none = /not found/i.test(text);
      return { settings: DEFAULT_SETTINGS, text: encodeSettings(DEFAULT_SETTINGS), exists: false, error: none ? "" : text };
    }
  }
  async function saveSettings(settings, exists) {
    const data = { [CONFIGMAP.key]: encodeSettings(settings) };
    if (exists) {
      await sdk.patch({ kind: "configmaps", namespace: CONFIGMAP.namespace, name: CONFIGMAP.name, patch: { data } });
      return;
    }
    await sdk.create({
      kind: "configmaps",
      namespace: CONFIGMAP.namespace,
      object: {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: CONFIGMAP.name, labels: { "app.kubernetes.io/managed-by": "k8sdockside-optimization" } },
        data
      }
    });
  }
  async function applyFix(fix) {
    const kind = APP_KIND[fix.kind];
    const obj = await sdk.get({ kind, namespace: fix.namespace, name: fix.name });
    await sdk.patch({ kind, namespace: fix.namespace, name: fix.name, patch: resourcesPatch(obj, fix) });
  }

  // src/ui/memory.ts
  var durable = typeof sdk.storage?.get === "function";
  async function recall(key, fallback) {
    if (!sdk.storage) return fallback;
    try {
      return await sdk.storage.get(key) ?? fallback;
    } catch {
      return fallback;
    }
  }
  function keep(key, value) {
    sdk.storage?.set(key, value).catch(() => {
    });
  }
  function strings(value) {
    return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
  }

  // src/ui/widgets.ts
  var CATEGORY_ICON = {
    resources: "resources",
    usage: "usage",
    reliability: "reliability",
    scaling: "scaling",
    waste: "waste",
    nodes: "node",
    security: "security",
    observability: "observability"
  };
  var SEVERITY_TONE = { high: "error", medium: "warn", low: "info" };
  function toneOf(score) {
    if (score === null) return "muted";
    if (score >= 75) return "ok";
    if (score >= 50) return "warn";
    return "error";
  }
  function scoreRing(score, grade2, size = 148) {
    const thickness = 12;
    const r = (size - thickness) / 2;
    const c = 2 * Math.PI * r;
    const mid = size / 2;
    const wrap = el("div", "score-ring " + toneOf(score));
    wrap.style.width = wrap.style.height = size + "px";
    const drawing = svg("svg", { viewBox: `0 0 ${size} ${size}`, role: "img", "aria-label": score === null ? "No score yet" : `Score ${score} of 100, grade ${grade2}` });
    drawing.appendChild(svg("circle", { cx: mid, cy: mid, r, class: "score-track", "stroke-width": thickness }));
    if (score !== null && score > 0) {
      drawing.appendChild(
        svg("circle", { cx: mid, cy: mid, r, class: "score-arc", "stroke-width": thickness, "stroke-dasharray": `${score / 100 * c} ${c}`, transform: `rotate(-90 ${mid} ${mid})` })
      );
    }
    const centre = el("div", "score-centre");
    add(centre, el("div", "score-number", score === null ? "–" : String(score)), el("div", "score-grade", score === null ? "no score" : `grade ${grade2}`));
    add(wrap, drawing, centre);
    return wrap;
  }
  function bar(fraction, tone) {
    const node = el("span", "bar");
    const fill = el("i", "bar-fill " + tone);
    fill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    node.appendChild(fill);
    return node;
  }
  function severityChip(severity) {
    const node = chip(severity, SEVERITY_TONE[severity]);
    node.classList.add("sev");
    node.title = `${severity} severity: weighs ${severity === "high" ? 5 : severity === "medium" ? 3 : 1} in the score`;
    return node;
  }
  function targetButton(t, open) {
    if (!t.kind) {
      const node2 = el("span", "target");
      add(node2, icon("cluster"), el("span", "target-label", t.label));
      return node2;
    }
    const node = button("", "target", kindIcon(t.kind), () => open(t));
    add(node, el("span", "target-label", t.label), t.container ? el("span", "target-container", t.container) : null);
    node.title = `Open ${t.label}`;
    node.dataset.focus = `target:${t.kind}/${t.namespace}/${t.name}/${t.container ?? ""}`;
    return node;
  }
  function checkbox(text, checked, onChange, opts = {}) {
    const label = el("label", "check");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.disabled = !!opts.disabled;
    if (opts.focus) input.dataset.focus = opts.focus;
    input.addEventListener("change", () => onChange(input.checked));
    add(label, input, el("span", "", text));
    if (opts.title) label.title = opts.title;
    return label;
  }
  function fixText(fix) {
    const parts = [];
    for (const [resource, value] of Object.entries(fix.requests)) parts.push(`${resource} request → ${value}`);
    for (const [resource, value] of Object.entries(fix.limits)) parts.push(`${resource} limit → ${value}`);
    return `${fix.container}: ${parts.join(", ")}`;
  }
  var STACKS = [
    { label: "kube-prometheus-stack", url: "https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack" },
    { label: "victoria-metrics-k8s-stack", url: "https://docs.victoriametrics.com/helm/victoria-metrics-k8s-stack/" }
  ];
  var METRICS_SERVER = { label: "metrics-server", url: "https://github.com/kubernetes-sigs/metrics-server" };
  function sourceNotice(u, openUrl2) {
    if (u.source === "prometheus") {
      const box2 = el("div", "notice ok");
      const body2 = el("div", "notice-body");
      add(body2, el("div", "notice-head", `Usage: a day of history from ${u.where}`), u.note ? el("p", "notice-why", u.note) : null);
      add(box2, icon("check"), body2);
      return box2;
    }
    const box = el("div", "notice tip");
    const body = el("div", "notice-body");
    const ms = u.source === "metrics-server";
    add(
      body,
      el("div", "notice-head", ms ? "Tip: rightsizing would be better with Prometheus or VictoriaMetrics" : "Tip: install Prometheus or VictoriaMetrics to turn on rightsizing"),
      el(
        "p",
        "notice-text",
        ms ? "Usage comes from metrics-server — one reading of right now. A day of history sizes requests on real peaks, and lets Apply write the suggestion for you. K8s Dockside finds either one by itself." : "There is no usage data, so the rightsizing rules are left out of the score. Prometheus or VictoriaMetrics give a day of history; metrics-server alone gives a reading of right now. Every other rule works without them."
      ),
      u.note ? el("p", "notice-why", `Why: ${u.note}.`) : null
    );
    const links = el("div", "notice-links");
    for (const link of ms ? STACKS : [...STACKS, METRICS_SERVER]) links.appendChild(linkButton(link.label, () => openUrl2(link.url), link.url));
    body.appendChild(links);
    add(box, icon("tip"), body);
    return box;
  }

  // src/pages/overview.ts
  var REFRESH_EVERY = 6e4;
  var USAGE_EVERY = 5 * 6e4;
  var FINDINGS_SHOWN = 25;
  var MI3 = 2 ** 20;
  var state = {
    ctx: null,
    snap: null,
    usage: null,
    usageAt: 0,
    saved: null,
    settings: decodeSettings(null),
    report: null,
    expanded: /* @__PURE__ */ new Set(),
    collapsed: /* @__PURE__ */ new Set(),
    showAll: /* @__PURE__ */ new Set(),
    filter: "all",
    busy: false
  };
  function fail(err) {
    if (!declined(err)) banner.show(err);
  }
  function openTarget(t) {
    sdk.open({ kind: t.kind, namespace: t.namespace, name: t.name }).catch(fail);
  }
  function openUrl(url) {
    sdk.openUrl(url).catch(fail);
  }
  async function refresh() {
    const now = Date.now();
    const stale = !state.usage || now - state.usageAt > USAGE_EVERY;
    const [snap, usage] = await Promise.all([loadSnapshot(), stale ? loadUsage() : Promise.resolve(state.usage)]);
    if (stale) state.usageAt = now;
    state.snap = snap;
    state.usage = usage;
    if (snap.missing.has("pods")) banner.show(new Error(`Could not read pods: ${snap.missing.get("pods")}`));
    else banner.clear();
    recompute(false);
  }
  function recompute(now) {
    if (!state.snap || !state.usage) return;
    state.report = analyze(buildCluster(state.snap, state.usage, { system: state.settings.system }), state.settings);
    remember();
    if (now) keepFocus(document.body, render);
    else draw();
  }
  function unsaved() {
    return !!state.saved && encodeSettings(state.settings) !== state.saved.text;
  }
  function viewState() {
    return { collapsed: [...state.collapsed].sort(), expanded: [...state.expanded].sort(), filter: state.filter };
  }
  function remember(view = false) {
    const v = viewState();
    writeHash({
      s: unsaved() ? encodeSettings(state.settings) : null,
      open: durable ? null : v.expanded.join(",") || null,
      c: durable ? null : v.collapsed.join(",") || null,
      f: durable || state.filter !== "open" ? null : "open"
    });
    if (view && durable) keep("overview", v);
  }
  function change(next) {
    state.settings = next;
    recompute(true);
  }
  async function save() {
    const saved = state.saved;
    if (!saved) return;
    state.busy = true;
    keepFocus(document.body, render);
    try {
      await saveSettings(state.settings, saved.exists);
      state.saved = { settings: state.settings, text: encodeSettings(state.settings), exists: true, error: "" };
    } catch (err) {
      fail(err);
    } finally {
      state.busy = false;
      remember();
      keepFocus(document.body, render);
    }
  }
  function discard() {
    if (state.saved) change(state.saved.settings);
  }
  async function apply(f) {
    if (!f.fix) return;
    try {
      await applyFix(f.fix);
      await refresh();
    } catch (err) {
      fail(err);
    }
  }
  function toggle(set, id) {
    if (set.has(id)) set.delete(id);
    else set.add(id);
    remember(set !== state.showAll);
    keepFocus(document.body, render);
  }
  function reveal(category) {
    if (state.collapsed.delete(category)) {
      remember(true);
      keepFocus(document.body, render);
    }
    document.getElementById("cat-" + category)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function foldAll(fold) {
    state.collapsed = new Set(fold ? CATEGORIES.map((c) => c.id) : []);
    remember(true);
    keepFocus(document.body, render);
  }
  var draw = politely(document.body, render);
  function render() {
    const r = state.report;
    if (!r || !state.usage) return;
    renderHero(r);
    renderSource(state.usage);
    renderControls();
    renderRules(r);
    renderFoot();
  }
  function headline(r) {
    if (r.score === null) return "Nothing to score yet";
    if (!r.open) return "Nothing to fix — every rule that counts passes";
    return `${plural(r.open, "tip")} to raise the score`;
  }
  function renderHero(r) {
    const hero = byId("hero");
    clear(hero);
    const body = el("div", "hero-body");
    const story = el("p", "hero-story");
    add(story, `Scored on ${r.scored} of ${r.total} rules`, r.accepted ? ` · ${plural(r.accepted, "finding")} accepted` : "", ".");
    if (r.savings.cpu >= 0.05 || r.savings.memory >= 64 * MI3) {
      add(story, " The rightsizing tips would free ", el("strong", "", `${formatCpu(r.savings.cpu)} CPU`), " and ", el("strong", "", formatBytes(r.savings.memory)), " of requests.");
    }
    const cats = el("div", "cats");
    for (const cat of r.categories) {
      const row = button("", "cat", CATEGORY_ICON[cat.category], () => reveal(cat.category));
      row.dataset.focus = "cat:" + cat.category;
      row.title = cat.score === null ? `${cat.label}: nothing scored` : `${cat.label}: ${cat.score} of 100, ${plural(cat.open, "open tip")}`;
      add(
        row,
        el("span", "cat-label", cat.label),
        bar((cat.score ?? 0) / 100, toneOf(cat.score)),
        el("span", "cat-score", cat.score === null ? "–" : String(cat.score)),
        cat.open ? chip(String(cat.open), "warn") : el("span", "cat-none")
      );
      cats.appendChild(row);
    }
    add(body, el("h1", "hero-title " + toneOf(r.score), headline(r)), story, cats);
    add(hero, scoreRing(r.score, r.grade), body);
  }
  function renderSource(u) {
    const box = byId("source");
    clear(box);
    box.hidden = false;
    box.appendChild(sourceNotice(u, openUrl));
  }
  function renderControls() {
    const box = byId("controls");
    clear(box);
    box.hidden = false;
    const saved = state.saved;
    const canWrite = !!state.ctx?.write;
    const left = el("div", "controls-left");
    left.appendChild(
      checkbox("Include system namespaces", state.settings.system, (on) => change({ ...state.settings, system: on }), {
        title: "kube-system, kube-public, kube-node-lease and every namespace ending in -system",
        focus: "system"
      })
    );
    const seg = el("div", "seg");
    for (const [value, label] of [
      ["all", "All rules"],
      ["open", "Only rules with tips"]
    ]) {
      const b = button(label, "seg-btn" + (state.filter === value ? " active" : ""), null, () => {
        state.filter = value;
        remember(true);
        keepFocus(document.body, render);
      });
      b.dataset.focus = "filter:" + value;
      seg.appendChild(b);
    }
    left.appendChild(seg);
    const allFolded = CATEGORIES.every((c) => state.collapsed.has(c.id));
    const fold = button(allFolded ? "Expand all" : "Collapse all", "small", allFolded ? "chevron-down" : "chevron", () => foldAll(!allFolded));
    fold.dataset.focus = "fold-all";
    fold.title = durable ? "Remembered for this cluster" : "Remembered while this tab is open";
    left.appendChild(fold);
    const right = el("div", "controls-right");
    const where = `${CONFIGMAP.namespace}/${CONFIGMAP.name}`;
    if (saved?.error) right.appendChild(el("span", "save-state warn", `Could not read saved choices: ${saved.error}`));
    if (unsaved()) {
      right.appendChild(el("span", "save-state", "Changed — only in this tab until you save"));
      const discardButton = button("Discard", "small", "undo", discard);
      discardButton.dataset.focus = "discard";
      const saveButton = button(state.busy ? "Saving…" : "Save to cluster", "small primary", "save", () => void save());
      saveButton.dataset.focus = "save";
      saveButton.disabled = state.busy || !canWrite;
      saveButton.title = canWrite ? `Writes your choices to the ConfigMap ${where}, for next time and for everyone using this cluster` : "This plugin is not allowed to write";
      add(right, discardButton, saveButton);
    } else if (saved && !saved.error) {
      right.appendChild(el("span", "save-state faint", saved.exists ? `Choices saved in ${where}` : "Default choices — nothing saved yet"));
    }
    add(box, left, right);
  }
  function renderRules(r) {
    const root = byId("rules");
    clear(root);
    root.hidden = false;
    let shown = 0;
    for (const cat of CATEGORIES) {
      const outcomes = r.outcomes.filter((o) => o.rule.category === cat.id && (state.filter === "all" || o.enabled && o.open.length > 0)).sort((a, b) => bySeverity(a.rule, b.rule));
      if (!outcomes.length) continue;
      shown += outcomes.length;
      const section = el("section", "cat-section");
      section.id = "cat-" + cat.id;
      const score = r.categories.find((c) => c.category === cat.id)?.score ?? null;
      const folded = state.collapsed.has(cat.id);
      const head = el("h2", "cat-head");
      const fold = button("", "cat-toggle", folded ? "chevron" : "chevron-down", () => toggle(state.collapsed, cat.id));
      fold.dataset.focus = "fold:" + cat.id;
      fold.setAttribute("aria-expanded", String(!folded));
      fold.title = folded ? `Show the ${cat.label} rules` : `Fold the ${cat.label} rules away`;
      add(fold, icon(CATEGORY_ICON[cat.id]), el("span", "cat-name", cat.label));
      const tips = outcomes.reduce((n, o) => n + (o.enabled ? o.open.length : 0), 0);
      add(
        head,
        fold,
        folded ? el("span", "cat-folded", `${plural(outcomes.length, "rule")}${tips ? ` · ${plural(tips, "tip")}` : ""}`) : null,
        chip(score === null ? "not scored" : `${score}`, toneOf(score))
      );
      section.classList.toggle("folded", folded);
      section.appendChild(head);
      if (!folded) for (const o of outcomes) section.appendChild(ruleRow(o));
      root.appendChild(section);
    }
    if (!shown) root.appendChild(el("p", "empty", "No rule that counts has a tip right now."));
  }
  function status(o) {
    if (!o.enabled) return chip("off", "muted", void 0, "Left out of the score");
    if (o.unavailable) return chip("can’t check", "muted", "info", o.unavailable);
    if (!o.eligible) return chip("nothing to check", "muted");
    if (o.open.length) return chip(`${o.open.length} of ${o.eligible}`, SEVERITY_TONE[o.rule.severity], void 0, `${plural(o.open.length, "open finding")} of ${o.eligible} checked`);
    return chip(o.accepted.length ? `passes · ${o.accepted.length} accepted` : "passes", "ok", "check");
  }
  function ruleRow(o) {
    const id = o.rule.id;
    const row = el("article", "rule" + (o.enabled ? "" : " off") + (o.unavailable ? " na" : ""));
    const head = el("div", "rule-head");
    const tick = document.createElement("input");
    tick.type = "checkbox";
    tick.className = "rule-toggle";
    tick.checked = o.enabled;
    tick.dataset.focus = "toggle:" + id;
    tick.title = o.enabled ? "Counts in the score — untick to leave it out" : "Left out of the score — tick to count it";
    tick.setAttribute("aria-label", `${o.rule.title}: counts in the score`);
    tick.addEventListener("change", () => change(withRule(state.settings, o.rule, tick.checked)));
    const open = state.expanded.has(id);
    const title = button("", "rule-title", open ? "chevron-down" : "chevron", () => toggle(state.expanded, id));
    title.dataset.focus = "rule:" + id;
    title.setAttribute("aria-expanded", String(open));
    title.appendChild(el("span", "rule-name", o.rule.title));
    add(head, tick, severityChip(o.rule.severity), title, status(o));
    row.appendChild(head);
    if (open) row.appendChild(ruleBody(o));
    return row;
  }
  function ruleBody(o) {
    const id = o.rule.id;
    const body = el("div", "rule-body");
    const how = el("p", "rule-how");
    add(how, el("strong", "", "What to do: "), o.rule.how);
    add(body, el("p", "rule-why", o.rule.why), how);
    if (o.unavailable) {
      const na = el("p", "rule-na");
      add(na, icon("info"), el("span", "", o.unavailable));
      body.appendChild(na);
    }
    if (o.open.length) {
      const limit = state.showAll.has(id) ? Infinity : FINDINGS_SHOWN;
      const list = el("ul", "findings");
      for (const f of o.open.slice(0, limit)) list.appendChild(findingRow(f, false));
      body.appendChild(list);
      if (o.open.length > limit) body.appendChild(linkButton(`Show all ${o.open.length}`, () => toggle(state.showAll, id)));
    }
    if (o.accepted.length) {
      const details = el("details", "accepted");
      details.appendChild(el("summary", "", plural(o.accepted.length, "accepted finding")));
      const list = el("ul", "findings");
      for (const f of o.accepted) list.appendChild(findingRow(f, true));
      details.appendChild(list);
      body.appendChild(details);
    }
    const foot = el("p", "rule-id");
    add(foot, "Rule ", el("code", "", id), ". To opt an object out in Git, annotate it ", el("code", "", `${IGNORE_ANNOTATION}: "${id}"`), ".");
    body.appendChild(foot);
    return body;
  }
  function findingRow(f, accepted) {
    const li = el("li", "finding" + (accepted ? " accepted" : ""));
    const main = el("div", "finding-main");
    add(main, targetButton(f.target, openTarget), el("span", "finding-detail", f.detail));
    const actions = el("div", "finding-actions");
    if (accepted) {
      if (state.settings.accepted.includes(f.key)) {
        const undo = button("Undo", "small", "undo", () => change(withAccepted(state.settings, f.key, false)));
        undo.dataset.focus = "undo:" + f.key;
        actions.appendChild(undo);
      } else {
        actions.appendChild(chip("annotated", "muted", "info", `The object or its namespace carries ${IGNORE_ANNOTATION}`));
      }
    } else {
      if (f.fix && state.ctx?.write) {
        const fix = button("Apply", "small primary", "wand", () => void apply(f));
        fix.title = `Change ${f.target.label} — ${fixText(f.fix)}. You see the patch before it is applied.`;
        fix.dataset.focus = "apply:" + f.key;
        actions.appendChild(fix);
      }
      const accept = button("Accept", "small", "accept", () => change(withAccepted(state.settings, f.key, true)));
      accept.title = "You have decided to live with this one: it counts as passing, and stays listed under accepted";
      accept.dataset.focus = "accept:" + f.key;
      actions.appendChild(accept);
    }
    add(li, main, actions);
    return li;
  }
  function renderFoot() {
    const foot = byId("foot");
    clear(foot);
    foot.hidden = false;
    const view = linkButton("Rightsizing — every container, requests against use", () => sdk.openView("rightsizing").catch(fail));
    foot.appendChild(view);
    for (const link of state.ctx?.plugin?.links ?? []) foot.appendChild(linkButton(link.label, () => openUrl(link.url), link.url));
    if (state.ctx?.plugin?.version) foot.appendChild(el("span", "faint", `v${state.ctx.plugin.version}`));
  }
  sdk.ready().then(async (ctx) => {
    state.ctx = ctx;
    const hash = readHash();
    const split = (text) => (text ?? "").split(",").filter(Boolean);
    const view = durable ? await recall("overview", {}) : { collapsed: split(hash.c), expanded: split(hash.open), filter: hash.f };
    state.collapsed = new Set(strings(view.collapsed));
    state.expanded = new Set(strings(view.expanded));
    state.filter = view.filter === "open" ? "open" : "all";
    state.saved = await loadSaved();
    state.settings = hash.s ? decodeSettings(hash.s) : state.saved.settings;
    every(REFRESH_EVERY, refresh);
  }).catch(fail);
})();
