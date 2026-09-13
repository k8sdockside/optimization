// Building DOM by hand, safely.
//
// Everything that came from the cluster -- a name, an image reference, an
// error message -- goes onto the page as text (textContent, createTextNode,
// setAttribute), never as markup. The frame is sandboxed, but a page that let
// a registry's error message run as HTML would be handing it the bridge.

import { ICONS, type IconName } from './icons';

const SVG_NS = 'http://www.w3.org/2000/svg';

export type Child = Node | string | null | undefined | false;

/** An element with a class and, optionally, text. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string | number): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
}

/** Appends children, skipping the empty ones; strings become text nodes. */
export function add<T extends Node>(parent: T, ...children: Child[]): T {
    for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return parent;
}

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
}

export function clear(node: Element): void {
    node.textContent = '';
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error(`the page has no #${id}`);
    return node as T;
}

export function icon(name: IconName, className = ''): SVGSVGElement {
    const node = svg('svg', { viewBox: '0 0 24 24', class: 'ico' + (className ? ' ' + className : ''), 'aria-hidden': 'true' });
    for (const d of ICONS[name]) node.appendChild(svg('path', { d }));
    return node;
}

export type ChipTone = 'ok' | 'warn' | 'error' | 'info' | 'muted' | '';

export function chip(text: string, tone: ChipTone = '', iconName?: IconName, title?: string): HTMLSpanElement {
    const node = el('span', 'chip' + (tone ? ' ' + tone : ''));
    if (iconName) node.appendChild(icon(iconName));
    node.appendChild(el('span', '', text));
    if (title) node.title = title;
    return node;
}

export function button(text: string, className: string, iconName: IconName | null, onClick: (event: MouseEvent) => void): HTMLButtonElement {
    const node = el('button', className);
    node.type = 'button';
    if (iconName) node.appendChild(icon(iconName));
    if (text) node.appendChild(el('span', '', text));
    node.addEventListener('click', onClick);
    return node;
}

/** A square button with only an icon; `label` is what a screen reader and the tooltip say. */
export function iconButton(iconName: IconName, label: string, onClick: (event: MouseEvent) => void, className = ''): HTMLButtonElement {
    const node = button('', 'icon-button' + (className ? ' ' + className : ''), iconName, onClick);
    node.title = label;
    node.setAttribute('aria-label', label);
    return node;
}

/** Text that behaves like a link but is a button: the page never navigates. */
export function linkButton(text: string, onClick: (event: MouseEvent) => void, title?: string): HTMLButtonElement {
    const node = el('button', 'link', text);
    node.type = 'button';
    if (title) node.title = title;
    node.addEventListener('click', onClick);
    return node;
}
