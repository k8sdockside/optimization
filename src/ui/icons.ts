// Single-stroke icons on a 24-unit grid, drawn with currentColor -- the same
// idiom as the app's own set, so the pages sit comfortably beside it.

export const ICONS = {
    gauge: ['M4.2 16.5a8.5 8.5 0 1 1 15.6 0', 'M12 13.5l4-5', 'M12 14.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'],
    resources: ['M7 4h10v16H7z', 'M4 8h3', 'M4 12h3', 'M4 16h3', 'M17 8h3', 'M17 12h3', 'M17 16h3'],
    reliability: ['M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z', 'M8.5 12l2.5 2.5 4.5-5'],
    scaling: ['M4 20V14', 'M9 20V10', 'M14 20V7', 'M19 20V4'],
    waste: ['M5 7h14', 'M9 7V4.5h6V7', 'M6.5 7l1 13h9l1-13', 'M10 11v5', 'M14 11v5'],
    node: ['M4 5h16v5H4z', 'M4 14h16v5H4z', 'M7.5 7.5h.01', 'M7.5 16.5h.01'],
    security: ['M6 10.5h12v9.5H6z', 'M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3'],
    usage: ['M3 12h4l3-7 4 14 3-7h4'],
    observability: ['M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
    pod: ['M12 3l8 4.5v9L12 21l-8-4.5v-9z', 'M12 12l8-4.5', 'M12 12v9', 'M12 12L4 7.5'],
    deployment: ['M3 7l9-4 9 4-9 4-9-4z', 'M3 12l9 4 9-4', 'M3 17l9 4 9-4'],
    statefulset: ['M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3z', 'M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6', 'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3'],
    daemonset: ['M17 2l4 4-4 4', 'M3 11V9a4 4 0 0 1 4-4h14', 'M7 22l-4-4 4-4', 'M21 13v2a4 4 0 0 1-4 4H3'],
    cronjob: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7v5l3 2'],
    job: ['M9 11.5l2.5 2.5L20 5.5', 'M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9'],
    namespace: ['M4 6h6l2 2h8v10H4z'],
    volume: ['M4 6.5c0-1.4 3.6-2.5 8-2.5s8 1.1 8 2.5-3.6 2.5-8 2.5-8-1.1-8-2.5z', 'M4 6.5v11c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-11'],
    service: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M3 12h18', 'M12 3a14 14 0 0 1 0 18', 'M12 3a14 14 0 0 0 0 18'],
    cluster: ['M12 3l8 4.5v9L12 21l-8-4.5v-9z'],
    alert: ['M12 3.5l9.5 17h-19z', 'M12 10v4', 'M12 17.2h.01'],
    check: ['M4.5 12.5l5 5L19.5 7'],
    close: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
    info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v6', 'M12 7.5h.01'],
    tip: ['M9 18h6', 'M10 21h4', 'M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z'],
    chevron: ['M9.5 6l6 6-6 6'],
    'chevron-down': ['M6 9.5l6 6 6-6'],
    open: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v6H4V6h6'],
    edit: ['M4 20h4L19 9l-4-4L4 16z', 'M14 6l4 4'],
    save: ['M5 4h11l3 3v13H5z', 'M8 4v5h7V4', 'M8 20v-6h8v6'],
    undo: ['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
    refresh: ['M20.5 12a8.5 8.5 0 1 1-2.6-6.1', 'M20.5 4v5h-5'],
    wand: ['M4 20L15 9', 'M14 4v2', 'M18 8h2', 'M17.5 5.5l1.5-1.5', 'M11 5l.8 1.5', 'M19 11l-1.5-.8'],
    accept: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M8.5 12l2.5 2.5 4.5-5'],
    book: ['M12 6.5c-1.5-1.3-3.8-2-7-2v13c3.2 0 5.5.7 7 2 1.5-1.3 3.8-2 7-2v-13c-3.2 0-5.5.7-7 2z', 'M12 6.5v13'],
    link: ['M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7l-1.2 1.2', 'M13.5 10.5a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 0 0 5.7 5.7l1.2-1.2'],
} as const satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof ICONS;

/** The icon for an app kind, as the app draws the same kinds in its sidebar. */
export function kindIcon(appKind: string): IconName {
    switch (appKind) {
        case 'deployments':
            return 'deployment';
        case 'statefulsets':
            return 'statefulset';
        case 'daemonsets':
            return 'daemonset';
        case 'cronjobs':
            return 'cronjob';
        case 'jobs':
            return 'job';
        case 'pods':
            return 'pod';
        case 'nodes':
            return 'node';
        case 'namespaces':
            return 'namespace';
        case 'persistentvolumeclaims':
        case 'persistentvolumes':
            return 'volume';
        case 'services':
            return 'service';
        case 'horizontalpodautoscalers':
            return 'scaling';
        case 'poddisruptionbudgets':
            return 'reliability';
        default:
            return 'cluster';
    }
}
