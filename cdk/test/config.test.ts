import { describe, expect, it } from 'vitest';
import { crossChecks, validate } from '../lib/config';
import { exampleConfig } from './helpers';

describe('config', () => {
  it('accepts the example', () => {
    expect(() => validate(exampleConfig())).not.toThrow();
  });

  it('rejects a key it does not know', () => {
    const c: any = exampleConfig();
    c.sluice = {};
    expect(() => validate(c)).toThrow(/additional properties/);
  });

  it('rejects a missing required section', () => {
    const c: any = exampleConfig();
    delete c.alerts;
    expect(() => validate(c)).toThrow(/alerts/);
  });

  it('rejects a Fargate storage size below the minimum and above the maximum', () => {
    const c: any = exampleConfig();
    c.shapes = [{ label: 'fg-x', vcpu: 1, memoryGiB: 4, ephemeralStorageGiB: 10 }];
    expect(() => validate(c)).toThrow(/ephemeralStorageGiB/);
    c.shapes[0].ephemeralStorageGiB = 300;
    expect(() => validate(c)).toThrow(/ephemeralStorageGiB/);
  });

  it('rejects a TLS directory that is not a plain absolute path', () => {
    const c: any = exampleConfig();
    c.buildkit.tlsDir = '/etc/$HOME';
    expect(() => validate(c)).toThrow(/tlsDir/);
  });

  it('cross-checks duplicates, warm pools and role name length', () => {
    const c: any = exampleConfig();
    c.orgs[1].name = c.orgs[0].name;
    c.warm.pools.push({ shape: 'fg-huge', count: 1 });
    const problems = crossChecks(c);
    expect(problems.join('\n')).toMatch(/duplicate name/);
    expect(problems.join('\n')).toMatch(/unknown shape fg-huge/);

    const long: any = exampleConfig();
    long.env = 'a'.repeat(16);
    long.orgs[0].name = 'o'.repeat(39);
    expect(crossChecks(long).join('\n')).toMatch(/role name too long/);
  });

  it('rejects a secret variable that is also set as plain environment', () => {
    const c: any = exampleConfig();
    c.runner.secretEnv.CI_BUILDKIT_TLS_SERVERNAME = '/example/ci/x';
    expect(crossChecks(c).join('\n')).toMatch(/runner.secretEnv.CI_BUILDKIT_TLS_SERVERNAME: also set as plain/);
    const d: any = exampleConfig();
    d.orgs[1].environment.CI_BUILDKIT_TLS_KEY_PEM = 'x';
    expect(crossChecks(d).join('\n')).toMatch(/runner.secretEnv.CI_BUILDKIT_TLS_KEY_PEM/);
  });

  it('rejects a secret variable name that is not an upper case identifier, and a value that is not a parameter', () => {
    const c: any = exampleConfig();
    c.runner.secretEnv = { lower: '/a/b' };
    expect(() => validate(c)).toThrow(/runner\/secretEnv/);
    c.runner.secretEnv = { UPPER: 'arn:partition:secretsmanager:eu-central-1:account-id:secret:x' };
    expect(() => validate(c)).toThrow(/pattern/);
  });

  it('rejects cost tag keys that are not tag keys', () => {
    const c: any = exampleConfig();
    c.costTags = { componentKey: 'has space' };
    expect(() => validate(c)).toThrow(/componentKey/);
  });

  it('wants a subnet for every availability zone', () => {
    const c: any = exampleConfig();
    c.network.publicSubnetIds.pop();
    expect(() => validate(c)).toThrow(/same length/);
  });
});
