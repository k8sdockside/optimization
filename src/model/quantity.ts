// Kubernetes quantities -- "250m", "1.5", "512Mi", "1G", "1e9" -- as numbers,
// and back again.

const BINARY: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
const DECIMAL: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };

const SHAPE = /^([+-]?(?:\d+\.?\d*|\.\d+))(?:([eE][+-]?\d+)|(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|M|G|T|P|E))?$/;

/** A quantity as a plain number: cores for CPU, bytes for memory. NaN when absent or unreadable. */
export function parseQuantity(text: string | number | undefined | null): number {
    if (typeof text === 'number') return text;
    if (!text) return NaN;
    const match = SHAPE.exec(text.trim());
    if (!match) return NaN;
    const value = Number(match[1]);
    if (match[2]) return value * 10 ** Number(match[2].slice(1));
    const suffix = match[3] ?? '';
    return value * (BINARY[suffix] ?? DECIMAL[suffix] ?? NaN);
}

const MI = 2 ** 20;

/** Cores as a person reads them: "250m", "1.5". */
export function formatCpu(cores: number): string {
    if (!Number.isFinite(cores)) return '—';
    if (cores < 1) return `${Math.max(Math.round(cores * 1000), cores > 0 ? 1 : 0)}m`;
    return String(Math.round(cores * 100) / 100);
}

/** Bytes as a person reads them: "96Mi", "1.5Gi". */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes)) return '—';
    const units = ['', 'Ki', 'Mi', 'Gi', 'Ti'];
    let n = bytes;
    let i = 0;
    while (Math.abs(n) >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    const text = n >= 100 || i === 0 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
    return text + units[i];
}

/**
 * A CPU request to write back: rounded up to 5m below one core and to 50m
 * above, so a recommendation does not read as false precision.
 */
export function cpuQuantity(cores: number): string {
    const milli = Math.max(1, Math.ceil(cores * 1000));
    const step = milli < 1000 ? 5 : 50;
    return `${Math.ceil(milli / step) * step}m`;
}

/** A memory request or limit to write back, rounded up to 16Mi. */
export function memoryQuantity(bytes: number): string {
    const mi = Math.max(16, Math.ceil(bytes / MI));
    return `${Math.ceil(mi / 16) * 16}Mi`;
}
