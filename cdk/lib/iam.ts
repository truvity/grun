import * as crypto from 'node:crypto';
import { Aspects, IAspect, Stack, Token, aws_iam as iam } from 'aws-cdk-lib';
import { IConstruct } from 'constructs';
import { MAX_ROLE_NAME } from './config';

/**
 * Gives every role of the stack a name starting with the stack name
 * (grun-<env>-...), with no IAM path. The permissions boundary only lets a
 * principal pass roles named grun-* to ECS, and a role it does not recognise
 * would fail at the first task. Names set explicitly are kept.
 *
 * The name is the construct path (without the stack and the trailing
 * "Resource") squeezed to fit, plus a short hash of the full path so two long
 * paths never collide after truncation.
 */
export class RoleNamer implements IAspect {
  constructor(private readonly prefix: string) {}

  visit(node: IConstruct): void {
    if (!(node instanceof iam.CfnRole)) return;
    // An L2 Role leaves a placeholder token here when no name was asked for.
    if (node.roleName !== undefined && !Token.isUnresolved(node.roleName)) return;
    if (node.path !== undefined && node.path !== '/') {
      throw new Error(`role ${node.node.path} has an IAM path (${node.path}); roles must have none`);
    }
    node.roleName = roleNameFor(this.prefix, node.node.path);
  }
}

export function roleNameFor(prefix: string, constructPath: string): string {
  const parts = constructPath.split('/');
  // Drop the stack id and a trailing "Resource".
  const relevant = parts.slice(1).filter((p, i, all) => !(i === all.length - 1 && p === 'Resource'));
  const slug = relevant
    .join('-')
    .replace(/[^A-Za-z0-9+=,.@_-]+/g, '-')
    .replace(/-+/g, '-');
  const hash = crypto.createHash('sha256').update(constructPath).digest('hex').slice(0, 8);
  const room = MAX_ROLE_NAME - prefix.length - 1 - hash.length - 1;
  // The tail of the path is the informative part (the role's purpose).
  const tail = slug.length > room ? slug.slice(slug.length - room).replace(/^-+/, '') : slug;
  return `${prefix}-${tail}-${hash}`;
}

/** Applies the permissions boundary to every role in the stack and names them. */
export function applyIdentityRules(stack: Stack, boundaryName: string, namePrefix: string): void {
  const boundary = iam.ManagedPolicy.fromManagedPolicyName(stack, 'PermissionsBoundary', boundaryName);
  iam.PermissionsBoundary.of(stack).apply(boundary);
  Aspects.of(stack).add(new RoleNamer(namePrefix));
}
