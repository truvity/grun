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

  it('accepts a CDK qualifier of 1 to 10 lowercase letters and digits, and no other', () => {
    for (const ok of ['a', 'grun', 'hnb659fds', 'abcdefghij']) {
      const c: any = exampleConfig();
      c.cdk = { qualifier: ok };
      expect(() => validate(c), ok).not.toThrow();
    }
    for (const bad of ['', 'Grun', 'abcdefghijk', 'a-b', 'a_b']) {
      const c: any = exampleConfig();
      c.cdk = { qualifier: bad };
      expect(() => validate(c), bad).toThrow(/qualifier/);
    }
    const c: any = exampleConfig();
    c.cdk = { qualifer: 'grun' };
    expect(() => validate(c)).toThrow(/additional properties/);
  });

  it('accepts a runner group per organisation, and not an empty one', () => {
    const c: any = exampleConfig();
    c.orgs[0].runnerGroup = 'pilot';
    expect(() => validate(c)).not.toThrow();
    c.orgs[0].runnerGroup = '';
    expect(() => validate(c)).toThrow(/runnerGroup/);
  });

  it('accepts a Nix substituter that is an http(s) URL, and nothing that could add a line or a second cache', () => {
    for (const ok of ['https://nix.example.test/nix', 'http://cache.example.test/nix']) {
      const c: any = exampleConfig();
      c.runnerEnvironment.nixSubstituter = ok;
      expect(() => validate(c), ok).not.toThrow();
    }
    for (const bad of ['', 'cache.example.test/nix', 's3://bucket', 'https://a.test/nix https://b.test', 'https://a.test/nix\nsandbox = false']) {
      const c: any = exampleConfig();
      c.runnerEnvironment.nixSubstituter = bad;
      expect(() => validate(c), JSON.stringify(bad)).toThrow(/nixSubstituter/);
    }
  });

  it('accepts a Maven registry and a Gradle build cache that are http(s) URLs, and nothing that could carry a second value', () => {
    for (const key of ['mavenRegistry', 'gradleBuildCache']) {
      for (const ok of ['https://cache.example.test/maven', 'http://cache.example.test/gradle/cache']) {
        const c: any = exampleConfig();
        c.runnerEnvironment[key] = ok;
        expect(() => validate(c), `${key} ${ok}`).not.toThrow();
      }
      for (const bad of ['', 'cache.example.test/maven', 's3://bucket', 'https://a.test/x https://b.test', 'https://a.test/x\nCI_RUNNER_GOPROXY=evil']) {
        const c: any = exampleConfig();
        c.runnerEnvironment[key] = bad;
        expect(() => validate(c), `${key} ${JSON.stringify(bad)}`).toThrow(new RegExp(key));
      }
    }
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

  it('rejects a Fargate memory size that does not go with the vCPU, which ECS refuses at deploy time', () => {
    const shape = (vcpu: number, memoryGiB: number) => {
      const c: any = exampleConfig();
      c.shapes = [{ label: 'fg-x', vcpu, memoryGiB }];
      delete c.warm;
      return c;
    };
    for (const [v, m] of [[0.25, 0.5], [0.5, 4], [1, 2], [1, 8], [2, 16], [4, 30], [8, 60], [16, 120]]) {
      expect(() => validate(shape(v, m)), `${v}/${m}`).not.toThrow();
    }
    for (const [v, m] of [[0.25, 4], [0.5, 8], [1, 10], [2, 3], [4, 7], [8, 18], [16, 36]]) {
      expect(() => validate(shape(v, m)), `${v}/${m}`).toThrow(/Fargate memory size/);
    }
  });

  it('wants the webhook certificate in the stack region and the domain name in lowercase', () => {
    const c: any = exampleConfig();
    c.orgs[0].webhook.certificateArn = 'arn:partition:acm:us-east-1:account-id:certificate/x';
    expect(() => validate(c)).toThrow(/certificate is in us-east-1/);
    const d: any = exampleConfig();
    d.orgs[0].webhook.domainName = 'Runners.Example.test';
    expect(() => validate(d)).toThrow(/lowercase DNS name/);
    const e: any = exampleConfig();
    e.orgs[0].webhook.domainName = 'not a name';
    expect(() => validate(e)).toThrow(/lowercase DNS name/);
  });
});
