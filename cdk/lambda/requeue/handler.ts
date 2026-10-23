// Runs every few minutes and starts a runner again for a job that is still
// queued after the runner started for it went away.
//
// cdk-github-runners starts one runner per `workflow_job` queued webhook and its
// idle reaper stops a runner that has not taken a job within the idle timeout.
// GitHub sends that webhook once, when the job is created. A matrix with
// `max-parallel` creates all its jobs at once but dispatches only so many at a
// time, so the last jobs become runnable long after their runners were reaped,
// and nothing ever starts another runner for them: they stay queued until
// someone cancels them (seen on a renovate fleet of 18 jobs at max-parallel 4).
// Runners are interchangeable within a label set, so the job a runner was
// started for is not the one it takes, and a stranded job's own runner may well
// have succeeded on another job.
//
// So the unit is the workflow run, not the job. Every run of which a runner of
// this stack ended without a job (aborted by the idle reaper) or failed to start
// in the window is looked at: its jobs that are still queued, minus the runners
// of this stack still running for that run, is how many runners it lacks, per
// label set. Those are started through the same state machine, with the input
// the webhook gave, pointed at the stranded job. The task cap holds; a job
// queued for longer than the age limit, and a run that has completed (a re-run
// can leave queued records behind in a finished run), are left alone.
import { ECSClient, ListTasksCommand } from '@aws-sdk/client-ecs';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  DescribeExecutionCommand,
  ExecutionStatus,
  ListExecutionsCommand,
  SFNClient,
  StartExecutionCommand,
} from '@aws-sdk/client-sfn';
import * as crypto from 'node:crypto';

export interface Target {
  org: string;
  stateMachineArn: string;
  githubSecretArn: string;
  privateKeySecretArn: string;
}

export interface RequeueConfig {
  targets: Target[];
  clusterArn: string;
  maxConcurrentTasks: number;
  /** Executions that ended this recently are looked at. */
  windowMinutes: number;
  /** A job queued for longer than this is not served again. */
  maxJobAgeMinutes: number;
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
  status: string;
  labels: string[];
  created_at: string;
  html_url: string;
}

export interface GitHub {
  run(owner: string, repo: string, runId: number): Promise<{ status: string }>;
  jobs(owner: string, repo: string, runId: number): Promise<GitHubJob[]>;
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
    targets,
    clusterArn: env.CLUSTER_ARN,
    maxConcurrentTasks: n('MAX_CONCURRENT_TASKS', 20),
    windowMinutes: n('WINDOW_MINUTES', 30),
    maxJobAgeMinutes: n('MAX_JOB_AGE_MINUTES', 360),
  };
}

/** owner/repo/run of a job URL: https://github.com/<owner>/<repo>/actions/runs/<run>/job/<job>. */
export function runOf(jobUrl: string): { owner: string; repo: string; runId: number } | undefined {
  const m = /\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/job\/\d+/.exec(jobUrl);
  return m ? { owner: m[1], repo: m[2], runId: Number(m[3]) } : undefined;
}

/** The label set as cdk-github-runners compares it: lowercase, order-free. */
export function labelKey(labels: string[] | string): string {
  const list = Array.isArray(labels) ? labels : labels.split(',');
  return list
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(',');
}

/** A runner name GitHub accepts (at most 64 characters), unique per start. */
export function executionName(repo: string, jobId: number, now: number): string {
  const safe = repo.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 24);
  return `${safe}-rq-${jobId}-${now.toString(36)}`.slice(0, 64);
}

interface Ended {
  input: RunnerInput;
  why: string;
}

/** Executions that ended without serving a job (idle reaper) or failed, in the window. */
async function ended(sfn: SFNClient, target: Target, sinceMs: number): Promise<Ended[]> {
  const out: Ended[] = [];
  for (const status of [ExecutionStatus.ABORTED, ExecutionStatus.FAILED, ExecutionStatus.TIMED_OUT]) {
    let token: string | undefined;
    do {
      const page = await sfn.send(new ListExecutionsCommand({ stateMachineArn: target.stateMachineArn, statusFilter: status, maxResults: 100, nextToken: token }));
      token = page.nextToken;
      let older = false;
      for (const e of page.executions ?? []) {
        // Newest first; an idle abort comes minutes after the start, a failure sooner.
        if ((e.startDate?.getTime() ?? 0) < sinceMs - 60 * 60_000) {
          older = true;
          break;
        }
        if ((e.stopDate?.getTime() ?? 0) < sinceMs) continue;
        const d = await sfn.send(new DescribeExecutionCommand({ executionArn: e.executionArn }));
        if (status === ExecutionStatus.ABORTED && d.error !== 'IdleRunner') continue;
        try {
          out.push({ input: JSON.parse(d.input ?? '{}') as RunnerInput, why: `${status} ${d.error ?? ''}`.trim() });
        } catch {
          /* not one of the webhook's */
        }
      }
      if (older) break;
    } while (token);
  }
  return out;
}

/** Runners of this stack still running, per run and label set. */
async function running(sfn: SFNClient, target: Target): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  let token: string | undefined;
  do {
    const page = await sfn.send(new ListExecutionsCommand({ stateMachineArn: target.stateMachineArn, statusFilter: ExecutionStatus.RUNNING, maxResults: 100, nextToken: token }));
    token = page.nextToken;
    for (const e of page.executions ?? []) {
      const d = await sfn.send(new DescribeExecutionCommand({ executionArn: e.executionArn }));
      try {
        const input = JSON.parse(d.input ?? '{}') as RunnerInput;
        const run = runOf(input.jobUrl ?? '');
        if (!run) continue;
        const k = `${run.runId}|${labelKey(input.jobLabels ?? '')}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      } catch {
        /* not one of the webhook's */
      }
    }
  } while (token);
  return counts;
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

export interface Start {
  name: string;
  input: RunnerInput;
}

/**
 * The runners a set of ended executions calls for: per run and label set, its
 * still-queued jobs less the runners still running for it. Pure, for the tests.
 */
export async function plan(
  endedRunners: Ended[],
  runningCounts: Map<string, number>,
  github: GitHub,
  nowMs: number,
  maxJobAgeMs: number,
): Promise<{ starts: Start[]; notes: Record<string, unknown>[] }> {
  const starts: Start[] = [];
  const notes: Record<string, unknown>[] = [];
  // One sample input per run and label set: provider, labels and installation are the same for each.
  const groups = new Map<string, { run: NonNullable<ReturnType<typeof runOf>>; sample: RunnerInput; key: string }>();
  for (const e of endedRunners) {
    const run = runOf(e.input.jobUrl ?? '');
    if (!run) continue;
    const key = labelKey(e.input.jobLabels ?? '');
    groups.set(`${run.runId}|${key}`, { run, sample: e.input, key });
  }
  const runs = new Map<number, { status: string; jobs: GitHubJob[] }>();
  for (const [k, g] of groups) {
    let r = runs.get(g.run.runId);
    if (!r) {
      const meta = await github.run(g.run.owner, g.run.repo, g.run.runId);
      r = { status: meta.status, jobs: meta.status === 'completed' ? [] : await github.jobs(g.run.owner, g.run.repo, g.run.runId) };
      runs.set(g.run.runId, r);
    }
    if (r.status === 'completed') continue;
    const queued = r.jobs.filter(
      (j) => j.status === 'queued' && labelKey(j.labels) === g.key && nowMs - Date.parse(j.created_at) <= maxJobAgeMs,
    );
    const lacking = queued.length - (runningCounts.get(k) ?? 0);
    if (lacking <= 0) continue;
    notes.push({ notice: 'Queued jobs without a runner', owner: g.run.owner, repo: g.run.repo, runId: g.run.runId, labels: g.key, queued: queued.length, running: runningCounts.get(k) ?? 0 });
    // The oldest jobs first; any runner of the label set may take any of them.
    queued.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    for (const job of queued.slice(0, lacking)) {
      starts.push({
        name: executionName(g.run.repo, job.id, nowMs + starts.length),
        input: { ...g.sample, jobId: job.id, jobUrl: job.html_url },
      });
    }
  }
  return { starts, notes };
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

export function gitHubFor(secrets: { domain?: string; appId: string; privateKey: string }): (installationId: number) => GitHub {
  const base = apiBase(secrets.domain);
  const tokens = new Map<number, Promise<string>>();
  const token = (installationId: number) => {
    let t = tokens.get(installationId);
    if (!t) {
      t = (async () => {
        const res = await fetch(`${base}/app/installations/${installationId}/access_tokens`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${appJwt(secrets.appId, secrets.privateKey, Math.floor(Date.now() / 1000))}`, Accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`installation token: HTTP ${res.status}`);
        return ((await res.json()) as { token: string }).token;
      })();
      tokens.set(installationId, t);
    }
    return t;
  };
  return (installationId: number): GitHub => {
    const get = async (p: string) => {
      const res = await fetch(`${base}${p}`, {
        headers: { Authorization: `Bearer ${await token(installationId)}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`GET ${p}: HTTP ${res.status}`);
      return res.json();
    };
    return {
      run: async (owner, repo, runId) => (await get(`/repos/${owner}/${repo}/actions/runs/${runId}`)) as { status: string },
      jobs: async (owner, repo, runId) => {
        const out: GitHubJob[] = [];
        for (let page = 1; page <= 10; page++) {
          const r = (await get(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`)) as { jobs: GitHubJob[] };
          out.push(...r.jobs);
          if (r.jobs.length < 100) break;
        }
        return out;
      },
    };
  };
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

export async function handler(): Promise<{ started: number }> {
  const c = loadConfig(process.env);
  const now = Date.now();
  let started = 0;
  let tasks: number | undefined;
  const failed: string[] = [];
  for (const t of c.targets) {
    try {
      const endedRunners = await ended(sfn, t, now - c.windowMinutes * 60_000);
      if (endedRunners.length === 0) continue;
      const counts = await running(sfn, t);
      const github = gitHubFor(await secretsOf(t));
      // One GitHub client per installation; a run belongs to one.
      const byInstallation = new Map<number, Ended[]>();
      for (const e of endedRunners) byInstallation.set(e.input.installationId, [...(byInstallation.get(e.input.installationId) ?? []), e]);
      for (const [installationId, list] of byInstallation) {
        const { starts, notes } = await plan(list, counts, github(installationId), now, c.maxJobAgeMinutes * 60_000);
        for (const n of notes) console.log(JSON.stringify({ ...n, org: t.org }));
        for (const s of starts) {
          tasks ??= await runningTasks(ecs, c.clusterArn);
          if (tasks >= c.maxConcurrentTasks) {
            console.log(JSON.stringify({ notice: 'Task cap reached, the job waits for the next round', org: t.org, jobId: s.input.jobId, tasks }));
            break;
          }
          await sfn.send(new StartExecutionCommand({ stateMachineArn: t.stateMachineArn, name: s.name, input: JSON.stringify(s.input) }));
          tasks++;
          started++;
          console.log(JSON.stringify({ notice: 'Started a runner for a queued job', org: t.org, execution: s.name, jobId: s.input.jobId, jobUrl: s.input.jobUrl, labels: s.input.jobLabels }));
        }
      }
    } catch (e) {
      // One organisation's failure does not stop the others; the function's errors alarm.
      console.error(JSON.stringify({ notice: 'Requeue failed', org: t.org, error: String(e) }));
      failed.push(t.org);
    }
  }
  if (failed.length > 0) throw new Error(`requeue failed for ${failed.join(', ')} (started ${started})`);
  return { started };
}
