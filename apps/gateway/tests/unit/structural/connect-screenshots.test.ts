/**
 * Structural test (ADR plugin-contract-and-credential-spec, amendment 2026-11-13):
 * the screenshots a shipped plugin's connect guide declares are real, light files in
 * `plugins/<id>/docs/connect/`, and nothing else sits there.
 *
 * `definePlugin` checks the declaration (a source, an allowed licence, a month, an alt,
 * one step per file); this holds the files to what it cannot see: each exists, is a PNG
 * or a WebP by its magic bytes (not by its name), weighs at most 300 KB and is at most
 * 1600 px wide, the width read from the PNG IHDR or the WebP VP8 / VP8L / VP8X header.
 * Personal data in an image (an e-mail, an avatar, a real token) is the review's to see.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { GUIDE_SCREENSHOT_DIR } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { SHIPPED_PLUGINS } from '../../../src/server/compose/shipped-plugins';
import { PLUGIN_FOLDERS, PLUGINS } from './plugin-sources';

const MAX_BYTES = 300 * 1024;
const MAX_WIDTH = 1600;

type ImageFormat = 'png' | 'webp';

/** The format by magic bytes, or `null` when the file is neither a PNG nor a WebP. */
function imageFormat(bytes: Uint8Array): ImageFormat | null {
  const ascii = (from: number, to: number): string =>
    String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (bytes.length >= 16 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
}

/** The width in pixels from the image header, or `null` when the header is not understood. */
function imageWidth(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = imageFormat(bytes);
  if (format === 'png') {
    // Signature (8), chunk length (4), "IHDR" (4), then the width, big-endian.
    return bytes.length >= 24 ? view.getUint32(16) : null;
  }
  if (format !== 'webp' || bytes.length < 30) return null;
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  if (chunk === 'VP8 ') {
    // Frame tag (3), start code (3), then the 14-bit width, little-endian.
    return view.getUint16(26, true) & 0x3fff;
  }
  if (chunk === 'VP8L') {
    // Signature byte 0x2f, then width - 1 on 14 bits.
    return (view.getUint16(21, true) & 0x3fff) + 1;
  }
  if (chunk === 'VP8X') {
    // Flags (4), then canvas width - 1 on 24 bits, little-endian.
    return (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1;
  }
  return null;
}

/** Every declared screenshot, as `[plugin id, file name]`. */
const SCREENSHOTS: readonly (readonly [string, string])[] = SHIPPED_PLUGINS.flatMap((plugin) => {
  const spec = plugin.credential;
  const shots = spec.kind === 'api-key' ? (spec.guide.screenshots ?? {}) : {};
  return Object.keys(shots).map((file) => [plugin.id, file] as const);
});

describe('the screenshots of the connect guides', () => {
  it('reads the headers it relies on', () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
    new DataView(png.buffer).setUint32(16, 1234);
    expect(imageFormat(png)).toBe('png');
    expect(imageWidth(png)).toBe(1234);
    expect(imageFormat(new TextEncoder().encode('GIF89a-not-an-image'))).toBeNull();
  });

  it('finds the declared screenshots', () => {
    expect(SCREENSHOTS.length).toBeGreaterThan(0);
  });

  it.each(SCREENSHOTS)('%s: %s is a light PNG or WebP of at most 1600 px', (id, file) => {
    const path = join(PLUGINS, id, GUIDE_SCREENSHOT_DIR, file);
    expect(existsSync(path), `${path} is declared but missing`).toBe(true);
    expect(statSync(path).size).toBeLessThanOrEqual(MAX_BYTES);
    const bytes = new Uint8Array(readFileSync(path));
    expect(imageFormat(bytes)).toBe(file.endsWith('.png') ? 'png' : 'webp');
    const width = imageWidth(bytes);
    expect(width).not.toBeNull();
    expect(width).toBeLessThanOrEqual(MAX_WIDTH);
  });

  it.each(PLUGIN_FOLDERS.map((folder) => [folder]))(
    'plugins/%s/docs/connect holds only declared files',
    (folder) => {
      const dir = join(PLUGINS, folder, GUIDE_SCREENSHOT_DIR);
      if (!existsSync(dir)) return;
      const declared = new Set(SCREENSHOTS.filter(([id]) => id === folder).map(([, f]) => f));
      const undeclared = readdirSync(dir).filter((name) => !declared.has(name));
      expect(undeclared, `undeclared files in ${dir}`).toEqual([]);
    },
  );
});
