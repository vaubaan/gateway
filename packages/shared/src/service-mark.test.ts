import { describe, expect, it } from 'vitest';

import { relativeLuminance, serviceMarkColors } from './service-mark';

describe('serviceMarkColors', () => {
  it('keeps a brand colour in both themes', () => {
    expect(serviceMarkColors('#635BFF')).toEqual({ light: '#635BFF', dark: '#635BFF' });
  });

  it('hands a near-black brand to the dark theme ink', () => {
    expect(serviceMarkColors('#181717')).toEqual({ light: '#181717', dark: null });
    expect(serviceMarkColors('#24175B')).toEqual({ light: '#24175B', dark: null });
  });

  it('draws nothing of its own without a colour', () => {
    expect(serviceMarkColors(null)).toEqual({ light: null, dark: null });
    expect(serviceMarkColors(undefined)).toEqual({ light: null, dark: null });
  });

  it('measures WCAG luminance, and refuses what is not #RRGGBB', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1);
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('red')).toBeNull();
    expect(serviceMarkColors('red')).toEqual({ light: 'red', dark: 'red' });
  });
});
