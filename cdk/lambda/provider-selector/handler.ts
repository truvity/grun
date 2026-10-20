// cdk-github-runners calls this synchronously for every queued job. It
// (1) routes the job to the provider of the right shape by label and
// (2) refuses the job when the cluster already runs the configured maximum
// number of tasks, and records that as a metric the stack alarms on.
import { ECSClient, ListTasksCommand } from '@aws-sdk/client-ecs';

export interface SelectorInput {
  payload: { workflow_job?: { labels?: string[] }; repository?: { full_name?: string }; organization?: { login?: string } };
  /** provider construct path -> labels */
  providers: Record<string, string[]>;
  defaultProvider?: string;
  defaultLabels?: string[];
}

export interface SelectorResult {
  provider?: string;
  labels?: string[];
}

export interface SelectorConfig {
  clusterArn: string;
  maxConcurrentTasks: number;
  onExceed: 'skip' | 'defer';
  /** Shape labels from smallest to largest. */
  shapeLabels: string[];
  stackName: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SelectorConfig {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  return {
    clusterArn: need('CLUSTER_ARN'),
    maxConcurrentTasks: Number(need('MAX_CONCURRENT_TASKS')),
    onExceed: need('ON_EXCEED') === 'defer' ? 'defer' : 'skip',
    shapeLabels: need('SHAPE_LABELS').split(','),
    stackName: need('STACK_NAME'),
  };
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
