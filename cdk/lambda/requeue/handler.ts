// Runs every few minutes and starts a runner for every job that is queued with no
// runner coming for it, whatever happened to the runner it was first given.
//
// cdk-github-runners starts one runner per `workflow_job` queued webhook and GitHub
// sends that webhook once, when the job is created. Everything after that can lose the
// race: at the task cap the selector defers the delivery and later redeliveries lose to
// newer jobs; the idle reaper stops a runner that took no job in time (a matrix with
// `max-parallel` creates all its jobs at once but runs only so many); the library
// replaces a stolen runner only three times. A job whose runner went away in any of those
// ways stays queued until someone cancels it.
//
// So this function does not wait for an execution to end and then look: it looks at the
// jobs. Per organisation (its App installation): every repository's active runs (queued or
// in progress), their jobs that are queued and old enough for the webhook's own runner to
// have started, and which of those the stack routes (the provider selector's label routing
// and allow-list, the same code). Runners are interchangeable within a label set, so a
// queued job is covered by any runner of the stack that is idle (registered and not busy)
// or still starting (a running execution not registered yet, young enough to be starting)
// and carries the job's labels, each runner covering one job. The jobs left over, the
// oldest first and across organisations, get a runner through the same state machine with
// the input the webhook would have given, while the task cap holds. Nothing here depends on
// what became of an earlier runner, so a job still queued a round later gets another one,
// up to a few attempts (each attempt is its own execution name, which is also what keeps two
// rounds from starting the same one twice).
import { ECSClient, ListTasksCommand } from '@aws-sdk/client-ecs';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  DescribeExecutionCommand,
  ExecutionAlreadyExists,
  ExecutionDoesNotExist,
  ExecutionStatus,
  ListExecutionsCommand,
  SFNClient,
  StartExecutionCommand,
} from '@aws-sdk/client-sfn';
import * as crypto from 'node:crypto';
import { AllowList, allowed, parseAllowList, route } from '../provider-selector/handler';

export interface Target {
  org: string;
  stateMachineArn: string;
  githubSecretArn: string;
  privateKeySecretArn: string;
  /** provider construct path -> labels, as the selector gets them. */
  providers: Record<string, string[]>;
}

export interface RequeueConfig {
  targets: Target[];
  clusterArn: string;
  maxConcurrentTasks: number;
  /** A job queued for longer than this is not served again. */
  maxJobAgeMinutes: number;
  /** A job younger than this is the webhook's own runner's business. */
  graceSeconds: number;
  /** A running execution that has not registered a runner is starting for this long. */
  startingMinutes: number;
  /** Runners started for one job, over its life. */
  maxAttempts: number;
  /** The idle timeout the webhook gives its runners (seconds). */
  maxIdleSeconds: number;
  shapeLabels: string[];
  allow?: AllowList;
  /** Stop looking at GitHub when this much of the invocation is spent (ms). */
  budgetMs: number;
}

/** The state machine input the webhook handler writes (cdk-github-runners). */
export interface RunnerInput {
  owner: string;
  repo: string;
  jobId: number;
  jobUrl: string;
  installationId: number;
  jobLabels: string;
  provider: string;
  labels: string;
  maxIdleSeconds: number;
  [k: string]: unknown;
}

export interface GitHubJob {
  id: number;
  run_id?: number;
  name?: string;
  status: string;
  labels: string[];
  created_at: string;
  html_url: string;
  workflow_name?: string | null;
  head_branch?: string | null;
}

export interface GitHubRunner {
  name: string;
  status: string;
  busy: boolean;
  labels: string[];
}

/** One organisation, as its App installation. */
export interface GitHub {
  installationId: number;
  /** owner/name of every repository the installation reaches. */
  repositories(): Promise<string[]>;
  /** Runs of the repository that are queued or in progress. */
  activeRuns(repo: string): Promise<number[]>;
  jobs(repo: string, runId: number): Promise<GitHubJob[]>;
  /** The organisation's registered runners; undefined when the App may not list them. */
  runners(): Promise<GitHubRunner[] | undefined>;
}

export function loadConfig(env: NodeJS.ProcessEnv): RequeueConfig {
  const targets = JSON.parse(env.TARGETS ?? '[]') as Target[];
  if (!Array.isArray(targets) || targets.length === 0) throw new Error('TARGETS must name at least one state machine');
  const n = (k: string, d: number) => {
    const v = Number(env[k] ?? d);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`${k} must be a positive number`);
    return v;
  };
  if (!env.CLUSTER_ARN) throw new Error('CLUSTER_ARN is required');
  return {
    targets: targets.map((t) => ({ ...t, providers: t.providers ?? {} })),
    clusterArn: env.CLUSTER_ARN,
    maxConcurrentTasks: n('MAX_CONCURRENT_TASKS', 20),
    maxJobAgeMinutes: n('MAX_JOB_AGE_MINUTES', 360),
    graceSeconds: n('GRACE_SECONDS', 90),
    startingMinutes: n('STARTING_MINUTES', 4),
    maxAttempts: n('MAX_ATTEMPTS', 5),
    maxIdleSeconds: n('IDLE_TIMEOUT_SECONDS', 300),
    shapeLabels: (env.SHAPE_LABELS ?? '').split(',').filter(Boolean),
    allow: env.ALLOW_LIST ? parseAllowList(env.ALLOW_LIST) : undefined,
    budgetMs: n('BUDGET_SECONDS', 200) * 1000,
  };
}

/** owner/repo/run of a job URL: https://github.com/<owner>/<repo>/actions/runs/<run>/job/<job>. */
export function runOf(jobUrl: string): { owner: string; repo: string; runId: number } | undefined {
  const m = /\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/job\/\d+/.exec(jobUrl);
  return m ? { owner: m[1], repo: m[2], runId: Number(m[3]) } : undefined;
}

/** The label set as cdk-github-runners compares it: lowercase, order-free. */
export function labelKey(labels: string[] | string): string {
  return labelList(labels).sort().join(',');
}

function labelList(labels: string[] | string): string[] {
  const list = Array.isArray(labels) ? labels : labels.split(',');
  return list.map((l) => l.trim().toLowerCase()).filter(Boolean);
}

/** A runner name GitHub accepts (at most 64 characters), unique per job and attempt. */
export function executionName(repo: string, jobId: number, attempt: number): string {
  const safe = repo.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 24);
  return `${safe}-rq-${jobId}-${attempt}`.slice(0, 64);
}

// ---- what covers a queued job

/** A runner that is, or is about to be, free to take a job. */
export interface Free {
  name: string;
  labels: Set<string>;
  /** `idle`: registered and not busy. `starting`: its execution runs and it has not registered yet. */
  kind: 'idle' | 'starting';
}

export interface Execution {
  name: string;
  startMs: number;
  /** The webhook's input: `labels` is what the runner registers with. */
  input: RunnerInput;
}

/**
 * The runners that can still take a job: the registered ones of this stack (those named like
 * a running execution) that are online and not busy, and the executions that have not
 * registered yet and started recently enough to be on their way. Without the runner list,
 * only the starting ones count.
 */
export function freeRunners(running: Execution[], registered: GitHubRunner[] | undefined, nowMs: number, startingMs: number): Free[] {
  const byName = new Map((registered ?? []).map((r) => [r.name, r]));
  const out: Free[] = [];
  for (const e of running) {
    const r = byName.get(e.name);
    if (r) {
      if (r.status === 'online' && !r.busy) out.push({ name: e.name, labels: new Set(labelList(r.labels)), kind: 'idle' });
    } else if (nowMs - e.startMs <= startingMs) {
      out.push({ name: e.name, labels: new Set(labelList(e.input.labels ?? '')), kind: 'starting' });
    }
  }
  return out;
}

export interface Queued {
  repository: string;
  job: GitHubJob;
  /** The provider and its labels, as the selector routes the job. */
  provider: string;
  providerLabels: string[];
  org: string;
  installationId: number;
}

/**
 * The queued jobs no free runner covers, the oldest first. Each free runner covers one job
 * whose labels it carries; a runner is taken by the oldest job it can serve. Pure.
 */
export function uncovered(queued: Queued[], free: Free[]): Queued[] {
  const pool = [...free];
  const sorted = [...queued].sort((a, b) => Date.parse(a.job.created_at) - Date.parse(b.job.created_at));
  const out: Queued[] = [];
  for (const q of sorted) {
    const want = labelList(q.job.labels);
    const i = pool.findIndex((f) => want.every((l) => f.labels.has(l)));
    if (i >= 0) pool.splice(i, 1);
    else out.push(q);
  }
  return out;
}

/** The queued jobs of one organisation's scan that the stack serves, old enough and not too old. */
export function candidates(
  scanned: { repository: string; job: GitHubJob }[],
  t: { org: string; providers: Record<string, string[]>; installationId: number },
  c: Pick<RequeueConfig, 'shapeLabels' | 'allow' | 'graceSeconds' | 'maxJobAgeMinutes'>,
  nowMs: number,
): Queued[] {
  const out: Queued[] = [];
  const seen = new Set<number>();
  for (const { repository, job } of scanned) {
    if (job.status !== 'queued' || seen.has(job.id)) continue;
    const age = nowMs - Date.parse(job.created_at);
    if (!(age >= c.graceSeconds * 1000) || age > c.maxJobAgeMinutes * 60_000) continue;
    const payload = {
      workflow_job: { labels: job.labels, workflow_name: job.workflow_name ?? null, head_branch: job.head_branch ?? null },
      repository: { full_name: repository },
      organization: { login: t.org },
    };
    if (!allowed(payload, c.allow)) continue;
    const chosen = route({ payload, providers: t.providers }, c.shapeLabels);
    if (!chosen.provider || !chosen.labels) continue;
    seen.add(job.id);
    out.push({ repository, job, provider: chosen.provider, providerLabels: chosen.labels, org: t.org, installationId: t.installationId });
  }
  return out;
}

/** The webhook's input for a job, as the library's webhook handler builds it. */
export function runnerInput(q: Queued, maxIdleSeconds: number): RunnerInput {
  const [owner, repo] = q.repository.split('/');
  return {
    owner,
    repo,
    jobId: q.job.id,
    jobUrl: q.job.html_url,
    installationId: q.installationId,
    jobLabels: q.job.labels.join(','),
    provider: q.provider,
    labels: q.providerLabels.join(','),
    maxIdleSeconds,
  };
}

// ---- GitHub, as the organisation's App installation

function appJwt(appId: string, privateKey: string, nowS: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: nowS - 60, exp: nowS + 540, iss: appId })}`;
  const sig = crypto.createSign('RSA-SHA256').update(body).sign(privateKey).toString('base64url');
  return `${body}.${sig}`;
}

export function apiBase(domain: string | undefined): string {
  return !domain || domain === 'github.com' ? 'https://api.github.com' : `https://${domain}/api/v3`;
}

/** Requests spent against the installation's rate limit, and what GitHub says is left of it. */
export interface Budget {
  calls: number;
  remaining?: number;
}

export async function gitHubFor(
  org: string,
  secrets: { domain?: string; appId: string; privateKey: string },
  budget: Budget,
  fetchFn: typeof fetch = fetch,
): Promise<GitHub> {
  const base = apiBase(secrets.domain);
  const jwt = () => appJwt(secrets.appId, secrets.privateKey, Math.floor(Date.now() / 1000));
  const call = async (bearer: string, path: string, init?: RequestInit) => {
    budget.calls++;
    const res = await fetchFn(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/vnd.github+json', ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(10_000),
    });
    const left = Number(res.headers.get('x-ratelimit-remaining'));
    if (res.headers.get('x-ratelimit-remaining') !== null && Number.isFinite(left)) budget.remaining = left;
    return res;
  };
  const inst = await call(jwt(), `/orgs/${org}/installation`);
  if (!inst.ok) throw new Error(`${org}: GET /orgs/${org}/installation: HTTP ${inst.status}`);
  const installationId = ((await inst.json()) as { id: number }).id;
  const tok = await call(jwt(), `/app/installations/${installationId}/access_tokens`, { method: 'POST' });
  if (!tok.ok) throw new Error(`${org}: installation token: HTTP ${tok.status}`);
  const token = ((await tok.json()) as { token: string }).token;
  const get = async (path: string) => {
    const res = await call(token, path);
    if (!res.ok) throw Object.assign(new Error(`GET ${path}: HTTP ${res.status}`), { status: res.status });
    return res.json();
  };
  const pages = async <T>(path: string, key: string, max: number): Promise<T[]> => {
    const out: T[] = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= max; page++) {
      const r = (await get(`${path}${sep}per_page=100&page=${page}`)) as Record<string, T[]>;
      out.push(...(r[key] ?? []));
      if ((r[key] ?? []).length < 100) break;
    }
    return out;
  };
  return {
    installationId,
    repositories: async () =>
      (await pages<{ full_name: string; archived?: boolean; disabled?: boolean }>('/installation/repositories', 'repositories', 20))
        .filter((r) => !r.archived && !r.disabled)
        .map((r) => r.full_name),
    activeRuns: async (repo) => {
      const ids = new Set<number>();
      for (const status of ['queued', 'in_progress']) {
        for (const r of await pages<{ id: number }>(`/repos/${repo}/actions/runs?status=${status}`, 'workflow_runs', 3)) ids.add(r.id);
      }
      return [...ids];
    },
    jobs: (repo, runId) => pages<GitHubJob>(`/repos/${repo}/actions/runs/${runId}/jobs?filter=latest`, 'jobs', 10),
    runners: async () => {
      try {
        return (await pages<{ name: string; status: string; busy: boolean; labels: { name: string }[] }>(`/orgs/${org}/actions/runners`, 'runners', 10)).map((r) => ({
          name: r.name,
          status: r.status,
          busy: r.busy,
          labels: r.labels.map((l) => l.name),
        }));
      } catch (e) {
        // The App may not be allowed to list the organisation's runners: then only the starting ones count.
        if ((e as { status?: number }).status === 403 || (e as { status?: number }).status === 404) return undefined;
        throw e;
      }
    },
  };
}

// ---- the state machine

async function runningExecutions(sfn: SFNClient, target: Target): Promise<Execution[]> {
  const out: Execution[] = [];
  let token: string | undefined;
  do {
    const page = await sfn.send(new ListExecutionsCommand({ stateMachineArn: target.stateMachineArn, statusFilter: ExecutionStatus.RUNNING, maxResults: 100, nextToken: token }));
    token = page.nextToken;
    for (const e of page.executions ?? []) {
      const d = await sfn.send(new DescribeExecutionCommand({ executionArn: e.executionArn }));
      try {
        out.push({ name: e.name ?? '', startMs: e.startDate?.getTime() ?? 0, input: JSON.parse(d.input ?? '{}') as RunnerInput });
      } catch {
        /* not one of the webhook's */
      }
    }
  } while (token);
  return out;
}

/** The execution ARN of a name in a state machine. */
export function executionArn(stateMachineArn: string, name: string): string {
  return stateMachineArn.replace(':stateMachine:', ':execution:') + `:${name}`;
}

/**
 * The attempt to name the next runner of a job: the first attempt number with no execution
 * yet (executions keep their names for 90 days, so a name is never started twice). A job
 * still queued with its earlier attempts over, or running but too old to be starting (a
 * runner that never took the job), gets the next attempt. Returns undefined when the job has
 * had all its attempts, so a job nobody can serve (a repository outside the runner group) is
 * not started for forever.
 */
export async function nextAttempt(
  sfn: Pick<SFNClient, 'send'>,
  stateMachineArn: string,
  repo: string,
  jobId: number,
  maxAttempts: number,
): Promise<number | undefined> {
  for (let k = 0; k < maxAttempts; k++) {
    try {
      await sfn.send(new DescribeExecutionCommand({ executionArn: executionArn(stateMachineArn, executionName(repo, jobId, k)) }));
    } catch (e) {
      if (e instanceof ExecutionDoesNotExist || (e as { name?: string }).name === 'ExecutionDoesNotExist') return k;
      throw e;
    }
  }
  return undefined;
}

async function runningTasks(ecs: ECSClient, clusterArn: string): Promise<number> {
  let n = 0;
  let token: string | undefined;
  do {
    const page = await ecs.send(new ListTasksCommand({ cluster: clusterArn, nextToken: token }));
    n += page.taskArns?.length ?? 0;
    token = page.nextToken;
  } while (token);
  return n;
}

// ---- the handler

const sfn = new SFNClient({});
const ecs = new ECSClient({});
const sm = new SecretsManagerClient({});

async function secretsOf(t: Target): Promise<{ domain?: string; appId: string; privateKey: string }> {
  const [gh, key] = await Promise.all([
    sm.send(new GetSecretValueCommand({ SecretId: t.githubSecretArn })),
    sm.send(new GetSecretValueCommand({ SecretId: t.privateKeySecretArn })),
  ]);
  const g = JSON.parse(gh.SecretString ?? '{}') as { domain?: string; appId?: string | number };
  if (!g.appId || !key.SecretString) throw new Error(`${t.org}: the GitHub App secrets are not set`);
  return { domain: g.domain, appId: String(g.appId), privateKey: key.SecretString };
}

/** Runs `fn` over `items`, `width` at a time, stopping early when `stop()` says so. */
export async function pool<T>(items: T[], width: number, stop: () => boolean, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop()) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
}

interface Scan {
  repositories: number;
  runs: number;
  queued: Queued[];
  free: Free[];
  truncated: boolean;
}

async function scan(t: Target, c: RequeueConfig, github: GitHub, budget: Budget, deadlineMs: number, nowMs: number): Promise<Scan> {
  const repositories = await github.repositories();
  const found: { repository: string; job: GitHubJob }[] = [];
  let runs = 0;
  let truncated = false;
  const stop = () => {
    const out = Date.now() > deadlineMs || (budget.remaining !== undefined && budget.remaining < 300);
    if (out) truncated = true;
    return out;
  };
  await pool(repositories, 6, stop, async (repository) => {
    try {
      for (const runId of await github.activeRuns(repository)) {
        if (stop()) return;
        runs++;
        for (const job of await github.jobs(repository, runId)) if (job.status === 'queued') found.push({ repository, job });
      }
    } catch (e) {
      // One repository's failure does not hide the others'.
      console.error(JSON.stringify({ notice: 'Requeue: a repository could not be read', org: t.org, repository, error: String(e) }));
    }
  });
  const queued = candidates(found, { org: t.org, providers: t.providers, installationId: github.installationId }, c, nowMs);
  const running = await runningExecutions(sfn, t);
  const free = freeRunners(running, await github.runners(), nowMs, c.startingMinutes * 60_000);
  return { repositories: repositories.length, runs, queued, free, truncated };
}

export async function handler(): Promise<{ started: number }> {
  const c = loadConfig(process.env);
  const now = Date.now();
  const deadline = now + c.budgetMs;
  const failed: string[] = [];
  const rescue: Queued[] = [];
  const stateMachines = new Map(c.targets.map((t) => [t.org, t.stateMachineArn]));
  for (const t of c.targets) {
    const budget: Budget = { calls: 0 };
    try {
      const github = await gitHubFor(t.org, await secretsOf(t), budget);
      const s = await scan(t, c, github, budget, deadline, now);
      const left = uncovered(s.queued, s.free);
      rescue.push(...left);
      console.log(
        JSON.stringify({
          notice: 'Requeue round',
          org: t.org,
          repositories: s.repositories,
          runs: s.runs,
          queuedJobs: s.queued.length,
          freeRunners: s.free.length,
          idle: s.free.filter((f) => f.kind === 'idle').length,
          withoutRunner: left.length,
          githubCalls: budget.calls,
          rateRemaining: budget.remaining,
          truncated: s.truncated,
        }),
      );
    } catch (e) {
      // One organisation's failure does not stop the others; the function's errors alarm.
      console.error(JSON.stringify({ notice: 'Requeue failed', org: t.org, error: String(e) }));
      failed.push(t.org);
    }
  }
  // Oldest first across organisations, so the wait is fair; the task cap holds.
  rescue.sort((a, b) => Date.parse(a.job.created_at) - Date.parse(b.job.created_at));
  let started = 0;
  let tasks: number | undefined;
  for (const q of rescue) {
    const smArn = stateMachines.get(q.org)!;
    try {
      tasks ??= await runningTasks(ecs, c.clusterArn);
      if (tasks >= c.maxConcurrentTasks) {
        console.log(JSON.stringify({ notice: 'Task cap reached, the jobs left wait for the next round', waiting: rescue.length - started, tasks, cap: c.maxConcurrentTasks }));
        break;
      }
      const attempt = await nextAttempt(sfn, smArn, q.repository.split('/')[1], q.job.id, c.maxAttempts);
      if (attempt === undefined) {
        console.log(JSON.stringify({ notice: 'A queued job has had its runners and still waits', org: q.org, repository: q.repository, jobId: q.job.id, jobUrl: q.job.html_url, attempts: c.maxAttempts }));
        continue;
      }
      const name = executionName(q.repository.split('/')[1], q.job.id, attempt);
      try {
        await sfn.send(new StartExecutionCommand({ stateMachineArn: smArn, name, input: JSON.stringify(runnerInput(q, c.maxIdleSeconds)) }));
      } catch (e) {
        if (e instanceof ExecutionAlreadyExists || (e as { name?: string }).name === 'ExecutionAlreadyExists') continue;
        throw e;
      }
      tasks++;
      started++;
      console.log(
        JSON.stringify({
          notice: 'Started a runner for a queued job',
          org: q.org,
          repository: q.repository,
          runId: q.job.run_id,
          jobId: q.job.id,
          job: q.job.name,
          jobUrl: q.job.html_url,
          labels: q.job.labels.join(','),
          provider: q.provider,
          queuedSeconds: Math.round((now - Date.parse(q.job.created_at)) / 1000),
          attempt: attempt + 1,
          execution: name,
        }),
      );
    } catch (e) {
      console.error(JSON.stringify({ notice: 'Requeue could not start a runner', org: q.org, jobId: q.job.id, error: String(e) }));
      failed.push(q.org);
    }
  }
  if (failed.length > 0) throw new Error(`requeue failed for ${[...new Set(failed)].join(', ')} (started ${started})`);
  return { started };
}
