// What a page remembers between sessions, for the cluster it is looking at:
// kept by the app through the bridge's storage where the app has it (K8s
// Dockside 0.0.19 and newer), and only for as long as the tab is open -- in
// the address -- where it does not.

import { sdk } from './page';

/** Whether the app keeps things for the page across restarts. */
export const durable = typeof sdk.storage?.get === 'function';

/** What was kept under `key`, or `fallback`. Never rejects: a page that cannot remember still works. */
export async function recall<T>(key: string, fallback: T): Promise<T> {
    if (!sdk.storage) return fallback;
    try {
        return (await sdk.storage.get<T>(key)) ?? fallback;
    } catch {
        return fallback;
    }
}

/** Keeps `value` under `key`. Forgetting a fold is not worth an error on screen, so a failure is dropped. */
export function keep(key: string, value: unknown): void {
    sdk.storage?.set(key, value).catch(() => {});
}

/** A list of strings out of whatever was kept, dropping anything else. */
export function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
