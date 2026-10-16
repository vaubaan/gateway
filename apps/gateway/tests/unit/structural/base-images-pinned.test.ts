/**
 * Structural test: one commit builds one image. Every base image the
 * deployment files pull is pinned by full version **and** by digest, and the
 * documentation quotes the versions that are pinned.
 *
 * A digest does not follow the security fixes of its tag: it is refreshed by
 * hand, by the procedure of `docs/workflow/coding-workflow.md`, "Refreshing
 * the base image digests" — whose existence this test also holds, since a
 * pin nobody knows how to move is worse than a tag.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const read = (path: string): string => readFileSync(resolve(REPO, path), 'utf8');

/** `name:1.2.3-flavour@sha256:<64 hex>`: a full version, never `latest`, never a bare major. */
const PINNED = /^([a-z0-9./-]+):(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?)@sha256:[0-9a-f]{64}$/;

/** The image of the first stage, `base`, which every other stage starts from. */
function dockerfileBase(): string {
  const dockerfile = read('deploy/docker/Dockerfile');
  const base = /^FROM\s+(\S+)\s+AS\s+base$/m.exec(dockerfile)?.[1];
  if (!base) throw new Error('deploy/docker/Dockerfile has no `FROM <image> AS base` stage');
  return base;
}

/** Every `image:` of the Compose file that is pulled (the gateway's own image is built). */
function composeImages(): string[] {
  return [...read('deploy/compose.yaml').matchAll(/^\s+image:\s*(\S+)\s*$/gm)]
    .map((match) => match[1] ?? '')
    .filter((image) => !image.startsWith('vaubaan-gateway:'));
}

describe('base images are pinned by version and digest', () => {
  it('the Dockerfile builds every stage from the one pinned base image', () => {
    const dockerfile = read('deploy/docker/Dockerfile');
    expect(dockerfileBase()).toMatch(PINNED);
    const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1]);
    expect(froms.length).toBeGreaterThan(1);
    // The first stage names the image; each other one starts from a stage of this
    // file: no second image, and no ARG that a build could point elsewhere.
    expect(froms[0]).toBe(dockerfileBase());
    const stages = new Set(
      [...dockerfile.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gm)].map((match) => match[1]),
    );
    for (const from of froms.slice(1)) expect(stages.has(from), from).toBe(true);
    expect(dockerfile).not.toMatch(/^FROM\s+\S*\$/m);
  });

  it('nothing else runs in the build: no unpinned frontend, no image copied from', () => {
    const dockerfile = read('deploy/docker/Dockerfile');
    // `# syntax=<image>` makes BuildKit pull that image and run it as the frontend of the
    // build: it has more power over the result than the base image. None is needed (the
    // file uses no heredoc, no `--mount`, no `--link`); one that appears is pinned.
    const frontend = /^#\s*syntax\s*=\s*(\S+)/m.exec(dockerfile)?.[1];
    if (frontend !== undefined) expect(frontend).toMatch(PINNED);
    // `COPY --from=` and `RUN --mount=…from=` name a stage of this file, never an image.
    const stages = new Set(
      [...dockerfile.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gm)].map((match) => match[1]),
    );
    const sources = [...dockerfile.matchAll(/\bfrom=([^\s,]+)/g)].map((match) => match[1] ?? '');
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) expect(stages.has(source), source).toBe(true);
  });

  it('the Compose file pins every image it pulls', () => {
    const images = composeImages();
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) expect(image, image).toMatch(PINNED);
  });

  it('the documentation quotes the versions that are pinned', () => {
    const quoted = `${read('deploy/README.md')}\n${read('docs/workflow/coding-workflow.md')}`;
    for (const image of [dockerfileBase(), ...composeImages()]) {
      const [, name, version] = PINNED.exec(image) ?? [];
      expect(quoted, `${name}:${version}`).toContain(`${name}:${version}`);
    }
  });

  it('the refresh procedure is written down where the pins point to', () => {
    const workflow = read('docs/workflow/coding-workflow.md');
    expect(workflow).toContain('### Refreshing the base image digests');
    expect(workflow).toContain('docker buildx imagetools inspect');
    expect(read('deploy/README.md')).toContain('#refreshing-the-base-image-digests');
  });
});
