// The environment configuration: its type, its defaults and the loader.
//
// The file is supplied at synth time (`-c config=<path>`) and holds every
// particular: accounts, hostnames, ARNs, endpoints. config/schema.json is the
// contract for the file; the interfaces below are the same contract for the
// code. test/config.test.ts keeps the two in step.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Ajv from 'ajv';
import { parse } from 'yaml';

export interface Shape {
  /** The label a job puts in runs-on. */
  label: string;
  vcpu: number;
  memoryGiB: number;
  ephemeralStorageGiB?: number;
}

export interface OrgConfig {
  name: string;
  sluisParameter: string;
  webhook: { domainName: string; certificateArn: string };
  taskRole?: { managedPolicyArns?: string[]; statements?: Record<string, unknown>[] };
  environment?: Record<string, string>;
  warm?: boolean;
  /**
   * The GitHub runner group the organisation's runners register in. The group
   * must exist (it is created in GitHub, not by this app) and its repository
   * access decides which repositories a runner of this stack may serve. Absent:
   * the organisation's default group.
   */
  runnerGroup?: string;
}

export interface GrunConfig {
  env: string;
  region: string;
  account?: string;
  network: {
    vpcId: string;
    availabilityZones: string[];
    publicSubnetIds: string[];
    securityGroupIds?: string[];
  };
  iam?: { permissionsBoundary?: string };
  /** The CDK bootstrap this app deploys through. */
  cdk?: { qualifier?: string };
  sluis: { readerRoleArn: string; region?: string; syncIntervalMinutes?: number };
  runnerImage: {
    repository: string;
    version: string;
    runnerVersion?: string;
    rebuildIntervalDays?: number;
    computeType?: 'BUILD_GENERAL1_SMALL' | 'BUILD_GENERAL1_LARGE';
    cloudWatchAgent?: boolean;
    extraCertificates?: { path?: string; pem?: string; name?: string };
  };
  shapes?: Shape[];
  requireSelfHostedLabel?: boolean;
  logRetentionDays?: number;
  runnerEnvironment?: {
    goproxy?: string;
    npmRegistry?: string;
    nixSubstituter?: string;
    bazelRemoteCache?: string;
    remoteBuilders?: string;
    extra?: Record<string, string>;
  };
  buildkit?: {
    tlsDir?: string;
    tlsServerName?: string;
    clientCertSecret?: { arn: string; caKey?: string; certKey?: string; keyKey?: string };
  };
  /** Names of the cost allocation tags and the component value. All optional. */
  costTags?: { componentKey?: string; componentValue?: string; environmentKey?: string; companyKey?: string };
  /** Settings of the runner tasks beyond the environment. */
  runner?: {
    /** ENV_NAME -> SSM parameter name or ARN, injected by ECS at task start. */
    secretEnv?: Record<string, string>;
    /** KMS key (ARN) that encrypts those parameters, when it is not the AWS-managed one. */
    secretKmsKeyArn?: string;
  };
  costCap?: { maxConcurrentTasks?: number; onExceed?: 'skip' | 'defer'; dailyBudgetUsd?: number };
  alerts: { emails: string[] };
  warm?: {
    startHourUtc?: number;
    startMinuteUtc?: number;
    weekDays?: string;
    durationHours?: number;
    pools: { shape: string; count: number }[];
  };
  webhook: { mtls: { truststoreBucket: string; truststoreKey: string; truststoreVersion?: string } };
  reports?: { bucketName?: string; taskRolesCanWrite?: boolean };
  dashboard?: boolean;
  orgs: OrgConfig[];
}

/** The shapes the project runs with unless the file says otherwise. */
export const DEFAULT_SHAPES: Shape[] = [
  { label: 'fg-large', vcpu: 4, memoryGiB: 24, ephemeralStorageGiB: 100 },
  { label: 'fg-medium', vcpu: 2, memoryGiB: 14, ephemeralStorageGiB: 50 },
  { label: 'fg-small', vcpu: 1, memoryGiB: 6, ephemeralStorageGiB: 50 },
];

export const DEFAULT_PERMISSIONS_BOUNDARY = 'pb@tech-grun';

/** CDK's own default qualifier: the one of a plain `cdk bootstrap`. */
export const DEFAULT_QUALIFIER = 'hnb659fds';

/** The CDK qualifier of the bootstrap the stack deploys through: its roles are cdk-<qualifier>-*. */
export function qualifier(config: GrunConfig): string {
  return config.cdk?.qualifier ?? DEFAULT_QUALIFIER;
}

/** The cost allocation tags: lowercase, in the estate's key style. */
export const DEFAULT_COST_TAGS = {
  componentKey: 'component',
  componentValue: 'ci',
  environmentKey: 'environment',
  companyKey: 'company',
} as const;

export function costTags(config: GrunConfig): Required<NonNullable<GrunConfig['costTags']>> {
  return { ...DEFAULT_COST_TAGS, ...(config.costTags ?? {}) };
}

/** IAM role names are at most 64 characters. */
export const MAX_ROLE_NAME = 64;

/**
 * The memory (GiB) Fargate accepts for each vCPU size. ECS checks the pair when
 * the task definition is registered, which is after `cdk synth`: a shape off
 * this table fails the deploy and rolls the stack back.
 */
export function fargateMemoryGiB(vcpu: number): number[] | undefined {
  const range = (from: number, to: number, step = 1): number[] => {
    const out: number[] = [];
    for (let m = from; m <= to; m += step) out.push(m);
    return out;
  };
  const table: Record<number, number[]> = {
    0.25: [0.5, 1, 2],
    0.5: range(1, 4),
    1: range(2, 8),
    2: range(4, 16),
    4: range(8, 30),
    8: range(16, 60, 4),
    16: range(32, 120, 8),
  };
  return table[vcpu];
}

/** API Gateway custom domain names are lowercase DNS names. */
const DOMAIN_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function stackName(config: GrunConfig): string {
  return `grun-${config.env}`;
}

export function schemaPath(): string {
  return path.join(__dirname, '..', 'config', 'schema.json');
}

/** Everything the schema cannot say. Returns the problems found. */
export function crossChecks(config: GrunConfig): string[] {
  const problems: string[] = [];
  const shapes = config.shapes ?? DEFAULT_SHAPES;
  const labels = shapes.map((s) => s.label);
  if (new Set(labels).size !== labels.length) problems.push('shapes: duplicate label');

  const names = config.orgs.map((o) => o.name);
  if (new Set(names).size !== names.length) problems.push('orgs: duplicate name');
  const domains = config.orgs.map((o) => o.webhook.domainName);
  if (new Set(domains).size !== domains.length) problems.push('orgs: duplicate webhook.domainName');

  if (config.network.availabilityZones.length !== config.network.publicSubnetIds.length) {
    problems.push('network: availabilityZones and publicSubnetIds must have the same length');
  }
  for (const pool of config.warm?.pools ?? []) {
    if (!labels.includes(pool.shape)) problems.push(`warm.pools: unknown shape ${pool.shape}`);
  }
  for (const s of shapes) {
    if (s.ephemeralStorageGiB !== undefined && s.ephemeralStorageGiB < 21) {
      problems.push(`shapes.${s.label}: ephemeralStorageGiB below the Fargate minimum of 21`);
    }
  }
  for (const s of shapes) {
    const allowed = fargateMemoryGiB(s.vcpu);
    if (allowed && !allowed.includes(s.memoryGiB)) {
      problems.push(`shapes.${s.label}: ${s.memoryGiB} GiB is not a Fargate memory size for ${s.vcpu} vCPU (allowed: ${allowed.join(', ')})`);
    }
  }
  // A regional custom domain takes a certificate of its own region, and AWS
  // refuses the domain at create time otherwise.
  for (const org of config.orgs) {
    const certRegion = org.webhook.certificateArn.split(':')[3];
    if (certRegion && certRegion !== config.region) {
      problems.push(`orgs.${org.name}.webhook.certificateArn: certificate is in ${certRegion}, the stack is in ${config.region}`);
    }
    if (!DOMAIN_NAME.test(org.webhook.domainName)) {
      problems.push(`orgs.${org.name}.webhook.domainName: must be a lowercase DNS name`);
    }
  }
  // A variable is either injected from SSM or set in plain text, not both.
  const secretNames = Object.keys(config.runner?.secretEnv ?? {});
  const plain = (org: OrgConfig) => [
    ...Object.keys(runnerEnvNames(config)),
    ...Object.keys(config.runnerEnvironment?.extra ?? {}),
    ...Object.keys(org.environment ?? {}),
  ];
  for (const org of config.orgs) {
    for (const n of secretNames) {
      if (plain(org).includes(n)) problems.push(`runner.secretEnv.${n}: also set as plain environment (org ${org.name})`);
    }
  }
  // Role names: grun-<env>-<org>-<shape>-task must fit.
  for (const org of config.orgs) {
    for (const s of shapes) {
      const name = taskRoleName(config, org.name, s.label);
      if (name.length > MAX_ROLE_NAME) problems.push(`role name too long (${name.length} > ${MAX_ROLE_NAME}): ${name}`);
    }
  }
  return problems;
}

/**
 * The system bundle that `update-ca-certificates` rebuilds on the image when
 * the private CA is installed (Ubuntu). Node ignores the system store, so the
 * tasks point NODE_EXTRA_CA_CERTS here; Node adds it to its built-in roots.
 */
export const SYSTEM_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';

/** The upstream binary cache that stays in the list behind the estate's pull-through cache. */
export const NIX_UPSTREAM_CACHE = 'https://cache.nixos.org/';

/**
 * The NIX_CONFIG of the runner tasks when a Nix pull-through cache is named.
 *
 * The image's nix is a single-user install owned by the runner user, whose own
 * nix.conf lists only the upstream cache; NIX_CONFIG is read after it and wins,
 * so no image rebuild is needed. It names the FULL list, the estate's cache first
 * and the upstream as the automatic fallback: the `extra-` form would append to
 * Nix's default and read upstream-first. The cache advertises a Priority below the
 * upstream's, so Nix prefers it whatever the order. Narinfos pass through with the
 * upstream's signatures, so Nix's default trusted key verifies them: no
 * trusted-public-keys entry. A cache that does not answer costs a few seconds once
 * per nix process (connect-timeout bounds each attempt; Nix then asks the upstream
 * for that path), never a failed job.
 */
export function nixConfig(substituter: string): string {
  return ['substituters = ' + substituter + ' ' + NIX_UPSTREAM_CACHE, 'connect-timeout = 5', ''].join('\n');
}

/** The variables the typed runnerEnvironment and buildkit settings produce. */
function runnerEnvNames(config: GrunConfig): Record<string, true> {
  const e = config.runnerEnvironment ?? {};
  const bk = config.buildkit;
  const names: Record<string, true> = {};
  if (e.goproxy) names.CI_RUNNER_GOPROXY = true;
  if (e.npmRegistry) names.CI_RUNNER_NPM_REGISTRY = true;
  if (e.nixSubstituter) names.NIX_CONFIG = true;
  if (e.bazelRemoteCache) names.CI_RUNNER_BAZEL_REMOTE_CACHE = true;
  if (e.remoteBuilders) names.CI_RUNNER_REMOTE_BUILDERS = true;
  if (bk?.clientCertSecret) names.CI_BUILDKIT_TLS_DIR = true;
  if (bk?.tlsServerName) names.CI_BUILDKIT_TLS_SERVERNAME = true;
  if (config.runnerImage.extraCertificates) names.NODE_EXTRA_CA_CERTS = true;
  return names;
}

export function taskRoleName(config: GrunConfig, org: string, shapeLabel: string): string {
  return `${stackName(config)}-${org}-${shapeLabel}-task`;
}

export function validate(raw: unknown): GrunConfig {
  const ajv = new Ajv({ allErrors: true, useDefaults: false, strict: false });
  const schema = JSON.parse(fs.readFileSync(schemaPath(), 'utf8'));
  const check = ajv.compile(schema);
  if (!check(raw)) {
    const lines = (check.errors ?? []).map((e) => `  ${e.instancePath || '/'} ${e.message}`);
    throw new Error(`invalid grun config:\n${lines.join('\n')}`);
  }
  const config = raw as GrunConfig;
  const problems = crossChecks(config);
  if (problems.length > 0) throw new Error(`invalid grun config:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  return config;
}

/**
 * Reads and validates a config file. Relative paths inside it (the private CA)
 * are resolved against the file's directory by `resolveCaFile`.
 */
export function loadConfig(file: string): GrunConfig {
  const text = fs.readFileSync(file, 'utf8');
  return validate(parse(text));
}

/**
 * The private CA as a file on disk, from either its path (relative to the
 * config file) or its PEM content (written to a content-addressed temp file).
 */
export function resolveCaFile(
  ca: NonNullable<GrunConfig['runnerImage']['extraCertificates']>,
  configFile: string | undefined,
): string {
  if (ca.path) {
    const base = configFile ? path.dirname(path.resolve(configFile)) : process.cwd();
    const resolved = path.resolve(base, ca.path);
    if (!fs.existsSync(resolved)) throw new Error(`runnerImage.extraCertificates.path not found: ${resolved}`);
    return resolved;
  }
  const pem = ca.pem as string;
  const dir = path.join(os.tmpdir(), `grun-ca-${crypto.createHash('sha256').update(pem).digest('hex').slice(0, 16)}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ca.crt');
  fs.writeFileSync(file, pem.endsWith('\n') ? pem : `${pem}\n`, { mode: 0o644 });
  return file;
}
