
export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'toNumber' in value) {
    const fn = (value as { toNumber: () => number }).toNumber;
    return typeof fn === 'function' ? fn.call(value) : 0;
  }
  return 0;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
