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
 *
 * It also covers service-linked roles. A resource type of some services makes
 * AWS create the service's role implicitly, in the deploy role's name, the
 * first time one exists in an account; the boundary must allow
 * iam:CreateServiceLinkedRole for that service (iam:AWSServiceName), or a first
 * deploy into a fresh account fails at that resource.
 */
interface Coverage {
  allowed: string[];
  full: string[];
  limited: Record<string, string[]>;
  namespaces: Record<string, string>;
  exempt: string[];
  customResourceNamespace: string;
  serviceLinkedRoles: string[];
  needsServiceLinkedRole: Record<string, string[]>;
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

/** The service-linked roles `types` can create that the boundary does not allow. */
export function missingServiceLinkedRoles(c: Coverage, types: string[]): string[] {
  const problems: string[] = [];
  for (const type of new Set(types)) {
    for (const service of c.needsServiceLinkedRole[type] ?? []) {
      if (!c.serviceLinkedRoles.includes(service)) {
        problems.push(`${type}: creating it can create the service-linked role of ${service}, which the boundary does not allow (iam:AWSServiceName)`);
      }
    }
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

  it('allows the service-linked role of every resource type of the synthesised stack that creates one', () => {
    const types = Object.values<any>(s.json.Resources).map((r) => r.Type as string);
    expect(missingServiceLinkedRoles(coverage, types)).toEqual([]);
    // The stack's own: if these stop being listed, the table is stale, not the stack.
    expect(Object.keys(coverage.needsServiceLinkedRole)).toEqual(
      expect.arrayContaining(['AWS::ApiGateway::DomainName', 'AWS::ECS::Cluster', 'AWS::CodeStarNotifications::NotificationRule']),
    );
  });

  it('is not vacuous for service-linked roles: a missing one is reported', () => {
    const without = (service: string): Coverage => ({
      ...coverage,
      serviceLinkedRoles: coverage.serviceLinkedRoles.filter((x) => x !== service),
    });
    const types = ['AWS::ApiGateway::DomainName', 'AWS::ECS::Cluster', 'AWS::Lambda::Function'];
    expect(missingServiceLinkedRoles(without('ops.apigateway.amazonaws.com'), types)).toEqual([
      expect.stringContaining('AWS::ApiGateway::DomainName'),
    ]);
    expect(missingServiceLinkedRoles(without('ecs.amazonaws.com'), types)).toEqual([expect.stringContaining('AWS::ECS::Cluster')]);
    expect(missingServiceLinkedRoles(coverage, types)).toEqual([]);
  });
});
