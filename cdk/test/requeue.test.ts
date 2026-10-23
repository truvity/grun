import { describe, expect, it } from 'vitest';
import { GitHub, GitHubJob, RunnerInput, apiBase, executionName, labelKey, loadConfig, plan, runOf } from '../lambda/requeue/handler';

const NOW = Date.parse('2026-10-23T22:00:00Z');
const input = (jobId: number, runId = 7, jobLabels = 'fg-large'): RunnerInput => ({
  owner: 'acme',
  repo: 'caller',
  jobId,
  jobUrl: `https://github.com/acme/caller/actions/runs/${runId}/job/${jobId}`,
  installationId: 42,
  jobLabels,
  provider: 'grun-x/acme/fg-large',
  labels: 'fg-large,linux,arm64',
  maxIdleSeconds: 300,
});
const job = (id: number, status: string, created = '2026-10-23T21:30:00Z', labels = ['fg-large']): GitHubJob => ({
  id,
  status,
  labels,
  created_at: created,
  html_url: `https://github.com/acme/caller/actions/runs/7/job/${id}`,
});
const gh = (status: string, jobs: GitHubJob[]): GitHub & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    run: async (_o, _r, id) => {
      calls.push(`run ${id}`);
      return { status };
    },
    jobs: async (_o, _r, id) => {
      calls.push(`jobs ${id}`);
      return jobs;
    },
  };
};
const SIX_HOURS = 6 * 60 * 60_000;

describe('requeue: what a run lacks', () => {
  it('starts one runner per queued job of the run less the runners still running for it (the max-parallel case)', async () => {
    // 18 jobs at max-parallel 4: two were runnable only after every runner had been reaped.
    const github = gh('in_progress', [job(1, 'completed'), job(2, 'queued'), job(3, 'queued', '2026-10-23T21:29:00Z'), job(4, 'in_progress')]);
    const { starts, notes } = await plan([{ input: input(9), why: 'ABORTED IdleRunner' }], new Map(), github, NOW, SIX_HOURS);
    // The oldest first, each pointed at its own job, the rest of the webhook's input kept.
    expect(starts.map((s) => s.input.jobId)).toEqual([3, 2]);
    expect(starts[0].input).toMatchObject({ provider: 'grun-x/acme/fg-large', labels: 'fg-large,linux,arm64', installationId: 42, jobUrl: 'https://github.com/acme/caller/actions/runs/7/job/3' });
    expect(new Set(starts.map((s) => s.name)).size).toBe(2);
    expect(notes).toHaveLength(1);
  });

  it('counts the runners still running for the run, so a second round starts nothing', async () => {
    const github = gh('in_progress', [job(2, 'queued'), job(3, 'queued')]);
    const { starts } = await plan([{ input: input(9), why: 'ABORTED IdleRunner' }], new Map([['7|fg-large', 2]]), github, NOW, SIX_HOURS);
    expect(starts).toEqual([]);
    const one = await plan([{ input: input(9), why: 'x' }], new Map([['7|fg-large', 1]]), github, NOW, SIX_HOURS);
    expect(one.starts).toHaveLength(1);
  });

  it('leaves a finished run alone, even with queued records a re-run left behind', async () => {
    const github = gh('completed', [job(2, 'queued')]);
    const { starts } = await plan([{ input: input(9), why: 'x' }], new Map(), github, NOW, SIX_HOURS);
    expect(starts).toEqual([]);
    expect(github.calls).toEqual(['run 7']);
  });

  it('serves only jobs of the same label set, and none past the age limit', async () => {
    const github = gh('in_progress', [
      job(2, 'queued', '2026-10-23T21:30:00Z', ['fg-small']),
      job(3, 'queued', '2026-10-23T15:00:00Z'),
      job(4, 'queued', '2026-10-23T21:50:00Z', ['FG-Large']),
    ]);
    const { starts } = await plan([{ input: input(9), why: 'x' }], new Map(), github, NOW, SIX_HOURS);
    expect(starts.map((s) => s.input.jobId)).toEqual([4]);
  });

  it('asks GitHub once per run however many runners of it ended', async () => {
    const github = gh('in_progress', [job(2, 'queued')]);
    const { starts } = await plan(
      [
        { input: input(8), why: 'x' },
        { input: input(9), why: 'x' },
      ],
      new Map(),
      github,
      NOW,
      SIX_HOURS,
    );
    expect(starts).toHaveLength(1);
    expect(github.calls).toEqual(['run 7', 'jobs 7']);
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

  it('names a runner within GitHub\'s 64 characters, uniquely per start', () => {
    const n = executionName('a-very-long-repository-name-that-goes-on', 12066650173, NOW);
    expect(n.length).toBeLessThanOrEqual(64);
    expect(n).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(executionName('r', 1, NOW)).not.toBe(executionName('r', 1, NOW + 1));
  });

  it('talks to github.com or a GitHub Enterprise Server', () => {
    expect(apiBase('github.com')).toBe('https://api.github.com');
    expect(apiBase(undefined)).toBe('https://api.github.com');
    expect(apiBase('ghe.example.test')).toBe('https://ghe.example.test/api/v3');
  });

  it('refuses a configuration without targets or a cluster', () => {
    expect(() => loadConfig({ CLUSTER_ARN: 'c' })).toThrow(/TARGETS/);
    expect(() => loadConfig({ TARGETS: '[{"org":"a"}]' })).toThrow(/CLUSTER_ARN/);
    expect(loadConfig({ TARGETS: '[{"org":"a"}]', CLUSTER_ARN: 'c' })).toMatchObject({ maxConcurrentTasks: 20, windowMinutes: 30, maxJobAgeMinutes: 360 });
  });
});
