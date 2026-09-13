// Numbers and times, written for a person.

export function plural(n: number, one: string, many = one + 's'): string {
    return `${n} ${n === 1 ? one : many}`;
}

/** "just now", "40s ago", "12m ago", "3h ago", "5d ago". */
export function ago(ms: number, now = Date.now()): string {
    if (!ms) return '';
    const d = Math.max(0, now - ms);
    if (d < 10_000) return 'just now';
    if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
    if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
    if (d < 172_800_000) return `${Math.round(d / 3_600_000)}h ago`;
    return `${Math.round(d / 86_400_000)}d ago`;
}

export function percent(part: number, whole: number): string {
    if (!whole) return '0%';
    const p = (part / whole) * 100;
    return (p > 0 && p < 1 ? '<1' : String(Math.round(p))) + '%';
}

/** A list in words: "a", "a and b", "a, b and c". */
export function words(list: string[]): string {
    if (list.length <= 1) return list[0] ?? '';
    return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
}
