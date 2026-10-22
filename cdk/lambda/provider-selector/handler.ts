// cdk-github-runners calls this synchronously for every queued job. It
// (1) routes the job to the provider of the right shape by label and
// (2) refuses the job when the cluster already runs the configured maximum
// number of tasks, and records that as a metric the stack alarms on, and
// (3) before either, refuses a job the organisation's allow-list does not name
// (repository, and when listed workflow and ref), recorded as a metric only.
import { ECSClient, ListTasksCommand } from '@aws-sdk/client-ecs';

export interface SelectorInput {
  payload: {
    workflow_job?: { labels?: string[]; workflow_name?: string | null; head_branch?: string | null };
    repository?: { full_name?: string };
    organization?: { login?: string };
  };
  /** provider construct path -> labels */
  providers: Record<string, string[]>;
  defaultProvider?: string;
  defaultLabels?: string[];
}

export interface SelectorResult {
  provider?: string;
  labels?: string[];
}

/** One allowed repository of an organisation; workflows and refs, when present, narrow it. */
export interface AllowEntry {
  /** owner/name, compared case-insensitively. */
  repository: string;
  /** Workflow names, compared exactly (case-sensitive). */
  workflows?: string[];
  /** Globs over workflow_job.head_branch (a tag name for a tag push); `*` matches any characters, `/` included. */
  refs?: string[];
}

/**
 * Organisation login (lowercase) -> its allow-list. null: the organisation is
 * known and unrestricted. A login that is not a key is refused (fail closed).
 */
export type AllowList = Record<string, AllowEntry[] | null>;

export interface SelectorConfig {
  clusterArn: string;
  maxConcurrentTasks: number;
  onExceed: 'skip' | 'defer';
  /** Shape labels from smallest to largest. */
  shapeLabels: string[];
  stackName: string;
  /** Absent: no organisation has an allow-list and every job is considered. */
  allow?: AllowList;
}

/** Strict reader of the ALLOW_LIST variable: malformed JSON or a wrong shape throws. */
export function parseAllowList(text: string): AllowList {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`ALLOW_LIST is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('ALLOW_LIST must be a JSON object keyed by organisation');
  const strings = (v: unknown, what: string): string[] => {
    if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'string' || x === '')) {
      throw new Error(`ALLOW_LIST ${what} must be a non-empty list of non-empty strings`);
    }
    return v as string[];
  };
  const out: AllowList = {};
  for (const [org, entries] of Object.entries(raw)) {
    const key = org.toLowerCase();
    if (key in out) throw new Error(`ALLOW_LIST names organisation ${key} twice`);
    if (entries === null) {
      out[key] = null;
      continue;
    }
    if (!Array.isArray(entries) || entries.length === 0) throw new Error(`ALLOW_LIST ${org} must be null or a non-empty list`);
    out[key] = entries.map((e: unknown, i): AllowEntry => {
      const where = `${org}[${i}]`;
      if (typeof e !== 'object' || e === null || Array.isArray(e)) throw new Error(`ALLOW_LIST ${where} must be an object`);
      const o = e as Record<string, unknown>;
      for (const k of Object.keys(o)) {
        if (!['repository', 'workflows', 'refs'].includes(k)) throw new Error(`ALLOW_LIST ${where} has unknown key ${k}`);
      }
      if (typeof o.repository !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(o.repository)) {
        throw new Error(`ALLOW_LIST ${where}.repository must be owner/name`);
      }
      const entry: AllowEntry = { repository: o.repository };
      if (o.workflows !== undefined) entry.workflows = strings(o.workflows, `${where}.workflows`);
      if (o.refs !== undefined) entry.refs = strings(o.refs, `${where}.refs`);
      return entry;
    });
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SelectorConfig {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  const allow = env.ALLOW_LIST ? parseAllowList(env.ALLOW_LIST) : undefined;
  return {
    clusterArn: need('CLUSTER_ARN'),
    maxConcurrentTasks: Number(need('MAX_CONCURRENT_TASKS')),
    onExceed: need('ON_EXCEED') === 'defer' ? 'defer' : 'skip',
    shapeLabels: need('SHAPE_LABELS').split(','),
    stackName: need('STACK_NAME'),
    ...(allow ? { allow } : {}),
  };
}

/** A glob in which `*` matches any characters (`/` included) and nothing else is special. */
export function globMatches(glob: string, value: string): boolean {
  const re = glob.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${re}$`, 's').test(value);
}

/**
 * Whether the allow-list admits the job. With no list at all everything is
 * admitted. With a list, an organisation that is not in it is refused, one
 * marked unrestricted (null) is admitted, and otherwise the job's repository
 * must match an entry, and that entry's workflows and refs when it names them.
 */
export function allowed(payload: SelectorInput['payload'], allow: AllowList | undefined): boolean {
  if (!allow || Object.keys(allow).length === 0) return true;
  const org = payload.organization?.login?.toLowerCase();
  if (!org || !(org in allow)) return false;
  const entries = allow[org];
  if (entries === null) return true;
  const repository = payload.repository?.full_name?.toLowerCase();
  const workflow = payload.workflow_job?.workflow_name ?? undefined;
  const ref = payload.workflow_job?.head_branch ?? '';
  return entries.some(
    (e) =>
      e.repository.toLowerCase() === repository &&
      (!e.workflows || (workflow !== undefined && e.workflows.includes(workflow))) &&
      (!e.refs || e.refs.some((g) => globMatches(g, ref))),
  );
}

/**
 * The provider whose labels cover the job's shape label. A job naming two
 * shapes gets the larger one. A job that names none keeps cdk-github-runners'
 * default choice.
 */
export function route(input: SelectorInput, shapeLabels: string[]): SelectorResult {
  const jobLabels = (input.payload.workflow_job?.labels ?? []).map((l) => l.toLowerCase());
  const wanted = shapeLabels.filter((s) => jobLabels.includes(s)).pop();
  if (wanted) {
    const provider = Object.keys(input.providers)
      .sort()
      .find((p) => input.providers[p].map((l) => l.toLowerCase()).includes(wanted));
    if (provider) return { provider, labels: input.providers[provider] };
  }
  if (input.defaultProvider && input.defaultLabels) return { provider: input.defaultProvider, labels: input.defaultLabels };
  return {};
}

/** Tasks that are pending, provisioning or running in the cluster. */
export async function runningTasks(ecs: ECSClient, clusterArn: string, stopAfter: number): Promise<number> {
  let count = 0;
  let nextToken: string | undefined;
  do {
    const out = await ecs.send(new ListTasksCommand({ cluster: clusterArn, desiredStatus: 'RUNNING', nextToken }));
    count += out.taskArns?.length ?? 0;
    nextToken = out.nextToken;
  } while (nextToken && count < stopAfter);
  return count;
}

/** One line in CloudWatch embedded metric format; Logs turns it into a metric. */
function metric(name: string, stackName: string, extra: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: 'Grun', Dimensions: [['Stack']], Metrics: [{ Name: name, Unit: 'Count' }] }],
      },
      Stack: stackName,
      [name]: 1,
      ...extra,
    }),
  );
}

export async function select(input: SelectorInput, config: SelectorConfig, ecs: ECSClient = new ECSClient({})): Promise<SelectorResult> {
  // Before routing and capacity: a refused job spends neither.
  if (!allowed(input.payload, config.allow)) {
    metric('AllowRefused', config.stackName, {
      organization: input.payload.organization?.login,
      repository: input.payload.repository?.full_name,
      workflow: input.payload.workflow_job?.workflow_name,
      ref: input.payload.workflow_job?.head_branch,
    });
    return {};
  }
  const chosen = route(input, config.shapeLabels);
  if (!chosen.provider) return chosen; // nothing to start: no capacity is spent on it

  const running = await runningTasks(ecs, config.clusterArn, config.maxConcurrentTasks);
  if (running >= config.maxConcurrentTasks) {
    metric('CapRefused', config.stackName, {
      running,
      max: config.maxConcurrentTasks,
      action: config.onExceed,
      repository: input.payload.repository?.full_name,
    });
    if (config.onExceed === 'defer') {
      // A failed delivery is redelivered by cdk-github-runners for 30 minutes.
      throw new Error(`task cap reached (${running}/${config.maxConcurrentTasks}); deferring`);
    }
    return {};
  }
  return chosen;
}

export const handler = async (event: SelectorInput): Promise<SelectorResult> => select(event, loadConfig());
