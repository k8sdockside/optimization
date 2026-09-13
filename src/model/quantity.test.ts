import { describe, expect, it } from 'vitest';
import { cpuQuantity, formatBytes, formatCpu, memoryQuantity, parseQuantity } from './quantity';

describe('parseQuantity', () => {
    it('reads CPU in cores, millicores and nanocores', () => {
        expect(parseQuantity('250m')).toBeCloseTo(0.25);
        expect(parseQuantity('2')).toBe(2);
        expect(parseQuantity('0.5')).toBe(0.5);
        // metrics-server reports nanocores.
        expect(parseQuantity('1500000n')).toBeCloseTo(0.0015);
    });

    it('reads memory in binary and decimal units, and exponents', () => {
        expect(parseQuantity('512Mi')).toBe(512 * 2 ** 20);
        expect(parseQuantity('1Gi')).toBe(2 ** 30);
        expect(parseQuantity('1G')).toBe(1e9);
        expect(parseQuantity('128974848')).toBe(128974848);
        expect(parseQuantity('1e3')).toBe(1000);
        // metrics-server reports KiB.
        expect(parseQuantity('20480Ki')).toBe(20 * 2 ** 20);
    });

    it('is NaN for nothing or nonsense, never 0', () => {
        expect(parseQuantity(undefined)).toBeNaN();
        expect(parseQuantity('')).toBeNaN();
        expect(parseQuantity('lots')).toBeNaN();
        expect(parseQuantity('12Qi')).toBeNaN();
    });
});

describe('writing quantities', () => {
    it('rounds a CPU suggestion up to 5m, and to 50m above a core', () => {
        expect(cpuQuantity(0.1234)).toBe('125m');
        expect(cpuQuantity(0.0001)).toBe('5m');
        expect(cpuQuantity(1.26)).toBe('1300m');
    });

    it('rounds a memory suggestion up to 16Mi', () => {
        expect(memoryQuantity(100 * 2 ** 20)).toBe('112Mi');
        expect(memoryQuantity(1)).toBe('16Mi');
    });

    it('formats for a person', () => {
        expect(formatCpu(0.25)).toBe('250m');
        expect(formatCpu(1.5)).toBe('1.5');
        expect(formatCpu(NaN)).toBe('—');
        expect(formatBytes(512 * 2 ** 20)).toBe('512Mi');
        expect(formatBytes(1.5 * 2 ** 30)).toBe('1.5Gi');
    });
});
