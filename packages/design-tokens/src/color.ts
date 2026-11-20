/**
 * Colour maths for the token sheet: sRGB hex ↔ OKLCH (Björn Ottosson's
 * matrices, as CSS Color 4 uses them) and the WCAG 2.x contrast ratio.
 *
 * Contrast is computed on the OKLCH value as the sheet writes it (rounded to
 * three decimals), converted back to sRGB, so a ratio describes what ships.
 */

export type Rgb = readonly [number, number, number];

/** `L C H` as the sheet writes them: L and C to three decimals, H to one. */
export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

const fromLinear = (c: number): number => {
  const v = Math.max(0, Math.min(1, c));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
};

const round = (value: number, digits: number): number => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

export function hexToRgb(hex: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`Not a #rrggbb colour: ${hex}`);
  const h = match[1]!;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as unknown as Rgb;
}

export function rgbToHex(rgb: Rgb): string {
  return `#${rgb
    .map((v) =>
      Math.round(Math.max(0, Math.min(1, v)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** sRGB hex → OKLCH, rounded as the sheet writes it. */
export function hexToOklch(hex: string): Oklch {
  const [r, g, b] = hexToRgb(hex).map(toLinear) as unknown as Rgb;
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const [l_, m_, s_] = [l, m, s].map(Math.cbrt) as unknown as Rgb;
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const C = Math.hypot(A, B);
  const H = ((((Math.atan2(B, A) * 180) / Math.PI) % 360) + 360) % 360;
  return { l: round(L, 3), c: round(C, 3), h: round(H, 1) };
}

/** OKLCH → sRGB, each channel clamped to [0, 1]. */
export function oklchToRgb({ l: L, c: C, h: H }: Oklch): Rgb {
  const rad = (H * Math.PI) / 180;
  const A = C * Math.cos(rad);
  const B = C * Math.sin(rad);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** The CSS of a hex colour as the sheet writes it: `oklch(L C H)`, achromatic as `oklch(L 0 0)`. */
export function cssOklch(hex: string): string {
  const { l, c, h } = hexToOklch(hex);
  if (c < 0.0005) return `oklch(${l.toFixed(3)} 0 0)`;
  return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)})`;
}

/** `oklch(L C H)` as the sheet writes it → its three numbers; `null` for any other text. */
export function parseOklch(css: string): Oklch | null {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(css.trim());
  if (!match) return null;
  return { l: Number(match[1]), c: Number(match[2]), h: Number(match[3]) };
}

/** WCAG 2.x relative luminance of an sRGB colour. */
export function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(toLinear) as unknown as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two colours, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
