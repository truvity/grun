import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Synth, synth } from './helpers';

/**
 * Drift guard for the Deploy permissions boundary (the Go package in
 * ../../boundary). `just boundary-coverage` writes the coverage of the
 * boundary document: the IAM namespaces it allows and the CloudFormation
 * resource types they cover. Every resource type of the synthesised stack must
 * be covered, so a stack change cannot outgrow the boundary unnoticed: the
 * deploy would otherwise fail at the first resource of the new service, in
 * the account, after the change merged.
 */
interface Coverage {
  allowed: string[];
  full: string[];
  limited: Record<string, string[]>;
  namespaces: Record<string, string>;
  exempt: string[];
  customResourceNamespace: string;
}

const COVERAGE = path.join(__dirname, 'boundary-coverage.generated.json');

function loadCoverage(): Coverage {
  if (!fs.existsSync(COVERAGE)) {
    throw new Error('boundary-coverage.generated.json is missing: run `just boundary-coverage` (or `just cdk-test`, which does)');
  }
  return JSON.parse(fs.readFileSync(COVERAGE, 'utf8')) as Coverage;
}

/** The types of `types` the boundary does not cover, with the reason. */
export function uncovered(c: Coverage, types: string[]): string[] {
  const problems: string[] = [];
  for (const type of new Set(types)) {
    if (c.exempt.includes(type)) continue;
    let ns: string;
    if (type.startsWith('Custom::')) {
      ns = c.customResourceNamespace;
      if (!c.full.includes(ns)) problems.push(`${type}: its backing function needs "${ns}", which the boundary does not fully allow`);
      continue;
    }
    const m = /^AWS::([A-Za-z0-9]+)::/.exec(type);
    if (!m) {
      problems.push(`${type}: not an AWS:: or Custom:: type`);
      continue;
    }
    ns = c.namespaces[m[1]] ?? m[1].toLowerCase();
    if (c.full.includes(ns)) continue;
    if (c.limited[ns]?.includes(type)) continue;
    problems.push(
      c.allowed.includes(ns)
        ? `${type}: the boundary allows "${ns}" only for ${JSON.stringify(c.limited[ns])}`
        : `${type}: no allowed namespace "${ns}" in the boundary`,
    );
  }
  return problems;
}

describe('deploy permissions boundary', () => {
  let s: Synth;
  let coverage: Coverage;
  beforeAll(() => {
    coverage = loadCoverage();
    s = synth();
  });

  it('covers every resource type of the synthesised stack', () => {
    const types = Object.values<any>(s.json.Resources).map((r) => r.Type as string);
    expect(types.length).toBeGreaterThan(20);
    expect(uncovered(coverage, types)).toEqual([]);
  });

  it('is not vacuous: it names a type the boundary does not cover', () => {
    expect(
      uncovered(coverage, ['AWS::Lambda::Function', 'AWS::EC2::Instance', 'AWS::Organizations::Account', 'AWS::S3::Bucket', 'AWS::IAM::User']),
    ).toEqual([
      expect.stringContaining('AWS::EC2::Instance'),
      expect.stringContaining('AWS::Organizations::Account'),
      expect.stringContaining('AWS::IAM::User'),
    ]);
  });

  it('maps the irregular services', () => {
    expect(uncovered(coverage, ['AWS::StepFunctions::StateMachine', 'AWS::ApiGatewayV2::Api', 'AWS::CodeStarNotifications::NotificationRule'])).toEqual([]);
  });
});
