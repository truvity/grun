import { ECSClient, ListTasksCommand } from '@aws-sdk/client-ecs';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SelectorConfig, SelectorInput, loadConfig, route, runningTasks, select } from '../lambda/provider-selector/handler';

const providers = {
  'grun-x/acme/fg-large': ['fg-large', 'linux', 'arm64'],
  'grun-x/acme/fg-medium': ['fg-medium', 'linux', 'arm64'],
  'grun-x/acme/fg-small': ['fg-small', 'linux', 'arm64'],
};
const shapeLabels = ['fg-small', 'fg-medium', 'fg-large'];
const job = (labels: string[], extra: Partial<SelectorInput> = {}): SelectorInput => ({
  payload: { workflow_job: { labels }, repository: { full_name: 'acme/repo' } },
  providers,
  ...extra,
});
const config: SelectorConfig = { clusterArn: 'cluster', maxConcurrentTasks: 3, onExceed: 'skip', shapeLabels, stackName: 'grun-x' };

const ecs = mockClient(ECSClient);
const tasks = (n: number, token?: string) => ({ taskArns: Array.from({ length: n }, (_, i) => `t${i}`), nextToken: token });

let logged: string[];
beforeEach(() => {
  ecs.reset();
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => void logged.push(a.join(' ')));
});
afterEach(() => vi.restoreAllMocks());

describe('route', () => {
  it('sends a job to the provider of its shape label', () => {
    expect(route(job(['self-hosted', 'linux', 'arm64', 'fg-medium']), shapeLabels)).toEqual({
      provider: 'grun-x/acme/fg-medium',
      labels: providers['grun-x/acme/fg-medium'],
    });
  });

  it('is case blind', () => {
    expect(route(job(['FG-Small']), shapeLabels).provider).toBe('grun-x/acme/fg-small');
  });

  it('gives a job that names two shapes the larger one', () => {
    expect(route(job(['fg-small', 'fg-large']), shapeLabels).provider).toBe('grun-x/acme/fg-large');
  });

  it('keeps the default choice when the job names no shape', () => {
    const r = route(job(['linux'], { defaultProvider: 'grun-x/acme/fg-medium', defaultLabels: ['fg-medium'] }), shapeLabels);
    expect(r).toEqual({ provider: 'grun-x/acme/fg-medium', labels: ['fg-medium'] });
  });

  it('starts nothing for a job that fits no provider', () => {
    expect(route(job(['gpu']), shapeLabels)).toEqual({});
  });
});

describe('runningTasks', () => {
  it('counts across pages and stops once past the limit', async () => {
    ecs.on(ListTasksCommand).resolvesOnce(tasks(2, 'next')).resolvesOnce(tasks(2, 'more')).resolvesOnce(tasks(2));
    expect(await runningTasks(new ECSClient({}), 'c', 3)).toBe(4);
    expect(ecs.commandCalls(ListTasksCommand)).toHaveLength(2);
    expect(ecs.commandCalls(ListTasksCommand)[0].args[0].input).toMatchObject({ cluster: 'c', desiredStatus: 'RUNNING' });
  });
});

describe('select', () => {
  it('starts the job below the cap', async () => {
    ecs.on(ListTasksCommand).resolves(tasks(2));
    expect((await select(job(['fg-large']), config)).provider).toBe('grun-x/acme/fg-large');
  });

  it('refuses at the cap, records the metric and starts nothing', async () => {
    ecs.on(ListTasksCommand).resolves(tasks(3));
    expect(await select(job(['fg-large']), config)).toEqual({});
    const line = JSON.parse(logged.find((l) => l.includes('CapRefused'))!);
    expect(line._aws.CloudWatchMetrics[0]).toMatchObject({ Namespace: 'Grun', Metrics: [{ Name: 'CapRefused' }] });
    expect(line).toMatchObject({ Stack: 'grun-x', CapRefused: 1, running: 3, max: 3, action: 'skip', repository: 'acme/repo' });
  });

  it('fails the delivery in defer mode, so that GitHub redelivers it', async () => {
    ecs.on(ListTasksCommand).resolves(tasks(5));
    await expect(select(job(['fg-large']), { ...config, onExceed: 'defer' })).rejects.toThrow('task cap reached');
    expect(logged.some((l) => l.includes('CapRefused'))).toBe(true);
  });

  it('does not ask ECS about a job it would not start anyway', async () => {
    expect(await select(job(['gpu']), config)).toEqual({});
    expect(ecs.commandCalls(ListTasksCommand)).toHaveLength(0);
  });
});

describe('loadConfig', () => {
  it('reads the environment', () => {
    expect(
      loadConfig({ CLUSTER_ARN: 'c', MAX_CONCURRENT_TASKS: '20', ON_EXCEED: 'defer', SHAPE_LABELS: 'a,b', STACK_NAME: 's' }),
    ).toEqual({ clusterArn: 'c', maxConcurrentTasks: 20, onExceed: 'defer', shapeLabels: ['a', 'b'], stackName: 's' });
  });

  it('names a missing variable', () => {
    expect(() => loadConfig({})).toThrow('CLUSTER_ARN');
  });
});
