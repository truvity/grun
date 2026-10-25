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
  /**
   * Ephemeral storage in GiB: 20 (Fargate's default, which is included in the price: the
   * setting is left out of the task definition) or 21 to 200 (each GiB above 20 is billed).
   * Absent: 50.
   */
  ephemeralStorageGiB?: number;
  /**
   * Run the tasks on the FARGATE_SPOT capacity provider. A Spot interruption stops the
   * task and fails the job it runs: GitHub does not retry it and the requeue (runner.requeue)
   * covers only a job that never got a runner. For a trial on a tier where a rerun is cheap
   * (preview), never for the stable tier. Default: false (on-demand).
   */
  spot?: boolean;
}

/** One repository the organisation's runners may be started for. */
export interface AllowEntry {
  /** owner/name; the owner is the organisation. Compared case-insensitively. */
  repository: string;
  /** Workflow names (exact, case-sensitive). Absent: any workflow of the repository. */
  workflows?: string[];
  /** Globs over the job's head_branch, `*` matching any characters including `/`. Absent: any ref. */
  refs?: string[];
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
  /**
   * The webhook allow-list: runners are started only for jobs of these
   * repositories (narrowed by workflow and ref when an entry names them).
   * Absent: every job of the organisation is considered.
   */
  allow?: AllowEntry[];
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
    mavenRegistry?: string;
    gradleBuildCache?: string;
    bazelRemoteCache?: string;
    remoteBuilders?: string;
    goCacheBucket?: string;
    goCacheRegion?: string;
    buildxCache?: string;
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
    /** Minutes a registered runner may stay idle before it is stopped and removed. Default: the library's 5. */
    idleTimeoutMinutes?: number;
    /** Retention of the runner tasks' log groups. Default: logRetentionDays. */
    logRetentionDays?: number;
    /** ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT: the runner's diagnostic trace on stdout. Default: false. */
    traceToStdout?: boolean;
    /** Start a runner again for a job still queued after its runner went away (lambda/requeue). Default: true. */
    requeue?: boolean;
  };
  /**
   * Where the runner tasks send their OpenTelemetry (grun-agent: the runner's warnings
   * and errors, the job's peaks). Absent: the agent still prints the peaks in the job
   * log and sends nothing.
   */
  telemetry?: {
    /** OTLP/HTTP base URL; /v1/logs and /v1/metrics are appended. */
    otlpEndpoint: string;
    /** Base URL of the token issuer whose <issuer>/token trades the task role's web identity token (RFC 8693). */
    issuerUrl: string;
    /** Audience asked of STS for the web identity token. Default: issuerUrl. */
    stsAudience?: string;
    /** Audience (and exchange client id) of the access token the endpoint accepts. Default: otlp. */
    otlpAudience?: string;
    /** Seconds between two samples of the task's stats. Default: 5. */
    sampleSeconds?: number;
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

/**
 * The extra-large shape (owner SZ13 B, 2026-10-24: 8 vCPU / 16 GB), the upper arm of the
 * sizing experiment. One value: change the size here. Fargate takes 16 to 60 GB for 8 vCPU
 * in 4 GB steps.
 */
export const XLARGE_SHAPE: Shape = { label: 'fg-xlarge', vcpu: 8, memoryGiB: 16, ephemeralStorageGiB: 30 };

/** The shapes the project runs with unless the file says otherwise. */
export const DEFAULT_SHAPES: Shape[] = [
  { label: 'fg-large', vcpu: 4, memoryGiB: 12, ephemeralStorageGiB: 30 },
  { label: 'fg-medium', vcpu: 2, memoryGiB: 8, ephemeralStorageGiB: 20 },
  { label: 'fg-small', vcpu: 1, memoryGiB: 4, ephemeralStorageGiB: 20 },
  // The sizes of the runner-sizing decisions (2026-10-24, SZ1): an extra-small one for the
  // trivial jobs and a Spot twin of the new
  // medium (SZ10) for the trial that starts with the Renovate fleet jobs.
  { label: 'fg-xsmall', vcpu: 0.5, memoryGiB: 1, ephemeralStorageGiB: 20 },
  { label: 'fg-medium-spot', vcpu: 2, memoryGiB: 8, ephemeralStorageGiB: 20, spot: true },
  XLARGE_SHAPE,
];

/**
 * The ephemeral storage Fargate gives a task that sets none: 20 GiB, included in the price.
 * Fargate accepts an explicit setting only from 21 GiB, so a shape of this size leaves the
 * setting out (cdk-github-runners would otherwise put 25 in).
 */
export const FARGATE_DEFAULT_STORAGE_GIB = 20;

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
    // A warm runner waits for hours for a job: Spot reclaims such a task at any time.
    if (shapes.find((s) => s.label === pool.shape)?.spot) problems.push(`warm.pools: ${pool.shape} is a Spot shape`);
  }
  for (const s of shapes) {
    if (s.ephemeralStorageGiB !== undefined && s.ephemeralStorageGiB < FARGATE_DEFAULT_STORAGE_GIB) {
      problems.push(`shapes.${s.label}: ephemeralStorageGiB below ${FARGATE_DEFAULT_STORAGE_GIB}`);
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
  // An allow-list names repositories of its own organisation: a repository of another owner
  // can never match a job of this one, so it is a typo.
  for (const org of config.orgs) {
    for (const e of org.allow ?? []) {
      if (e.repository.split('/')[0].toLowerCase() !== org.name.toLowerCase()) {
        problems.push(`orgs.${org.name}.allow: ${e.repository} is not a repository of ${org.name}`);
      }
    }
  }
  // A region without a bucket would name nothing; the shared actions read the pair together.
  if (config.runnerEnvironment?.goCacheRegion && !config.runnerEnvironment.goCacheBucket) {
    problems.push('runnerEnvironment.goCacheRegion: set only with runnerEnvironment.goCacheBucket');
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
  if (e.mavenRegistry) names.CI_RUNNER_MAVEN_REGISTRY = true;
  if (e.gradleBuildCache) names.CI_RUNNER_GRADLE_BUILD_CACHE = true;
  if (e.bazelRemoteCache) names.CI_RUNNER_BAZEL_REMOTE_CACHE = true;
  if (e.remoteBuilders) names.CI_RUNNER_REMOTE_BUILDERS = true;
  if (e.goCacheBucket) names.CI_RUNNER_GOCACHE_S3_BUCKET = true;
  if (e.goCacheRegion) names.CI_RUNNER_GOCACHE_S3_REGION = true;
  if (e.buildxCache) names.CI_RUNNER_BUILDX_CACHE = true;
  if (bk?.clientCertSecret) names.CI_BUILDKIT_TLS_DIR = true;
  if (bk?.tlsServerName) names.CI_BUILDKIT_TLS_SERVERNAME = true;
  if (config.runnerImage.extraCertificates) names.NODE_EXTRA_CA_CERTS = true;
  names.ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT = true;
  for (const n of ['GRUN_TIER', 'GRUN_ORG', 'GRUN_REGION', 'GRUN_SIZE']) names[n] = true;
  if (config.telemetry) {
    for (const n of ['GRUN_OTLP_ENDPOINT', 'GRUN_OTLP_ISSUER', 'GRUN_OTLP_STS_AUDIENCE', 'GRUN_OTLP_AUDIENCE']) names[n] = true;
    if (config.telemetry.sampleSeconds) names.GRUN_SAMPLE_SECONDS = true;
  }
  return names;
}

/**
 * The ALLOW_LIST of the provider selector, or undefined when no organisation
 * has an allow-list. Keyed by the lowercase organisation; an organisation
 * without a list is null (known, unrestricted), because the selector refuses a
 * login it does not know as soon as any organisation is restricted.
 */
export function allowList(config: GrunConfig): Record<string, AllowEntry[] | null> | undefined {
  if (!config.orgs.some((o) => o.allow)) return undefined;
  return Object.fromEntries(config.orgs.map((o) => [o.name.toLowerCase(), o.allow ?? null]));
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
