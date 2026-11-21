import { DescribeTasksCommand, ECSClient, ListTasksCommand } from '@aws-sdk/client-ecs';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AllowList, SelectorConfig, SelectorInput, allowed, globMatches, loadConfig, parseAllowList, parseOrgCaps, route, runningTasks, runningTasksOf, select } from '../lambda/provider-selector/handler';

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

  it('refuses a ref that matches refsExclude, and leaves an entry without it as it was', () => {
    const tags: AllowList = {
      acme: [
        { repository: 'acme/wallet', workflows: ['Release'], refs: ['v*', 'main'], refsExclude: ['v*-*'] },
        { repository: 'acme/wallet', workflows: ['Release'], refs: ['v*-rc.*'] },
      ],
    };
    const tagOk = (ref: string | null) => allowed(ev('acme', 'acme/wallet', 'Release', ref).payload, tags);
    expect(tagOk('v1.0.14')).toBe(true); // stable
    expect(tagOk('main')).toBe(true);
    expect(tagOk('v1.0.14-rc.2')).toBe(true); // refused by the first entry, admitted by the second
    expect(tagOk('v1.0.14-login.1')).toBe(false); // a test tag: excluded, and no entry admits it
    expect(tagOk('feature/x')).toBe(false);
    expect(tagOk(null)).toBe(false);
    const only: AllowList = { acme: [{ repository: 'acme/wallet', refs: ['v*'], refsExclude: ['v*-*'] }] };
    expect(allowed(ev('acme', 'acme/wallet', 'x', 'v1.0.14-rc.2').payload, only)).toBe(false);
    // without refsExclude nothing changes
    expect(ok(ev('acme', 'acme/release', 'release', 'v1.2.3-rc.1'))).toBe(true);
  });

  it('applies refsExclude to an entry without refs (any ref but the excluded ones)', () => {
    const noRefs: AllowList = { acme: [{ repository: 'acme/app', refsExclude: ['dependabot/*'] }] };
    expect(allowed(ev('acme', 'acme/app', 'ci', 'main').payload, noRefs)).toBe(true);
    expect(allowed(ev('acme', 'acme/app', 'ci', 'dependabot/npm/x').payload, noRefs)).toBe(false);
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

describe('the org-wide row (owner/*)', () => {
  // AW-148: a new repository of the organisation needs no change to the list.
  const wide: AllowList = { acme: [{ repository: 'acme/*', workflows: ['Release'], refs: ['v*'] }] };
  const ev = (org: string | undefined, repo: string | undefined, workflow: string | undefined, ref: string | null | undefined) => ({
    organization: org ? { login: org } : undefined,
    repository: repo ? { full_name: repo } : undefined,
    workflow_job: { labels: ['fg-large'], workflow_name: workflow, head_branch: ref },
  });
  const ok = (org: string | undefined, repo: string | undefined, workflow: string | undefined, ref: string | null | undefined) =>
    allowed(ev(org, repo, workflow, ref), wide);

  it('admits the named workflow on a tag of any repository of the organisation, one never listed too', () => {
    expect(ok('acme', 'acme/landing-ie', 'Release', 'v1.0.0')).toBe(true);
    expect(ok('acme', 'acme/landing-dom', 'Release', 'v0.1.0')).toBe(true);
    expect(ok('acme', 'acme/a-repository-made-tomorrow', 'Release', 'v2.3.4')).toBe(true);
    expect(ok('acme', 'ACME/Mixed-Case', 'Release', 'v1')).toBe(true);
  });

  it('keeps the narrowing: another workflow, a branch or a missing name stays refused', () => {
    expect(ok('acme', 'acme/app', 'CI', 'v1.0.0')).toBe(false);
    expect(ok('acme', 'acme/app', 'Release', 'main')).toBe(false);
    expect(ok('acme', 'acme/app', 'Release', null)).toBe(false);
    expect(ok('acme', 'acme/app', undefined, 'v1')).toBe(false);
  });

  it('is the organisation\'s only: not a repository of another owner, not a prefix, not a nested name', () => {
    expect(ok('acme', 'acme-evil/app', 'Release', 'v1')).toBe(false);
    expect(ok('acme', 'other/app', 'Release', 'v1')).toBe(false);
    expect(ok('acme', 'acme/', 'Release', 'v1')).toBe(false);
    expect(ok('acme', 'acme/a/b', 'Release', 'v1')).toBe(false);
    expect(ok('acme', undefined, 'Release', 'v1')).toBe(false);
    expect(ok('other', 'other/app', 'Release', 'v1')).toBe(false); // an organisation with no row at all
  });

  it('honours refsExclude, and mixes with rows that name a repository', () => {
    const mixed: AllowList = {
      acme: [
        { repository: 'acme/*', workflows: ['Release'], refs: ['v*'], refsExclude: ['v*-*'] },
        { repository: 'acme/wallet', workflows: ['Deploy'], refs: ['main'] },
      ],
    };
    const a = (repo: string, wf: string, ref: string) => allowed(ev('acme', repo, wf, ref), mixed);
    expect(a('acme/new', 'Release', 'v1.0.0')).toBe(true);
    expect(a('acme/new', 'Release', 'v1.0.0-rc.1')).toBe(false);
    expect(a('acme/wallet', 'Deploy', 'main')).toBe(true);
    expect(a('acme/new', 'Deploy', 'main')).toBe(false);
  });

  it('is read by parseAllowList, and only when it narrows', () => {
    expect(parseAllowList('{"acme":[{"repository":"acme/*","workflows":["Release"],"refs":["v*"]}]}')).toEqual(wide);
    expect(parseAllowList('{"acme":[{"repository":"acme/*","refs":["v*"]}]}').acme).toHaveLength(1);
    expect(() => parseAllowList('{"acme":[{"repository":"acme/*"}]}')).toThrow(/needs workflows or refs/);
    expect(() => parseAllowList('{"acme":[{"repository":"acme/*","refsExclude":["v*-*"]}]}')).toThrow(/needs workflows or refs/);
    expect(() => parseAllowList('{"acme":[{"repository":"acme/app*","refs":["v*"]}]}')).toThrow(/owner\/name or owner\/\*/);
    expect(() => parseAllowList('{"acme":[{"repository":"*/app","refs":["v*"]}]}')).toThrow(/owner\/name or owner\/\*/);
  });
});

describe('the cap of one organisation', () => {
  const taggedTask = (arn: string, org: string) => ({ taskArn: arn, tags: [{ key: 'company', value: org }] });
  const ev = (org: string): SelectorInput => ({
    payload: { organization: { login: org }, repository: { full_name: `${org}/app` }, workflow_job: { labels: ['fg-large'] } },
    providers,
  });
  const capped: SelectorConfig = { ...config, maxConcurrentTasks: 10, orgCaps: { acme: 2 }, orgTagKey: 'company' };

  it('counts the tasks of the organisation by tag, across pages and batches of 100', async () => {
    const arns = Array.from({ length: 150 }, (_, i) => `t${i}`);
    ecs.on(ListTasksCommand).resolvesOnce({ taskArns: arns, nextToken: 'n' }).resolvesOnce({ taskArns: ['t150'] });
    ecs.on(DescribeTasksCommand).callsFake((i) => ({
      tasks: (i.tasks as string[]).map((a) => taggedTask(a, Number(a.slice(1)) % 3 === 0 ? 'Acme' : 'other')),
    }));
    expect(await runningTasksOf(new ECSClient({}), 'c', 'company', 'acme', 1000)).toBe(51); // 0, 3, ... 150, case-insensitive
    expect(ecs.commandCalls(DescribeTasksCommand).map((c) => c.args[0].input.tasks!.length)).toEqual([100, 50, 1]);
    expect(ecs.commandCalls(DescribeTasksCommand)[0].args[0].input.include).toEqual(['TAGS']);
  });

  it('stops reading once past the limit', async () => {
    ecs.on(ListTasksCommand).resolvesOnce({ taskArns: ['t0', 't1'], nextToken: 'n' }).resolvesOnce({ taskArns: ['t2'] });
    ecs.on(DescribeTasksCommand).callsFake((i) => ({ tasks: (i.tasks as string[]).map((a) => taggedTask(a, 'acme')) }));
    expect(await runningTasksOf(new ECSClient({}), 'c', 'company', 'acme', 2)).toBe(2);
    expect(ecs.commandCalls(ListTasksCommand)).toHaveLength(1);
  });

  it('is zero for no task, and ignores a task without the tag', async () => {
    ecs.on(ListTasksCommand).resolves({ taskArns: [] });
    expect(await runningTasksOf(new ECSClient({}), 'c', 'company', 'acme', 5)).toBe(0);
    ecs.reset();
    ecs.on(ListTasksCommand).resolves({ taskArns: ['t0', 't1'] });
    ecs.on(DescribeTasksCommand).resolves({ tasks: [{ taskArn: 't0' }, { taskArn: 't1', tags: [{ key: 'other', value: 'acme' }] }] });
    expect(await runningTasksOf(new ECSClient({}), 'c', 'company', 'acme', 5)).toBe(0);
  });

  const cluster = (acme: number, other: number) => {
    // ListTasks is called for the shared count (ARNs only) and for the organisation's count.
    ecs.on(ListTasksCommand).resolves({ taskArns: [...Array.from({ length: acme }, (_, i) => `a${i}`), ...Array.from({ length: other }, (_, i) => `o${i}`)] });
    ecs.on(DescribeTasksCommand).callsFake((i) => ({
      tasks: (i.tasks as string[]).map((a) => taggedTask(a, a.startsWith('a') ? 'acme' : 'other')),
    }));
  };

  it('refuses a job of the organisation at its cap although the shared one has room, with one OrgCapRefused metric', async () => {
    cluster(2, 1);
    expect(await select(ev('acme'), capped)).toEqual({});
    const lines = logged.filter((l) => l.includes('OrgCapRefused'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ Stack: 'grun-x', OrgCapRefused: 1, organization: 'acme', running: 2, max: 2, action: 'skip' });
    expect(logged.some((l) => l.includes('"CapRefused"'))).toBe(false);
  });

  it('starts the job below the cap', async () => {
    cluster(1, 5);
    expect((await select(ev('acme'), capped)).provider).toBe('grun-x/acme/fg-large');
  });

  it('leaves another organisation alone: no cap of its own, no DescribeTasks', async () => {
    ecs.on(ListTasksCommand).resolves(tasks(3));
    expect((await select(ev('other'), capped)).provider).toBe('grun-x/acme/fg-large'); // the fixture has one provider table
    expect(ecs.commandCalls(DescribeTasksCommand)).toHaveLength(0);
  });

  it('defers like the shared cap when onExceed is defer', async () => {
    cluster(2, 0);
    await expect(select(ev('acme'), { ...capped, onExceed: 'defer' })).rejects.toThrow(/task cap of acme reached \(2\/2\)/);
  });

  it('is inside the shared cap: the shared cap still refuses first', async () => {
    ecs.on(ListTasksCommand).resolves(tasks(10));
    expect(await select(ev('acme'), capped)).toEqual({});
    expect(logged.some((l) => l.includes('"CapRefused"'))).toBe(true);
    expect(ecs.commandCalls(DescribeTasksCommand)).toHaveLength(0);
  });

  it('is read from ORG_CAPS and ORG_TAG_KEY, strictly', () => {
    const base = { CLUSTER_ARN: 'c', MAX_CONCURRENT_TASKS: '10', ON_EXCEED: 'skip', SHAPE_LABELS: 'a', STACK_NAME: 's' };
    expect(loadConfig({ ...base, ORG_CAPS: '{"Acme":2}', ORG_TAG_KEY: 'company' })).toMatchObject({ orgCaps: { acme: 2 }, orgTagKey: 'company' });
    expect(loadConfig(base)).not.toHaveProperty('orgCaps');
    expect(() => loadConfig({ ...base, ORG_CAPS: '{"acme":2}' })).toThrow('ORG_TAG_KEY');
    expect(parseOrgCaps('{}')).toEqual({});
    for (const bad of ['{', '[]', '{"acme":0}', '{"acme":1.5}', '{"acme":"2"}', '{"acme":1,"ACME":2}']) {
      expect(() => parseOrgCaps(bad), bad).toThrow(/ORG_CAPS/);
    }
  });
});

describe('parseAllowList', () => {
  it('reads refsExclude', () => {
    expect(parseAllowList('{"acme":[{"repository":"acme/app","refs":["v*"],"refsExclude":["v*-*"]}]}')).toEqual({
      acme: [{ repository: 'acme/app', refs: ['v*'], refsExclude: ['v*-*'] }],
    });
  });

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
    ['empty refsExclude', '{"acme":[{"repository":"acme/app","refsExclude":[]}]}'],
    ['a non-string refsExclude', '{"acme":[{"repository":"acme/app","refsExclude":[1]}]}'],
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
