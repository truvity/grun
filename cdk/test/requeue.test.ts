import { ExecutionDoesNotExist } from '@aws-sdk/client-sfn';
import { describe, expect, it } from 'vitest';
import {
  Execution,
  Free,
  GitHubJob,
  GitHubRunner,
  Queued,
  RunnerInput,
  apiBase,
  candidates,
  executionArn,
  executionName,
  freeRunners,
  labelKey,
  loadConfig,
  nextAttempt,
  pool,
  runOf,
  runnerInput,
  uncovered,
} from '../lambda/requeue/handler';

const NOW = Date.parse('2026-10-25T10:00:00Z');
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();
const providers = {
  'grun-x/acme/fg-large': ['fg-large', 'linux', 'arm64'],
  'grun-x/acme/fg-small': ['fg-small', 'linux', 'arm64'],
};
const cfg = { shapeLabels: ['fg-small', 'fg-large'], allow: undefined, graceSeconds: 90, maxJobAgeMinutes: 360 };
const target = { org: 'acme', providers, installationId: 42 };

const job = (id: number, createdAgoS: number, labels = ['fg-large'], status = 'queued', extra: Partial<GitHubJob> = {}): GitHubJob => ({
  id,
  run_id: 7,
  name: `job ${id}`,
  status,
  labels,
  created_at: ago(createdAgoS),
  html_url: `https://github.com/acme/caller/actions/runs/7/job/${id}`,
  workflow_name: 'CI',
  head_branch: 'main',
  ...extra,
});
const scanned = (...jobs: GitHubJob[]) => jobs.map((j) => ({ repository: 'acme/caller', job: j }));
const queuedOf = (...jobs: GitHubJob[]): Queued[] => candidates(scanned(...jobs), target, cfg, NOW);

const exec = (name: string, startAgoS: number, labels = 'fg-large,linux,arm64'): Execution => ({
  name,
  startMs: NOW - startAgoS * 1000,
  input: { owner: 'acme', repo: 'caller', jobId: 1, jobUrl: '', installationId: 42, jobLabels: 'fg-large', provider: 'grun-x/acme/fg-large', labels, maxIdleSeconds: 120 } as RunnerInput,
});
const runner = (name: string, busy: boolean, status = 'online', labels = ['self-hosted', 'fg-large', 'linux', 'arm64', 'cdkghr:started:1']): GitHubRunner => ({ name, status, busy, labels });

describe('requeue: which queued jobs the stack serves', () => {
  it('keeps queued jobs old enough for the webhook\'s own runner and not too old, routed to a provider', () => {
    const q = queuedOf(
      job(1, 600), // a plain stranded job
      job(2, 30), // younger than the grace: the webhook\'s runner is on its way
      job(3, 7 * 3600), // past the age limit
      job(4, 600, ['fg-large'], 'in_progress'),
      job(5, 600, ['ubuntu-latest']), // not ours: no shape label
      job(6, 600, ['self-hosted', 'FG-Small']),
    );
    expect(q.map((x) => x.job.id)).toEqual([1, 6]);
    expect(q[0]).toMatchObject({ provider: 'grun-x/acme/fg-large', providerLabels: ['fg-large', 'linux', 'arm64'], org: 'acme', installationId: 42 });
    expect(q[1].provider).toBe('grun-x/acme/fg-small');
  });

  it('applies the organisation\'s allow-list as the selector does, and sees a job once', () => {
    const allow = { acme: [{ repository: 'acme/release', workflows: ['release'], refs: ['v*'] }] };
    const c = { ...cfg, allow };
    const mine = { repository: 'acme/release', job: job(1, 600, ['fg-large'], 'queued', { workflow_name: 'release', head_branch: 'v1.2.3' }) };
    const wrongWorkflow = { repository: 'acme/release', job: job(2, 600, ['fg-large'], 'queued', { workflow_name: 'CI' }) };
    const otherRepo = { repository: 'acme/caller', job: job(3, 600) };
    expect(candidates([mine, wrongWorkflow, otherRepo, mine], target, c, NOW).map((x) => x.job.id)).toEqual([1]);
  });

  it('builds the webhook\'s input for a job: its own labels, the provider\'s labels and the idle timeout', () => {
    const [q] = queuedOf(job(9, 600, ['self-hosted', 'fg-large']));
    expect(runnerInput(q, 120)).toEqual({
      owner: 'acme',
      repo: 'caller',
      jobId: 9,
      jobUrl: 'https://github.com/acme/caller/actions/runs/7/job/9',
      installationId: 42,
      jobLabels: 'self-hosted,fg-large',
      provider: 'grun-x/acme/fg-large',
      labels: 'fg-large,linux,arm64',
      maxIdleSeconds: 120,
    });
  });
});

describe('requeue: the runners that cover a job', () => {
  it('counts a registered runner that is online and not busy, and an execution not registered yet that is young', () => {
    const free = freeRunners(
      [exec('idle', 600), exec('busy', 600), exec('offline', 600), exec('young', 60), exec('stuck', 900)],
      [runner('idle', false), runner('busy', true), runner('offline', false, 'offline')],
      NOW,
      4 * 60_000,
    );
    expect(free.map((f) => [f.name, f.kind])).toEqual([
      ['idle', 'idle'],
      ['young', 'starting'],
    ]);
    // `stuck` never registered and is past the starting window: it is no cover (a dead runner)
  });

  it('counts only the starting executions when the App may not list the runners', () => {
    const free = freeRunners([exec('old', 600), exec('young', 60)], undefined, NOW, 4 * 60_000);
    expect(free.map((f) => f.name)).toEqual(['young']);
  });

  it('ignores a runner that is not one of this stack\'s executions', () => {
    expect(freeRunners([], [runner('somebody-else', false)], NOW, 4 * 60_000)).toEqual([]);
  });
});

describe('requeue: what is left without a runner', () => {
  const free = (name: string, labels: string[], kind: Free['kind'] = 'idle'): Free => ({ name, labels: new Set(labels), kind });

  it('is every queued job when nothing is free, the oldest first (the saturated-cap case)', () => {
    const q = queuedOf(job(1, 300), job(2, 900), job(3, 600));
    expect(uncovered(q, []).map((x) => x.job.id)).toEqual([2, 3, 1]);
  });

  it('lets each free runner cover one job, the oldest it can serve', () => {
    const q = queuedOf(job(1, 300), job(2, 900), job(3, 600));
    const left = uncovered(q, [free('a', ['fg-large', 'linux']), free('b', ['fg-large', 'linux'], 'starting')]);
    expect(left.map((x) => x.job.id)).toEqual([1]);
    expect(uncovered(q, [free('a', ['fg-large']), free('b', ['fg-large']), free('c', ['fg-large'])])).toEqual([]);
  });

  it('does not let a runner of another label set cover a job', () => {
    const q = queuedOf(job(1, 600), job(2, 600, ['fg-small']));
    const left = uncovered(q, [free('a', ['fg-small', 'linux', 'arm64'])]);
    expect(left.map((x) => x.job.id)).toEqual([1]);
  });

  it('is empty when idle runners cover every queued job, so a second round starts nothing', () => {
    const q = queuedOf(job(1, 600), job(2, 700));
    const f = freeRunners([exec('a', 100), exec('b', 100)], [runner('a', false), runner('b', false)], NOW, 240_000);
    expect(uncovered(q, f)).toEqual([]);
  });

  it('rescues a job whose runner was stolen: the library\'s replacements are used up, the job is still queued and nothing is free', () => {
    const q = queuedOf(job(1, 1800));
    const f = freeRunners([exec('stolen-and-busy-on-another-job', 1700)], [runner('stolen-and-busy-on-another-job', true)], NOW, 240_000);
    expect(uncovered(q, f).map((x) => x.job.id)).toEqual([1]);
  });
});

describe('requeue: no double start', () => {
  const smArn = 'arn:partition:states:region:account-id:stateMachine:orch';
  const sfn = (existing: Set<string>) => ({
    send: async (cmd: { input: { executionArn: string } }) => {
      if (existing.has(cmd.input.executionArn)) return {};
      throw new ExecutionDoesNotExist({ message: 'no', $metadata: {} });
    },
  });

  it('names the first attempt without an execution, which is also what keeps two rounds from starting one twice', async () => {
    const taken = new Set([executionArn(smArn, executionName('caller', 5, 0)), executionArn(smArn, executionName('caller', 5, 1))]);
    expect(await nextAttempt(sfn(new Set()) as never, smArn, 'caller', 5, 5)).toBe(0);
    expect(await nextAttempt(sfn(taken) as never, smArn, 'caller', 5, 5)).toBe(2);
  });

  it('gives up on a job that has had all its attempts', async () => {
    const all = new Set([0, 1, 2].map((k) => executionArn(smArn, executionName('caller', 5, k))));
    expect(await nextAttempt(sfn(all) as never, smArn, 'caller', 5, 3)).toBeUndefined();
  });

  it('derives the execution ARN from the state machine\'s', () => {
    expect(executionArn(smArn, 'x')).toBe('arn:partition:states:region:account-id:execution:orch:x');
  });
});

describe('requeue: small parts', () => {
  it('reads the run of a job URL', () => {
    expect(runOf('https://github.com/acme/caller/actions/runs/4002725133/job/12066650173')).toEqual({ owner: 'acme', repo: 'caller', runId: 4002725133 });
    expect(runOf('nonsense')).toBeUndefined();
  });

  it('compares label sets as the library does: case and order blind', () => {
    expect(labelKey('fg-large,Linux')).toBe(labelKey(['linux', 'FG-LARGE']));
  });

  it('names a runner within GitHub\'s 64 characters, per job and attempt', () => {
    const n = executionName('a-very-long-repository-name-that-goes-on', 12066650173, 3);
    expect(n.length).toBeLessThanOrEqual(64);
    expect(n).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(executionName('r', 1, 0)).not.toBe(executionName('r', 1, 1));
    expect(executionName('r', 1, 0)).toBe(executionName('r', 1, 0));
  });

  it('talks to github.com or a GitHub Enterprise Server', () => {
    expect(apiBase('github.com')).toBe('https://api.github.com');
    expect(apiBase(undefined)).toBe('https://api.github.com');
    expect(apiBase('ghe.example.test')).toBe('https://ghe.example.test/api/v3');
  });

  it('refuses a configuration without targets or a cluster, and reads the selector\'s routing', () => {
    expect(() => loadConfig({ CLUSTER_ARN: 'c' })).toThrow(/TARGETS/);
    expect(() => loadConfig({ TARGETS: '[{"org":"a"}]' })).toThrow(/CLUSTER_ARN/);
    const c = loadConfig({
      TARGETS: '[{"org":"a","providers":{"p":["l"]}}]',
      CLUSTER_ARN: 'c',
      SHAPE_LABELS: 'fg-small,fg-large',
      ALLOW_LIST: '{"a":null}',
      IDLE_TIMEOUT_SECONDS: '120',
    });
    expect(c).toMatchObject({ maxConcurrentTasks: 20, maxJobAgeMinutes: 360, graceSeconds: 90, startingMinutes: 4, maxAttempts: 5, maxIdleSeconds: 120, shapeLabels: ['fg-small', 'fg-large'] });
    expect(c.allow).toEqual({ a: null });
  });

  it('runs a bounded number at once and stops when told', async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    let started = 0;
    await pool([1, 2, 3, 4, 5, 6, 7, 8], 3, () => started >= 5, async (n) => {
      started++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      seen.push(n);
      active--;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(seen).toHaveLength(5);
  });
});
