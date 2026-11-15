/**
 * `classifyFly` : one case per branch — the slices and the risks each tool
 * touches, then every refusal (unknown tool, app outside the mission,
 * ambiguous app, malformed identifiers, undeclared arguments, the image
 * guard, a creation without its own network). Hostile identifiers are fed to
 * `classify` and to `execute`.
 */
import { describe, expect, test } from 'vitest';

import { serializeSlice, type Resource } from '@vaubaan/plugin-sdk';
import { mockFetch, risksTouchedByAll } from '@vaubaan/plugin-sdk/testing';

import { TOOL } from '../../src/identity.ts';
import { classifyFly, flyCatalog, flyPlugin } from '../../src/index.ts';
import { DIGEST, IMAGE, acme, app, canary, config, context } from './fixtures.ts';

function slices(
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [acme],
) {
  const out = classifyFly(tool, args, resources);
  if ('denied' in out) throw new Error(out.denied);
  return out.slices.map(serializeSlice);
}

function risks(
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [acme],
) {
  const out = classifyFly(tool, args, resources);
  if ('denied' in out) throw new Error(out.denied);
  return [...risksTouchedByAll(out.slices, flyCatalog.indexed)].sort();
}

function denial(
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [acme],
) {
  const out = classifyFly(tool, args, resources);
  return 'denied' in out ? out.denied : null;
}

const A = 'fly.org[vaubaan].app[acme-gw]';
const M = { app: 'acme-gw', machine_id: 'm1' };

describe('organization tools', () => {
  test('regions and apps are read on the organization of the mission', () => {
    expect(slices(TOOL.listRegions, {})).toEqual(['fly.org[vaubaan].region[*].R']);
    expect(slices(TOOL.listApps, {})).toEqual(['fly.org[vaubaan].app[*].R']);
    expect(risks(TOOL.listApps, {})).toEqual(['fly.read-org']);
  });

  test('without an app in the mission, the organization is any', () => {
    expect(slices(TOOL.listApps, {}, [])).toEqual(['fly.org[*].app[*].R']);
  });

  test('creating an app writes the collection, on its own network only', () => {
    expect(slices(TOOL.createApp, { name: 'beta-gw', network: 'beta-net' })).toEqual([
      'fly.org[vaubaan].app.W',
    ]);
    expect(risks(TOOL.createApp, { name: 'beta-gw', network: 'beta-net' })).toEqual([
      'fly.app-create',
    ]);
    expect(denial(TOOL.createApp, { name: 'beta-gw' })).toMatch(/^network: required/);
    expect(denial(TOOL.createApp, { name: 'beta-gw', network: '' })).toMatch(/^network: required/);
    expect(denial(TOOL.createApp, { name: 'Beta_GW', network: 'n' })).toMatch(/^name:/);
    expect(denial(TOOL.createApp, { name: 'b', network: 'n', org_slug: 'other' })).toMatch(
      /^org_slug: not an argument/,
    );
  });
});

describe("the account's organization", () => {
  const account = { fields: { org_slug: 'vaubaan', image_prefixes: 'ghcr.io/vaubaan/' } };
  const cite = (
    tool: string,
    args: Record<string, unknown>,
    resources: readonly Resource[],
    conn?: { fields: Record<string, string> },
  ) => {
    const out = classifyFly(tool, args, resources, conn);
    if ('denied' in out) throw new Error(out.denied);
    return out.slices.map(serializeSlice);
  };

  test('a creation in a mission with no app names the organization of the account', () => {
    // The dogfood refusal of 2026-10-16 cited `fly.org[*].app.W`.
    expect(cite(TOOL.createApp, { name: 'beta-gw', network: 'beta-net' }, [], account)).toEqual([
      'fly.org[vaubaan].app.W',
    ]);
    expect(cite(TOOL.listRegions, {}, [], account)).toEqual(['fly.org[vaubaan].region[*].R']);
  });

  test('the risk touched is the same whatever the organization is called', () => {
    const named = classifyFly(TOOL.createApp, { name: 'b', network: 'n' }, [], account);
    const any = classifyFly(TOOL.createApp, { name: 'b', network: 'n' }, []);
    if ('denied' in named || 'denied' in any) throw new Error('refused');
    expect([...risksTouchedByAll(named.slices, flyCatalog.indexed)]).toEqual([
      ...risksTouchedByAll(any.slices, flyCatalog.indexed),
    ]);
  });

  test("the account's organization is the one an app call cites", () => {
    expect(cite(TOOL.getApp, {}, [acme], { fields: { org_slug: 'vaubaan' } })).toEqual([
      'fly.org[vaubaan].app[acme-gw].R',
    ]);
  });

  test('a missing or malformed field leaves the organization to the resources, else any', () => {
    const malformed: Record<string, string>[] = [
      {},
      { org_slug: '' },
      { org_slug: 'Not A Slug' },
      { org_slug: '*' },
    ];
    for (const fields of malformed) {
      expect(cite(TOOL.createApp, { name: 'b', network: 'n' }, [], { fields })).toEqual([
        'fly.org[*].app.W',
      ]);
      expect(cite(TOOL.listApps, {}, [acme], { fields })).toEqual(['fly.org[vaubaan].app[*].R']);
    }
  });

  test('the organization never comes from the arguments', () => {
    expect(denial(TOOL.createApp, { name: 'b', network: 'n', org_slug: 'vaubaan' }, [])).toMatch(
      /^org_slug: not an argument/,
    );
  });
});

describe('app resolution', () => {
  test('the named app must be one of the mission; absent, the single app', () => {
    expect(slices(TOOL.getApp, { app: 'canary-gw' }, [acme, canary])).toEqual([
      'fly.org[vaubaan].app[canary-gw].R',
    ]);
    expect(slices(TOOL.getApp, {})).toEqual([`${A}.R`]);
    expect(denial(TOOL.getApp, { app: 'canary-gw' })).toBe(
      "app 'canary-gw' is not an app of this mission",
    );
    expect(denial(TOOL.getApp, {}, [acme, canary])).toBe(
      'app: argument missing and the mission has 2 Fly apps — name one',
    );
    expect(denial(TOOL.getApp, {}, [])).toBe(
      'app: argument missing and the mission has no Fly app',
    );
    const foreign: Resource = { ...acme, service: 'railway' };
    expect(denial(TOOL.getApp, { app: 'acme-gw' }, [foreign])).toBe(
      "app 'acme-gw' is not an app of this mission",
    );
  });

  test('the app is checked before the arguments', () => {
    expect(denial(TOOL.getApp, { app: 'other', force: true })).toBe(
      "app 'other' is not an app of this mission",
    );
    expect(denial(TOOL.getApp, { app: 'acme-gw', force: true })).toMatch(/^force: not an argument/);
  });

  test('an app of another organization is classified under its own organization', () => {
    const other = {
      ...app('x-gw', 'prod', 'id-x'),
      metadata: { org_slug: 'other', app_id: 'id-x' },
    };
    expect(slices(TOOL.getApp, { app: 'x-gw' }, [other])).toEqual(['fly.org[other].app[x-gw].R']);
  });
});

describe('machines', () => {
  test('reads', () => {
    expect(slices(TOOL.listMachines, { app: 'acme-gw' })).toEqual([`${A}.machine[*].R`]);
    expect(slices(TOOL.getMachine, M)).toEqual([`${A}.machine[m1].R`]);
    expect(slices(TOOL.waitMachine, { ...M, state: 'started' })).toEqual([`${A}.machine[m1].R`]);
    expect(slices(TOOL.listMachineEvents, M)).toEqual([`${A}.machine[m1].event[*].R`]);
    expect(slices(TOOL.listMachineProcesses, M)).toEqual([`${A}.machine[m1].process[*].R`]);
    expect(risks(TOOL.listMachineProcesses, M)).toEqual(['fly.read-runtime']);
  });

  test('creating a machine writes the collection, a configuration and an image', () => {
    const args = { app: 'acme-gw', config: config(), region: 'cdg' };
    expect(slices(TOOL.createMachine, args)).toEqual([
      `${A}.machine.W`,
      `${A}.machine.config.W`,
      `${A}.machine.image.W`,
    ]);
    expect(risks(TOOL.createMachine, args)).toEqual([
      'fly.deploy',
      'fly.machine-config-write',
      'fly.machine-create',
    ]);
    expect(denial(TOOL.createMachine, { app: 'acme-gw', config: config() })).toMatch(/^region:/);
  });

  test('a whole config may change what runs and its size : three risks', () => {
    expect(risks(TOOL.updateMachine, { ...M, config: config() })).toEqual([
      'fly.deploy',
      'fly.machine-config-write',
      'fly.scale',
    ]);
  });

  test('deploy_image and scale_machine touch one risk each', () => {
    expect(slices(TOOL.deployImage, { ...M, image: IMAGE })).toEqual([`${A}.machine[m1].image.W`]);
    expect(risks(TOOL.deployImage, { ...M, image: IMAGE })).toEqual(['fly.deploy']);
    const scale = { ...M, cpu_kind: 'performance', cpus: 2, memory_mb: 4096 };
    expect(risks(TOOL.scaleMachine, scale)).toEqual(['fly.scale']);
    expect(denial(TOOL.scaleMachine, { ...M, cpu_kind: 'gpu', cpus: 2, memory_mb: 4096 })).toMatch(
      /^cpu_kind/,
    );
  });

  test('power, destruction and exec have their own leaves', () => {
    for (const tool of [
      TOOL.startMachine,
      TOOL.stopMachine,
      TOOL.restartMachine,
      TOOL.suspendMachine,
      TOOL.cordonMachine,
      TOOL.uncordonMachine,
    ]) {
      expect(risks(tool, M)).toEqual(['fly.machine-power']);
    }
    expect(slices(TOOL.destroyMachine, M)).toEqual([`${A}.machine[m1].machine-destroy.W`]);
    expect(risks(TOOL.destroyMachine, M)).toEqual(['fly.machine-destroy']);
    expect(risks(TOOL.execMachine, { ...M, command: ['sh', '-c', 'env'] })).toEqual([
      'fly.machine-exec',
    ]);
  });

  test('exec : a non-empty list of strings, a bounded timeout, no machine namespace', () => {
    expect(denial(TOOL.execMachine, { ...M, command: 'env' })).toMatch(/^command:/);
    expect(denial(TOOL.execMachine, { ...M, command: [] })).toMatch(/^command:/);
    expect(denial(TOOL.execMachine, { ...M, command: ['ls', 3] })).toMatch(/^command:/);
    expect(denial(TOOL.execMachine, { ...M, command: ['ls'], timeout: 600 })).toMatch(/^timeout:/);
    expect(denial(TOOL.execMachine, { ...M, command: ['ls'], machine: true })).toMatch(
      /^machine: not an argument/,
    );
  });

  test('wait : a known state', () => {
    expect(denial(TOOL.waitMachine, { ...M, state: 'gone' })).toMatch(/^state:/);
  });
});

describe('the image guard', () => {
  const deploy = (image: unknown, resources: readonly Resource[] = [acme]) =>
    denial(TOOL.deployImage, { ...M, image }, resources);

  test('an image pinned by digest under the allowed prefix passes, with or without a tag', () => {
    expect(deploy(IMAGE)).toBeNull();
    expect(deploy(`ghcr.io/vaubaan/gateway@sha256:${DIGEST}`)).toBeNull();
    expect(deploy(`ghcr.io/vaubaan/gateway/edge@sha256:${DIGEST}`)).toBeNull();
  });

  test('a tag alone, a short or upper-case digest, another algorithm are refused', () => {
    expect(deploy('ghcr.io/vaubaan/gateway:1.4.0')).toMatch(/not pinned by digest/);
    expect(deploy('ghcr.io/vaubaan/gateway:latest')).toMatch(/not pinned by digest/);
    expect(deploy(`ghcr.io/vaubaan/gateway@sha256:${'a'.repeat(63)}`)).toMatch(/not pinned/);
    expect(deploy(`ghcr.io/vaubaan/gateway@sha256:${'A'.repeat(64)}`)).toMatch(/not pinned/);
    expect(deploy(`ghcr.io/vaubaan/gateway@sha512:${DIGEST}`)).toMatch(/not pinned/);
    expect(deploy('')).toMatch(/^image: missing/);
    expect(deploy(undefined)).toMatch(/^image: missing/);
  });

  test('an image outside the prefixes is refused, including a look-alike repository', () => {
    expect(deploy(`ghcr.io/vaubaan/gateway-evil@sha256:${DIGEST}`)).toMatch(/is not an image this/);
    expect(deploy(`ghcr.io/attacker/gateway@sha256:${DIGEST}`)).toMatch(/is not an image this/);
    expect(deploy(`docker.io/library/nginx@sha256:${DIGEST}`)).toMatch(/is not an image this/);
    expect(deploy(`ghcr.io/vaubaan/../attacker/x@sha256:${DIGEST}`)).toMatch(/not pinned/);
    expect(deploy(`localhost:5000/vaubaan/gateway@sha256:${DIGEST}`)).toMatch(/not pinned/);
  });

  test('the prefixes are those discovery recorded on the app', () => {
    const wider = {
      ...acme,
      metadata: { ...acme.metadata, image_prefixes: 'ghcr.io/vaubaan/gateway,registry.fly.io/' },
    };
    expect(deploy(`registry.fly.io/acme-gw@sha256:${DIGEST}`, [wider])).toBeNull();
    expect(deploy(`registry.fly.io/acme-gw@sha256:${DIGEST}`)).toMatch(/is not an image this/);
    const unrecorded = { ...acme, metadata: { app_id: 'app-acme', org_slug: 'vaubaan' } };
    expect(deploy(IMAGE, [unrecorded])).toMatch(/refresh the account's resources/);
    const malformed = { ...acme, metadata: { ...acme.metadata, image_prefixes: 'ghcr.io/*' } };
    expect(deploy(IMAGE, [malformed])).toMatch(/refresh the account's resources/);
  });

  test('every image of a config is checked : containers and image-config files too', () => {
    const create = (cfg: unknown) =>
      denial(TOOL.createMachine, { app: 'acme-gw', config: cfg, region: 'cdg' });
    expect(create({ image: IMAGE, containers: [{ image: IMAGE }] })).toBeNull();
    expect(create({ image: IMAGE, containers: [{ image: 'busybox' }] })).toMatch(/not pinned/);
    expect(
      create({ image: IMAGE, files: [{ image_config: 'busybox', guest_path: '/x' }] }),
    ).toMatch(/not pinned/);
    expect(create({ guest: {} })).toMatch(/^config:/);
    expect(create('nope')).toMatch(/^config:/);
    expect(create({ image: IMAGE, containers: 'x' })).toMatch(/^config:/);
    expect(denial(TOOL.updateMachine, { ...M, config: config('nginx') })).toMatch(/not pinned/);
  });
});

describe('volumes', () => {
  const V = { app: 'acme-gw', volume_id: 'vol_1' };
  test('an empty volume is one risk ; a source adds the restore ; backup settings add theirs', () => {
    const base = { app: 'acme-gw', name: 'data', region: 'cdg', size_gb: 1 };
    expect(slices(TOOL.createVolume, base)).toEqual([`${A}.volume.W`]);
    expect(risks(TOOL.createVolume, base)).toEqual(['fly.volume-create']);
    expect(risks(TOOL.createVolume, { ...base, snapshot_id: 'vs_1' })).toEqual([
      'fly.volume-create',
      'fly.volume-restore',
    ]);
    expect(risks(TOOL.createVolume, { ...base, source_volume_id: 'vol_2' })).toEqual([
      'fly.volume-create',
      'fly.volume-restore',
    ]);
    expect(risks(TOOL.createVolume, { ...base, auto_backup_enabled: false })).toEqual([
      'fly.volume-backup-settings',
      'fly.volume-create',
    ]);
    expect(
      denial(TOOL.createVolume, { ...base, snapshot_id: 'vs_1', source_volume_id: 'vol_2' }),
    ).toMatch(/give one source/);
    expect(denial(TOOL.createVolume, { ...base, name: 'my-data' })).toMatch(/^name:/);
    expect(denial(TOOL.createVolume, { ...base, size_gb: 0 })).toMatch(/^size_gb:/);
  });

  test('extend, backup settings, snapshot, destroy', () => {
    expect(risks(TOOL.extendVolume, { ...V, size_gb: 5 })).toEqual(['fly.volume-extend']);
    expect(risks(TOOL.updateVolume, { ...V, auto_backup_enabled: true })).toEqual([
      'fly.volume-backup-settings',
    ]);
    expect(denial(TOOL.updateVolume, V)).toMatch(/give at least one/);
    expect(denial(TOOL.updateVolume, { ...V, snapshot_retention: 90 })).toMatch(
      /^snapshot_retention/,
    );
    expect(risks(TOOL.createSnapshot, V)).toEqual(['fly.volume-snapshot']);
    expect(slices(TOOL.listSnapshots, V)).toEqual([`${A}.volume[vol_1].snapshot[*].R`]);
    expect(risks(TOOL.destroyVolume, V)).toEqual(['fly.volume-destroy']);
  });
});

describe('secrets, addresses, certificates, logs', () => {
  test('secret names are read ; writes name each secret', () => {
    expect(risks(TOOL.listSecrets, { app: 'acme-gw' })).toEqual(['fly.read-secret-names']);
    expect(slices(TOOL.setSecrets, { app: 'acme-gw', values: { B: '2', A: '1' } })).toEqual([
      `${A}.secret[A,B].W`,
    ]);
    expect(slices(TOOL.setSecrets, { app: 'acme-gw', values: { ONE: 'x' } })).toEqual([
      `${A}.secret[ONE].W`,
    ]);
    expect(risks(TOOL.unsetSecret, { app: 'acme-gw', name: 'ONE' })).toEqual(['fly.secret-write']);
    expect(denial(TOOL.setSecrets, { app: 'acme-gw', values: {} })).toMatch(/1 to 50/);
    expect(denial(TOOL.setSecrets, { app: 'acme-gw', values: { 'A-B': 'x' } })).toMatch(
      /environment variable name/,
    );
    expect(denial(TOOL.setSecrets, { app: 'acme-gw', values: { A: 1 } })).toMatch(/each value/);
    expect(denial(TOOL.setSecrets, { app: 'acme-gw', values: 'A=1' })).toMatch(/^values:/);
  });

  test('IP addresses : allocation, release with its own leaf, IPv6 written as any', () => {
    expect(risks(TOOL.allocateIp, { app: 'acme-gw', type: 'v4' })).toEqual(['fly.ip-write']);
    expect(denial(TOOL.allocateIp, { app: 'acme-gw', type: 'egress_v4' })).toMatch(/^type:/);
    expect(slices(TOOL.releaseIp, { app: 'acme-gw', ip: '137.66.1.2' })).toEqual([
      `${A}.ip[137.66.1.2].ip-release.W`,
    ]);
    expect(slices(TOOL.releaseIp, { app: 'acme-gw', ip: '2a09:8280:1::1' })).toEqual([
      `${A}.ip[*].ip-release.W`,
    ]);
    expect(risks(TOOL.releaseIp, { app: 'acme-gw', ip: '2a09:8280:1::1' })).toEqual([
      'fly.ip-release',
    ]);
    expect(denial(TOOL.releaseIp, { app: 'acme-gw', ip: '999.1.1.1' })).toMatch(/^ip:/);
  });

  test('certificates : request and check write, removal has its own leaf', () => {
    const H = { app: 'acme-gw', hostname: 'acme.example.com' };
    expect(risks(TOOL.requestCertificate, H)).toEqual(['fly.certificate-write']);
    expect(risks(TOOL.checkCertificate, H)).toEqual(['fly.certificate-write']);
    expect(risks(TOOL.removeCertificate, H)).toEqual(['fly.certificate-remove']);
    expect(risks(TOOL.getCertificate, H)).toEqual(['fly.read-runtime']);
    expect(denial(TOOL.requestCertificate, { ...H, hostname: '*.example.com' })).toMatch(
      /^hostname:/,
    );
    expect(denial(TOOL.requestCertificate, { ...H, hostname: 'Acme.example.com' })).toMatch(
      /^hostname:/,
    );
    expect(denial(TOOL.requestCertificate, { ...H, hostname: 'localhost' })).toMatch(/^hostname:/);
  });

  test('logs', () => {
    expect(slices(TOOL.getLogs, { app: 'acme-gw' })).toEqual([`${A}.logs.R`]);
    expect(risks(TOOL.getLogs, { app: 'acme-gw' })).toEqual(['fly.read-logs']);
    expect(denial(TOOL.getLogs, { app: 'acme-gw', next_token: '2026-10-16' })).toMatch(
      /^next_token/,
    );
  });

  test('destroying an app has its own leaf', () => {
    expect(slices(TOOL.destroyApp, { app: 'acme-gw' })).toEqual([`${A}.app-destroy.W`]);
    expect(risks(TOOL.destroyApp, { app: 'acme-gw' })).toEqual(['fly.app-destroy']);
    expect(denial(TOOL.destroyApp, { app: 'acme-gw', force: true })).toMatch(
      /^force: not an argument/,
    );
  });
});

describe('refusals', () => {
  test('an unknown tool', () => {
    expect(denial('fly__delete_org', {})).toBe("unknown tool 'fly__delete_org'");
    expect(denial('fly__create_deploy_token', { app: 'acme-gw' })).toBe(
      "unknown tool 'fly__create_deploy_token'",
    );
  });

  test('show_secrets is not an argument : secret values are never asked for', () => {
    expect(denial(TOOL.listSecrets, { app: 'acme-gw', show_secrets: true })).toMatch(
      /^show_secrets: not an argument/,
    );
  });

  test('hostile identifiers are refused by classify, and execute sends nothing', async () => {
    const positions: [string, Record<string, unknown>, string][] = [
      [TOOL.getApp, {}, 'app'],
      [TOOL.getMachine, { app: 'acme-gw' }, 'machine_id'],
      [TOOL.destroyMachine, { app: 'acme-gw' }, 'machine_id'],
      [TOOL.getVolume, { app: 'acme-gw' }, 'volume_id'],
      [TOOL.destroyVolume, { app: 'acme-gw' }, 'volume_id'],
      [TOOL.unsetSecret, { app: 'acme-gw' }, 'name'],
      [TOOL.releaseIp, { app: 'acme-gw' }, 'ip'],
      [TOOL.removeCertificate, { app: 'acme-gw' }, 'hostname'],
      [TOOL.getLogs, { app: 'acme-gw' }, 'machine_id'],
    ];
    const hostile = [
      '..',
      '.',
      'a/../b',
      '%2e%2e',
      '..%2f',
      '%2f',
      '../',
      '',
      'x'.repeat(300),
      'a\nb',
      'r1?x=1#y',
    ];
    for (const [tool, base, argument] of positions) {
      for (const value of hostile) {
        const args = { ...base, [argument]: value };
        expect(denial(tool, args), `${tool} ${argument}=${JSON.stringify(value)}`).not.toBeNull();
        const fetch = mockFetch([]);
        const result = await flyPlugin.execute(context(fetch), tool, args);
        expect(result.isError).toBe(true);
        expect(fetch.calls).toHaveLength(0);
      }
    }
  });

  test('a resource whose ref is not an app name is never used', () => {
    const dotted: Resource = { ...acme, ref: '..' };
    expect(denial(TOOL.getApp, {}, [dotted])).toBe(
      'app: the app of this mission is not a Fly app name',
    );
    expect(denial(TOOL.getApp, { app: '..' }, [dotted])).toBe('app: malformed app name');
  });
});
