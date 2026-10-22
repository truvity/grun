import { ECSClient, ListTasksCommand } from '@aws-sdk/client-ecs';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AllowList, SelectorConfig, SelectorInput, allowed, globMatches, loadConfig, parseAllowList, route, runningTasks, select } from '../lambda/provider-selector/handler';

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

describe('globMatches', () => {
  it('lets * match any characters, / included, and nothing else is special', () => {
    expect(globMatches('v*', 'v1.2.3')).toBe(true);
    expect(globMatches('v*', 'x1')).toBe(false);
    expect(globMatches('release/*', 'release/2026/10')).toBe(true);
    expect(globMatches('*', '')).toBe(true);
    expect(globMatches('*/v*', 'eudi/v1.0.0')).toBe(true);
    expect(globMatches('v1.2', 'v1x2')).toBe(false); // the dot is a dot
    expect(globMatches('a+b', 'aab')).toBe(false);
    expect(globMatches('[ab]', 'a')).toBe(false);
    expect(globMatches('main', 'main2')).toBe(false);
    expect(globMatches('main', 'Main')).toBe(false); // case-sensitive
  });
});

describe('the allow-list', () => {
  const allow: AllowList = {
    acme: [
      { repository: 'acme/app' },
      { repository: 'acme/release', workflows: ['release', 'publish'], refs: ['v*', 'sdk-*/v*'] },
    ],
    open: null,
  };
  const withAllow: SelectorConfig = { ...config, allow };
  const ev = (org: string | undefined, repo: string, workflow: string | undefined, ref: string | null | undefined, labels = ['fg-large']): SelectorInput => ({
    payload: {
      organization: org ? { login: org } : undefined,
      repository: { full_name: repo },
      workflow_job: { labels, workflow_name: workflow, head_branch: ref },
    },
    providers,
  });
  const ok = (e: SelectorInput) => allowed(e.payload, allow);

  it('admits a repository that is listed without narrowing, whatever its workflow and ref', () => {
    expect(ok(ev('acme', 'acme/app', 'anything', 'any/branch'))).toBe(true);
    expect(ok(ev('acme', 'acme/app', undefined, null))).toBe(true);
  });

  it('refuses a repository that is not listed, and compares the repository case-insensitively', () => {
    expect(ok(ev('acme', 'acme/other', 'release', 'v1'))).toBe(false);
    expect(ok(ev('acme', 'acme/app-fork', 'release', 'v1'))).toBe(false);
    expect(ok(ev('acme', 'ACME/App', 'x', 'main'))).toBe(true);
    expect(ok(ev('Acme', 'acme/app', 'x', 'main'))).toBe(true); // the login is case-insensitive too
  });

  it('checks the workflow name exactly when the entry names workflows', () => {
    expect(ok(ev('acme', 'acme/release', 'release', 'v1'))).toBe(true);
    expect(ok(ev('acme', 'acme/release', 'publish', 'v1'))).toBe(true);
    expect(ok(ev('acme', 'acme/release', 'Release', 'v1'))).toBe(false);
    expect(ok(ev('acme', 'acme/release', 'release ', 'v1'))).toBe(false);
    expect(ok(ev('acme', 'acme/release', 'ci', 'v1'))).toBe(false);
    expect(ok(ev('acme', 'acme/release', undefined, 'v1'))).toBe(false); // no name in the payload: refused
  });

  it('checks the ref against the globs when the entry names refs', () => {
    expect(ok(ev('acme', 'acme/release', 'release', 'v1.2.3'))).toBe(true);
    expect(ok(ev('acme', 'acme/release', 'release', 'sdk-go/v1.2.3'))).toBe(true);
    expect(ok(ev('acme', 'acme/release', 'release', 'main'))).toBe(false);
    expect(ok(ev('acme', 'acme/release', 'release', 'xv1'))).toBe(false);
    expect(ok(ev('acme', 'acme/release', 'release', null))).toBe(false);
  });

  it('leaves an organisation marked unrestricted alone', () => {
    expect(ok(ev('open', 'open/anything', 'x', 'y'))).toBe(true);
  });

  it('refuses an organisation the file does not know, or a payload without one, once any list exists', () => {
    expect(ok(ev('stranger', 'stranger/app', 'x', 'main'))).toBe(false);
    expect(ok(ev(undefined, 'acme/app', 'x', 'main'))).toBe(false);
  });

  it('considers every job when there is no list', () => {
    expect(allowed(ev('stranger', 'stranger/app', 'x', 'main').payload, undefined)).toBe(true);
    expect(allowed(ev('stranger', 'stranger/app', 'x', 'main').payload, {})).toBe(true);
  });

  it('starts an allowed job as before', async () => {
    ecs.on(ListTasksCommand).resolves(tasks(0));
    expect((await select(ev('acme', 'acme/app', 'ci', 'main'), withAllow)).provider).toBe('grun-x/acme/fg-large');
    expect(logged.some((l) => l.includes('AllowRefused'))).toBe(false);
  });

  it('does not change routing: an allowed job that fits no provider still starts nothing', async () => {
    expect(await select(ev('acme', 'acme/app', 'ci', 'main', ['gpu']), withAllow)).toEqual({});
    expect(logged.some((l) => l.includes('AllowRefused'))).toBe(false);
  });

  it('refuses a job that is not allowed with one AllowRefused metric, and never asks ECS about it', async () => {
    expect(await select(ev('acme', 'acme/evil', 'release', 'v1'), withAllow)).toEqual({});
    expect(ecs.commandCalls(ListTasksCommand)).toHaveLength(0);
    const lines = logged.filter((l) => l.includes('AllowRefused'));
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]);
    expect(line._aws.CloudWatchMetrics[0]).toEqual({ Namespace: 'Grun', Dimensions: [['Stack']], Metrics: [{ Name: 'AllowRefused', Unit: 'Count' }] });
    expect(line).toMatchObject({ Stack: 'grun-x', AllowRefused: 1, repository: 'acme/evil', workflow: 'release', ref: 'v1' });
    expect(logged.some((l) => l.includes('CapRefused'))).toBe(false);
  });

  it('refuses before the cap, even where the cluster is full or the cap defers', async () => {
    ecs.on(ListTasksCommand).resolves(tasks(9));
    await expect(select(ev('acme', 'acme/release', 'release', 'main'), { ...withAllow, onExceed: 'defer' })).resolves.toEqual({});
    expect(ecs.commandCalls(ListTasksCommand)).toHaveLength(0);
  });

  it('refuses the job of an unknown organisation (fail closed) and records it', async () => {
    expect(await select(ev('stranger', 'stranger/app', 'ci', 'main'), withAllow)).toEqual({});
    expect(JSON.parse(logged.find((l) => l.includes('AllowRefused'))!)).toMatchObject({ organization: 'stranger', repository: 'stranger/app' });
  });
});

describe('parseAllowList', () => {
  it('reads a map keyed by organisation, lowercasing the key', () => {
    expect(parseAllowList('{"Acme":[{"repository":"acme/app","refs":["v*"]}],"open":null}')).toEqual({
      acme: [{ repository: 'acme/app', refs: ['v*'] }],
      open: null,
    });
  });

  it.each([
    ['not json', '{'],
    ['an array', '[]'],
    ['a string', '"x"'],
    ['an empty list', '{"acme":[]}'],
    ['a non-list', '{"acme":{"repository":"acme/app"}}'],
    ['an entry without a repository', '{"acme":[{"refs":["v*"]}]}'],
    ['a repository without an owner', '{"acme":[{"repository":"app"}]}'],
    ['an unknown key', '{"acme":[{"repository":"acme/app","branch":"main"}]}'],
    ['empty workflows', '{"acme":[{"repository":"acme/app","workflows":[]}]}'],
    ['a non-string ref', '{"acme":[{"repository":"acme/app","refs":[1]}]}'],
    ['the same organisation twice', '{"acme":null,"ACME":null}'],
  ])('throws on %s', (_n, text) => {
    expect(() => parseAllowList(text)).toThrow(/ALLOW_LIST/);
  });
});

describe('loadConfig', () => {
  it('reads ALLOW_LIST and throws on a malformed one', () => {
    const base = { CLUSTER_ARN: 'c', MAX_CONCURRENT_TASKS: '1', ON_EXCEED: 'skip', SHAPE_LABELS: 'a', STACK_NAME: 's' };
    expect(loadConfig({ ...base, ALLOW_LIST: '{"acme":[{"repository":"acme/app"}]}' }).allow).toEqual({ acme: [{ repository: 'acme/app' }] });
    expect(loadConfig(base)).not.toHaveProperty('allow');
    expect(() => loadConfig({ ...base, ALLOW_LIST: '{"acme":' })).toThrow('ALLOW_LIST');
  });

  it('reads the environment', () => {
    expect(
      loadConfig({ CLUSTER_ARN: 'c', MAX_CONCURRENT_TASKS: '20', ON_EXCEED: 'defer', SHAPE_LABELS: 'a,b', STACK_NAME: 's' }),
    ).toEqual({ clusterArn: 'c', maxConcurrentTasks: 20, onExceed: 'defer', shapeLabels: ['a', 'b'], stackName: 's' });
  });

  it('names a missing variable', () => {
    expect(() => loadConfig({})).toThrow('CLUSTER_ARN');
  });
});
