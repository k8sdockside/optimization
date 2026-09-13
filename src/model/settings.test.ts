import { describe, expect, it } from 'vitest';
import { decodeSettings, DEFAULT_SETTINGS, encodeSettings, ignoredBy, IGNORE_ANNOTATION, ruleEnabled, withAccepted, withRule } from './settings';

const rule = { id: 'single-replica', defaultOn: true };
const optIn = { id: 'cpu-limits', defaultOn: false };

describe('settings', () => {
    it('keeps only the rules that differ from their default', () => {
        const off = withRule(DEFAULT_SETTINGS, rule, false);
        expect(off.rules).toEqual({ 'single-replica': false });
        expect(ruleEnabled(off, rule)).toBe(false);
        expect(withRule(off, rule, true).rules).toEqual({});
        expect(ruleEnabled(withRule(DEFAULT_SETTINGS, optIn, true), optIn)).toBe(true);
    });

    it('writes the same text for the same choices, whatever order they were made in', () => {
        const a = withAccepted(withAccepted(DEFAULT_SETTINGS, 'b', true), 'a', true);
        const b = withAccepted(withAccepted(DEFAULT_SETTINGS, 'a', true), 'b', true);
        expect(encodeSettings(a)).toBe(encodeSettings(b));
        expect(decodeSettings(encodeSettings(a))).toEqual(a);
    });

    it('reads back what makes sense of hand-edited text, and defaults for the rest', () => {
        expect(decodeSettings('not json')).toEqual(DEFAULT_SETTINGS);
        expect(decodeSettings('{"rules":{"a":false,"b":"yes"},"accepted":["k",3],"system":"true"}')).toEqual({ rules: { a: false }, accepted: ['k'], system: false });
    });

    it('reads the ignore annotation as a list, or * for everything', () => {
        expect(ignoredBy({ [IGNORE_ANNOTATION]: 'pdb-missing, single-replica' }, 'single-replica')).toBe(true);
        expect(ignoredBy({ [IGNORE_ANNOTATION]: 'pdb-missing' }, 'single-replica')).toBe(false);
        expect(ignoredBy({ [IGNORE_ANNOTATION]: '*' }, 'anything')).toBe(true);
        expect(ignoredBy(undefined, 'anything')).toBe(false);
    });
});
