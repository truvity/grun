import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { EXECUTION_ROLE, render, roundTrip, shippedTemplatePath, withBoundaryEverywhere } from '../bootstrap/template';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grun-bootstrap-test-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The shipped template, parsed as plain YAML (it uses no short-form tags). */
const source = (): any => parse(fs.readFileSync(shippedTemplatePath(), 'utf8'));

/** Writes a template (changed first) as JSON, which CfnInclude also reads. */
function write(name: string, mutate: (t: any) => void): string {
  const t = source();
  mutate(t);
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(t));
  return file;
}

const ofType = (t: any, type: string): [string, any][] =>
  Object.entries<any>(t.Resources).filter(([, r]) => r.Type === type);

/** Every path where `b` has a value `a` does not, and where they differ otherwise. */
function diff(a: any, b: any, at = ''): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) =>
      !(k in a) ? [`+ ${at}/${k}`] : !(k in b) ? [`- ${at}/${k}`] : diff(a[k], b[k], `${at}/${k}`),
    );
  }
  return [`~ ${at}`];
}

describe('bootstrap template', () => {
  const generated = withBoundaryEverywhere(shippedTemplatePath()) as any;
  const execBoundary = source().Resources[EXECUTION_ROLE].Properties.PermissionsBoundary;

  it('the pinned CLI still ships a template whose execution role has a boundary', () => {
    expect(execBoundary).toBeDefined();
  });

  it('puts the PermissionsBoundary on every AWS::IAM::Role', () => {
    const roles = ofType(generated, 'AWS::IAM::Role');
    expect(roles.length).toBeGreaterThan(1);
    for (const [id, role] of roles) {
      expect(role.Properties.PermissionsBoundary, id).toEqual(execBoundary);
    }
  });

  it('changes nothing but the added PermissionsBoundary properties', () => {
    const changes = diff(source(), generated);
    expect(changes.length).toBeGreaterThan(0);
    for (const c of changes) {
      const m = /^\+ \/Resources\/([^/]+)\/Properties\/PermissionsBoundary$/.exec(c);
      expect(m, c).not.toBeNull();
      expect(source().Resources[m![1]].Type).toBe('AWS::IAM::Role');
    }
    // The execution role was not among them: it already had its boundary.
    expect(changes.join('\n')).not.toContain(`/${EXECUTION_ROLE}/`);
  });

  it('is what CDK renders for the untouched template: the round trip adds nothing', () => {
    const t = roundTrip(shippedTemplatePath());
    expect(diff(source(), t)).toEqual([]);
    expect(Object.keys(t)).not.toContain('Rules');
    expect(Object.keys((t as any).Parameters)).not.toContain('BootstrapVersion');
    expect(JSON.stringify(t)).not.toContain('aws:cdk:');
  });

  it('writes JSON that parses back to the same template', () => {
    expect(JSON.parse(render(generated))).toEqual(generated);
  });

  it('fails when the execution role has no PermissionsBoundary', () => {
    const file = write('no-boundary', (t) => {
      delete t.Resources[EXECUTION_ROLE].Properties.PermissionsBoundary;
    });
    expect(() => withBoundaryEverywhere(file)).toThrow(/no PermissionsBoundary/);
  });

  it('fails when the template has no execution role', () => {
    const file = write('no-exec-role', (t) => {
      delete t.Resources[EXECUTION_ROLE];
    });
    expect(() => withBoundaryEverywhere(file)).toThrow(EXECUTION_ROLE);
  });

  it('bounds an AWS::IAM::User too, and leaves a boundary that is already set', () => {
    const own = 'arn:own-boundary';
    const file = write('user', (t) => {
      t.Resources.ExtraUser = { Type: 'AWS::IAM::User', Properties: {} };
      t.Resources.ExtraRole = {
        Type: 'AWS::IAM::Role',
        Properties: { AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] }, PermissionsBoundary: own },
      };
    });
    const t = withBoundaryEverywhere(file) as any;
    expect(t.Resources.ExtraUser.Properties.PermissionsBoundary).toEqual(execBoundary);
    expect(t.Resources.ExtraRole.Properties.PermissionsBoundary).toBe(own);
  });
});
