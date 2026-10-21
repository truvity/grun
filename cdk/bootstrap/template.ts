/**
 * The CDK bootstrap template with the permissions boundary on every role.
 *
 * `cdk bootstrap --custom-permissions-boundary <name>` sets the
 * InputPermissionsBoundary parameter, but the default bootstrap template
 * applies it to CloudFormationExecutionRole only. FilePublishingRole,
 * ImagePublishingRole, LookupRole and DeploymentActionRole are created without
 * a boundary, which an account that lets people create only bounded roles
 * refuses. This module reads the template shipped in the pinned `aws-cdk` CLI
 * package and gives every role (and user) the same PermissionsBoundary as the
 * execution role. Nothing else changes, so the input is reproducible: the CLI
 * version is pinned by package-lock.json.
 *
 *   npx tsx bootstrap/template.ts <out.json> [<source template>]
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, BootstraplessSynthesizer, Stack } from 'aws-cdk-lib';
import { CfnInclude } from 'aws-cdk-lib/cloudformation-include';
import { CfnRole, CfnUser } from 'aws-cdk-lib/aws-iam';

/** The role whose PermissionsBoundary the others copy. */
export const EXECUTION_ROLE = 'CloudFormationExecutionRole';

/** A CloudFormation template as JSON. */
export type CfnTemplate = { Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }> } & Record<
  string,
  unknown
>;

/** The bootstrap template of the pinned `aws-cdk` CLI package. */
export function shippedTemplatePath(): string {
  return require.resolve('aws-cdk/lib/api/bootstrap/bootstrap-template.yaml');
}

/**
 * Parses a template through CDK's own loader, with no synthesiser additions:
 * BootstraplessSynthesizer adds no BootstrapVersion parameter, no
 * CheckBootstrapVersion rule and no asset metadata, and analytics and version
 * reporting are off. `edit` runs on the loaded template.
 */
function load(templatePath: string, edit: (include: CfnInclude, stack: Stack) => void): CfnTemplate {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'grun-bootstrap-'));
  const app = new App({ outdir, analyticsReporting: false, treeMetadata: false });
  app.node.setContext('aws:cdk:version-reporting', false);
  app.node.setContext('aws:cdk:enable-path-metadata', false);
  app.node.setContext('aws:cdk:enable-asset-metadata', false);
  const stack = new Stack(app, 'BootstrapTemplate', {
    synthesizer: new BootstraplessSynthesizer(),
    analyticsReporting: false,
  });
  const include = new CfnInclude(stack, 'Template', { templateFile: templatePath });
  // CDK's default template validation reports on AWS's own template (an empty
  // RepositoryName, a deprecated AccessControl); that is not ours to fix here.
  const validation = process.env.CDK_VALIDATION;
  process.env.CDK_VALIDATION = 'false';
  try {
    edit(include, stack);
    return app.synth().getStackByName(stack.stackName).template as CfnTemplate;
  } finally {
    if (validation === undefined) {
      delete process.env.CDK_VALIDATION;
    } else {
      process.env.CDK_VALIDATION = validation;
    }
    fs.rmSync(outdir, { recursive: true, force: true });
  }
}

/** The template as CDK parses it and renders it, with nothing changed. */
export function roundTrip(templatePath: string): CfnTemplate {
  return load(templatePath, () => undefined);
}

/**
 * Puts the execution role's PermissionsBoundary on every AWS::IAM::Role and
 * AWS::IAM::User of the template that has none. Throws if the execution role
 * has no PermissionsBoundary: a CLI version that moved or dropped it must be
 * looked at, not guessed past.
 */
export function withBoundaryEverywhere(templatePath: string): CfnTemplate {
  return load(templatePath, (include, stack) => {
    let exec: CfnRole;
    try {
      exec = include.getResource(EXECUTION_ROLE) as CfnRole;
    } catch (e) {
      throw new Error(`${templatePath}: no resource ${EXECUTION_ROLE}: ${(e as Error).message}`);
    }
    if (!(exec instanceof CfnRole)) {
      throw new Error(`${templatePath}: ${EXECUTION_ROLE} is not an AWS::IAM::Role`);
    }
    const boundary = stack.resolve(exec.permissionsBoundary);
    if (boundary === undefined) {
      throw new Error(`${templatePath}: ${EXECUTION_ROLE} has no PermissionsBoundary to copy`);
    }
    for (const node of include.node.findAll()) {
      if ((node instanceof CfnRole || node instanceof CfnUser) && stack.resolve(node.permissionsBoundary) === undefined) {
        node.addPropertyOverride('PermissionsBoundary', boundary);
      }
    }
  });
}

/** The generated template, as the JSON that is written. */
export function render(template: CfnTemplate): string {
  return `${JSON.stringify(template, null, 2)}\n`;
}

/** CLI: writes the generated template to `out`. */
export function main(argv: string[]): void {
  const [out, source] = argv;
  if (!out) {
    throw new Error('usage: template.ts <out.json> [<source template>]');
  }
  const src = source ?? shippedTemplatePath();
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, render(withBoundaryEverywhere(src)));
  process.stderr.write(`wrote ${out} (from ${src})\n`);
}

if (require.main === module) {
  main(process.argv.slice(2));
}
