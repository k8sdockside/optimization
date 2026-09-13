// What every page does with the bridge: report a failure, poll, remember its
// state in the address, and keep a redraw from pulling the rug out from under
// the user.

import { byId } from './dom';

/** The bridge. The SDK's <script> runs before the page's own, so it is always there. */
export const sdk: K8sDockside.Bridge = k8sdockside;

/** A failure, as text: the bridge rejects with an Error carrying a sentence. */
export function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Whether a rejected patch or action was the user saying no -- which is not an error worth showing. */
export function declined(err: unknown): boolean {
    return /declined/.test(message(err));
}

/** The page's error banner: a `<p id="error" hidden>`. */
export const banner = {
    show(err: unknown): void {
        const node = byId('error');
        node.textContent = message(err);
        node.hidden = false;
    },
    clear(): void {
        byId('error').hidden = true;
    },
};

/**
 * Runs `fn` now and then every `ms` after it settles -- never two at once, so
 * a slow cluster is not asked again before it has answered. Returns a stop
 * function.
 */
export function every(ms: number, fn: () => unknown, onError: (err: unknown) => void = banner.show): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = (): void => {
        Promise.resolve()
            .then(fn)
            .catch((err: unknown) => {
                if (!stopped) onError(err);
            })
            .then(() => {
                if (!stopped) timer = setTimeout(run, ms);
            });
    };
    run();
    return () => {
        stopped = true;
        clearTimeout(timer);
    };
}

// ----- the address --------------------------------------------------------------

/**
 * Switching away from a tab unloads its page, so what the user picked --
 * a filter, a search, an open row -- is kept in the URL hash and read back
 * when they return.
 */
export function readHash(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const pair of location.hash.replace(/^#/, '').split('&')) {
        const cut = pair.indexOf('=');
        if (cut <= 0) continue;
        try {
            out[pair.slice(0, cut)] = decodeURIComponent(pair.slice(cut + 1));
        } catch {
            // A hand-edited address with a stray % is ignored, not fatal.
        }
    }
    return out;
}

export function writeHash(values: Record<string, string | null | undefined | false>): void {
    const text = Object.entries(values)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '')
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');
    const hash = text ? '#' + text : '';
    if (hash === location.hash || (!hash && !location.hash)) return;
    try {
        // Replace rather than push: the frame's history is not the app's.
        history.replaceState(null, '', hash || location.pathname);
    } catch {
        // An opaque-origin frame may be refused the history API; a fragment
        // change is still allowed, and failing that the state stays in memory.
        try {
            location.hash = text;
        } catch {
            /* in memory only */
        }
    }
}

// ----- redrawing politely ----------------------------------------------------------

/**
 * Holds back a redraw of `root` while the user is in the middle of something
 * there -- a button pressed and not yet released, a field or a list being
 * typed in, text being selected to copy -- and does it as soon as they are
 * done. Returns the function to call instead of redrawing.
 */
export function politely(root: HTMLElement, redraw: () => void): () => void {
    let pressed = false;
    let owed = false;

    const busy = (): boolean => {
        if (pressed) return true;
        const active = document.activeElement;
        if (active && root.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) return true;
        const selection = document.getSelection();
        if (selection && !selection.isCollapsed && selection.anchorNode && root.contains(selection.anchorNode)) return true;
        return false;
    };
    const settle = (): void => {
        if (owed && !busy()) {
            owed = false;
            keepFocus(root, redraw);
        }
    };

    root.addEventListener('pointerdown', () => (pressed = true));
    window.addEventListener('pointerup', () => {
        pressed = false;
        // After the click the press was for has been handled.
        setTimeout(settle, 0);
    });
    window.addEventListener('pointercancel', () => {
        pressed = false;
        settle();
    });
    root.addEventListener('focusout', () => setTimeout(settle, 0));
    document.addEventListener('selectionchange', () => {
        if (owed) setTimeout(settle, 0);
    });

    return () => {
        if (busy()) owed = true;
        else keepFocus(root, redraw);
    };
}

/**
 * Redraws `root`, putting keyboard focus back on the element that had it --
 * found again by its `data-focus` key -- so a poll never throws a keyboard
 * user back to the top of the page.
 */
export function keepFocus(root: HTMLElement, redraw: () => void): void {
    const active = document.activeElement;
    const key = active instanceof HTMLElement && root.contains(active) ? active.dataset.focus : undefined;
    redraw();
    if (key) {
        const again = [...root.querySelectorAll<HTMLElement>('[data-focus]')].find((n) => n.dataset.focus === key);
        again?.focus({ preventScroll: true });
    }
}
