// grun-agent: what one runner task measures and reports about its job.
//
// The runner image's job hooks run it (agent/job-started.sh, agent/job-completed.sh)
// with the runner's own bundled Node, so it needs nothing from the image beyond the
// GitHub runner. It is fail-open throughout: nothing here may fail, block or slow a
// job, and every error ends in its own log file (<state dir>/agent.log) only.
//
//   daemon   started detached by the job-started hook. Every few seconds it reads the
//            ECS task metadata endpoint's task stats and keeps the job's peaks (memory
//            and CPU of the whole task). Every half minute it reads what the runner
//            appended to its diagnostic logs (_diag/Runner_*.log, Worker_*.log) and
//            keeps the warning, error and critical records. With telemetry configured
//            it ships those as OTLP logs, and at the end the job's peaks as OTLP
//            metrics and one log event, authenticated by an access token it trades
//            for the task role's web identity token (RFC 8693).
//   finish   run by the job-completed hook: stops the daemon, prints the peaks as a
//            `::notice::` line (and to the job summary), waits a bounded time for the
//            last export.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GetWebIdentityTokenCommand, STSClient } from '@aws-sdk/client-sts';

// ---- settings, all from the environment the runner hands the hooks

export interface Settings {
  stateDir: string;
  diagDir: string;
  sampleMs: number;
  scanMs: number;
  flushMs: number;
  metadataUri?: string;
  tier: string;
  org: string;
  size: string;
  region?: string;
  telemetry?: { endpoint: string; issuer: string; stsAudience: string; otlpAudience: string };
}

export function settings(env: NodeJS.ProcessEnv): Settings {
  const n = (v: string | undefined, d: number) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? x : d;
  };
  const endpoint = (env.GRUN_OTLP_ENDPOINT ?? '').replace(/\/+$/, '');
  const issuer = (env.GRUN_OTLP_ISSUER ?? '').replace(/\/+$/, '');
  return {
    // In the runner user's home, outside the job's workspace, not in a shared temp dir.
    stateDir: env.GRUN_AGENT_DIR || path.join(env.HOME || '/home/runner', '.grun-agent'),
    diagDir: env.GRUN_DIAG_DIR || '/home/runner/_diag',
    sampleMs: n(env.GRUN_SAMPLE_SECONDS, 5) * 1000,
    scanMs: 30_000,
    flushMs: 60_000,
    metadataUri: env.ECS_CONTAINER_METADATA_URI_V4 || undefined,
    tier: env.GRUN_TIER ?? '',
    org: env.GRUN_ORG ?? env.GITHUB_REPOSITORY_OWNER ?? '',
    size: env.GRUN_SIZE ?? '',
    region: env.GRUN_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION || undefined,
    telemetry:
      endpoint && issuer
        ? {
            endpoint,
            issuer,
            stsAudience: env.GRUN_OTLP_STS_AUDIENCE || issuer,
            otlpAudience: env.GRUN_OTLP_AUDIENCE || 'otlp',
          }
        : undefined,
  };
}

export interface Job {
  repo: string;
  workflow: string;
  job: string;
  runId: string;
  runAttempt: string;
  runner: string;
}

export function jobOf(env: NodeJS.ProcessEnv): Job {
  return {
    repo: env.GITHUB_REPOSITORY ?? '',
    workflow: env.GITHUB_WORKFLOW ?? '',
    job: env.GITHUB_JOB ?? '',
    runId: env.GITHUB_RUN_ID ?? '',
    runAttempt: env.GITHUB_RUN_ATTEMPT ?? '',
    runner: env.RUNNER_NAME ?? '',
  };
}

// ---- task stats

export interface Sample {
  /** Bytes in use by every container of the task, page cache included. */
  usage: number;
  /** usage less the inactive page cache: what the kernel cannot simply drop. */
  workingSet: number;
  /** The cgroup's own high-water mark of usage, where it reports one (cgroup v1). */
  maxUsage: number;
  /** CPU time of every container so far, nanoseconds. */
  cpuNs: number;
  /**
   * When the stats were read (the newest container's `read`). The endpoint serves
   * cached readings, so CPU rates are measured against this, not the poll's clock.
   */
  readMs?: number;
}

/** Sums the docker-style stats of `<metadata>/task/stats` over the task's containers. */
export function parseStats(stats: unknown): Sample | undefined {
  if (!stats || typeof stats !== 'object') return undefined;
  const out: Sample = { usage: 0, workingSet: 0, maxUsage: 0, cpuNs: 0 };
  let seen = false;
  for (const c of Object.values(stats as Record<string, any>)) {
    if (!c || typeof c !== 'object') continue;
    const m = c.memory_stats ?? {};
    const usage = Number(m.usage);
    if (Number.isFinite(usage) && usage > 0) {
      seen = true;
      const s = m.stats ?? {};
      const inactive = Number(s.total_inactive_file ?? s.inactive_file ?? 0) || 0;
      out.usage += usage;
      out.workingSet += inactive < usage ? usage - inactive : usage;
      const max = Number(m.max_usage);
      if (Number.isFinite(max) && max > 0) out.maxUsage += max;
    }
    const cpu = Number(c.cpu_stats?.cpu_usage?.total_usage);
    if (Number.isFinite(cpu) && cpu > 0) {
      seen = true;
      out.cpuNs += cpu;
    }
    const read = typeof c.read === 'string' ? Date.parse(c.read) : NaN;
    // A container that has not been read reports the zero time (0001-01-01).
    if (Number.isFinite(read) && read > Date.UTC(2000, 0, 1)) out.readMs = Math.max(out.readMs ?? 0, read);
  }
  return seen ? out : undefined;
}

export class Peaks {
  samples = 0;
  usage = 0;
  workingSet = 0;
  maxUsage = 0;
  cpuPeak = 0;
  private first?: { t: number; cpuNs: number };
  private last?: { t: number; cpuNs: number };

  add(s: Sample, tMs: number): void {
    this.samples++;
    this.usage = Math.max(this.usage, s.usage);
    this.workingSet = Math.max(this.workingSet, s.workingSet);
    this.maxUsage = Math.max(this.maxUsage, s.maxUsage);
    // The reading's own time where it has one: the same cached reading twice adds
    // nothing, and a reading late by a poll does not show as a burst.
    const t = s.readMs ?? tMs;
    if (this.last && t <= this.last.t) return;
    if (this.last && s.cpuNs >= this.last.cpuNs) {
      const cores = (s.cpuNs - this.last.cpuNs) / ((t - this.last.t) * 1e6);
      this.cpuPeak = Math.max(this.cpuPeak, cores);
    }
    if (!this.first) this.first = { t, cpuNs: s.cpuNs };
    this.last = { t, cpuNs: s.cpuNs };
  }

  /** Average cores between the first and the last sample. */
  cpuAverage(): number {
    if (!this.first || !this.last || this.last.t <= this.first.t) return 0;
    return (this.last.cpuNs - this.first.cpuNs) / ((this.last.t - this.first.t) * 1e6);
  }
}

// ---- the runner's diagnostic logs

export interface DiagRecord {
  timeMs: number;
  level: 'WARN' | 'ERR' | 'CRIT';
  source: string;
  process: string;
  file: string;
  message: string;
}

// actions/runner HostTraceListener: `[{DateTime.UtcNow:u} {type} {source}] {message}`,
// type one of CRIT, "ERR ", WARN, INFO, VERB. A multi-line message continues on lines
// without the header.
const HEADER = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\dZ) (CRIT|ERR|WARN|INFO|VERB|\w+) +([^\]]*)\] ?(.*)$/;
const KEEP = new Set(['WARN', 'ERR', 'CRIT']);
const MAX_LINES = 40;

// Records the runner writes at ERR or WARN on every healthy job. The broker's
// websocket ping "fails" with 101 Switching Protocols, which is the upgrade succeeding.
const BENIGN: RegExp[] = [/^GET request to wss:\/\/\S+\/ping\.sock failed\. HTTP Status: SwitchingProtocols$/];

/** A record that says nothing about a misbehaving runner. */
export function benign(r: Pick<DiagRecord, 'message'>): boolean {
  return BENIGN.some((re) => re.test(r.message));
}
const MAX_MESSAGE = 8192;

/** Reads what the runner appended to its diagnostic logs since the last scan. */
export class DiagTail {
  private offsets = new Map<string, number>();
  private partial = new Map<string, string>();
  private open = new Map<string, DiagRecord | undefined>();

  constructor(private readonly dir: string) {}

  scan(): DiagRecord[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((f) => /^(Runner|Worker)_.*\.log$/.test(f)).sort();
    } catch {
      return [];
    }
    const out: DiagRecord[] = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      const from = this.offsets.get(name) ?? 0;
      let buf: Buffer;
      try {
        // One descriptor for the size and the read: the file only grows.
        const fd = fs.openSync(file, 'r');
        try {
          const size = fs.fstatSync(fd).size;
          if (size <= from) continue;
          buf = Buffer.alloc(size - from);
          buf = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, from));
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        continue;
      }
      this.offsets.set(name, from + buf.length);
      const text = (this.partial.get(name) ?? '') + buf.toString('utf8');
      const lines = text.split(/\r?\n/);
      this.partial.set(name, lines.pop() ?? '');
      out.push(...this.lines(name, lines));
    }
    return out;
  }

  /** The records still open at the end (their continuation lines may be complete). */
  close(): DiagRecord[] {
    const out: DiagRecord[] = [];
    for (const [name, rest] of this.partial) if (rest) out.push(...this.lines(name, [rest]));
    this.partial.clear();
    for (const r of this.open.values()) if (r) out.push(r);
    this.open.clear();
    return out;
  }

  private lines(name: string, lines: string[]): DiagRecord[] {
    const out: DiagRecord[] = [];
    const process = name.startsWith('Worker_') ? 'Worker' : 'Runner';
    let cur = this.open.get(name);
    let count = 0;
    for (const line of lines) {
      const m = HEADER.exec(line);
      if (m) {
        if (cur) out.push(cur);
        cur = undefined;
        count = 0;
        if (KEEP.has(m[2])) {
          cur = {
            timeMs: Date.parse(m[1].replace(' ', 'T')),
            level: m[2] as DiagRecord['level'],
            source: m[3].trim(),
            process,
            file: name,
            message: m[4].slice(0, MAX_MESSAGE),
          };
        }
      } else if (cur && count < MAX_LINES && cur.message.length < MAX_MESSAGE) {
        cur.message = `${cur.message}\n${line}`.slice(0, MAX_MESSAGE);
        count++;
      }
    }
    // A record stays open until the next header: its stack trace may still come.
    this.open.set(name, cur);
    return out;
  }
}

// ---- OTLP/HTTP JSON

type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
export interface KeyValue {
  key: string;
  value: AnyValue;
}

export function kv(key: string, value: string | number | boolean): KeyValue {
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { key, value: { intValue: String(value) } } : { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: value } };
}

const SEVERITY: Record<string, number> = { INFO: 9, WARN: 13, ERR: 17, CRIT: 21 };

/** The resource every signal of the task carries. */
export function resourceOf(s: Settings, job: Job, taskId: string): KeyValue[] {
  const attrs: [string, string][] = [
    ['service.name', 'grun'],
    ['tier', s.tier],
    ['org', s.org],
    ['size', s.size],
    ['repo', job.repo],
    ['workflow', job.workflow],
    ['job', job.job],
    ['run_id', job.runId],
    ['run_attempt', job.runAttempt],
    ['runner', job.runner],
    ['task_id', taskId],
  ];
  return attrs.filter(([, v]) => v !== '').map(([k, v]) => kv(k, v));
}

export function logsBody(resource: KeyValue[], records: { timeMs: number; severity: string; body: string; attributes: KeyValue[] }[]) {
  const now = `${Date.now()}000000`;
  return {
    resourceLogs: [
      {
        resource: { attributes: resource },
        scopeLogs: [
          {
            scope: { name: 'grun-agent' },
            logRecords: records.map((r) => ({
              timeUnixNano: `${Number.isFinite(r.timeMs) ? r.timeMs : Date.now()}000000`,
              observedTimeUnixNano: now,
              severityNumber: SEVERITY[r.severity] ?? 9,
              severityText: r.severity === 'ERR' ? 'ERROR' : r.severity === 'CRIT' ? 'FATAL' : r.severity,
              body: { stringValue: r.body },
              attributes: r.attributes,
            })),
          },
        ],
      },
    ],
  };
}

export function diagLogRecord(r: DiagRecord) {
  return {
    timeMs: r.timeMs,
    severity: r.level,
    body: r.message,
    attributes: [kv('source', r.source), kv('process', r.process), kv('log.file.name', r.file)],
  };
}

export interface Summary {
  tier: string;
  org: string;
  size: string;
  job: Job;
  taskId: string;
  taskVcpu: number;
  taskMemoryMiB: number;
  durationS: number;
  samples: number;
  peakWorkingSetMiB: number;
  peakUsageMiB: number;
  maxUsageMiB: number;
  peakCpuCores: number;
  avgCpuCores: number;
}

const MIB = 1024 * 1024;
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

export function summarise(s: Settings, job: Job, taskId: string, limits: { cpu: number; memoryMiB: number }, peaks: Peaks, startedMs: number, endMs: number): Summary {
  return {
    tier: s.tier,
    org: s.org,
    size: s.size,
    job,
    taskId,
    taskVcpu: limits.cpu,
    taskMemoryMiB: limits.memoryMiB,
    durationS: Math.round((endMs - startedMs) / 1000),
    samples: peaks.samples,
    peakWorkingSetMiB: Math.round(peaks.workingSet / MIB),
    peakUsageMiB: Math.round(peaks.usage / MIB),
    maxUsageMiB: Math.round(peaks.maxUsage / MIB),
    peakCpuCores: round(peaks.cpuPeak),
    avgCpuCores: round(peaks.cpuAverage()),
  };
}

/** The `::notice::` line of the job log. */
export function noticeLine(x: Summary): string {
  const pct = (a: number, b: number) => (b > 0 ? ` (${Math.round((100 * a) / b)}%)` : '');
  const shape = x.taskVcpu ? `${x.size || 'task'} ${x.taskVcpu} vCPU / ${x.taskMemoryMiB} MiB` : x.size || 'task';
  return (
    `::notice title=grun peak::${shape}: memory ${x.peakWorkingSetMiB} MiB peak${pct(x.peakWorkingSetMiB, x.taskMemoryMiB)}` +
    ` (${x.peakUsageMiB} MiB with page cache), CPU ${x.peakCpuCores} cores peak${pct(x.peakCpuCores, x.taskVcpu)}` +
    `, ${x.avgCpuCores} average, ${x.durationS} s, ${x.samples} samples`
  );
}

export function eventRecord(x: Summary) {
  return {
    timeMs: Date.now(),
    severity: 'INFO',
    body: 'grun job peak',
    attributes: [
      kv('event', 'grun.job.peak'),
      kv('task_vcpu', x.taskVcpu),
      kv('task_memory_mib', x.taskMemoryMiB),
      kv('duration_s', x.durationS),
      kv('samples', x.samples),
      kv('peak_memory_mib', x.peakWorkingSetMiB),
      kv('peak_memory_usage_mib', x.peakUsageMiB),
      kv('max_usage_mib', x.maxUsageMiB),
      kv('peak_cpu_cores', x.peakCpuCores),
      kv('avg_cpu_cores', x.avgCpuCores),
    ],
  };
}

export function metricsBody(x: Summary) {
  const t = `${Date.now()}000000`;
  // Low-cardinality labels only: the run and the runner are in the log event.
  const labels = [kv('tier', x.tier), kv('org', x.org), kv('size', x.size), kv('repo', x.job.repo), kv('workflow', x.job.workflow), kv('workflow_job', x.job.job)].filter(
    (a) => 'stringValue' in a.value && a.value.stringValue !== '',
  );
  const gauge = (name: string, description: string, value: number) => ({
    name,
    description,
    gauge: { dataPoints: [{ timeUnixNano: t, asDouble: value, attributes: labels }] },
  });
  return {
    resourceMetrics: [
      {
        resource: { attributes: [kv('service.name', 'grun')] },
        scopeMetrics: [
          {
            scope: { name: 'grun-agent' },
            metrics: [
              gauge('grun_job_memory_peak_bytes', 'Peak memory of the job\'s task less inactive page cache', x.peakWorkingSetMiB * MIB),
              gauge('grun_job_memory_usage_peak_bytes', 'Peak memory of the job\'s task with page cache', x.peakUsageMiB * MIB),
              gauge('grun_job_cpu_peak_cores', 'Peak CPU of the job\'s task over one sampling interval', x.peakCpuCores),
              gauge('grun_job_cpu_average_cores', 'Average CPU of the job\'s task', x.avgCpuCores),
              gauge('grun_job_duration_seconds', 'Duration of the job, from the started to the completed hook', x.durationS),
              gauge('grun_task_vcpu', 'vCPU of the job\'s task', x.taskVcpu),
              gauge('grun_task_memory_bytes', 'Memory of the job\'s task', x.taskMemoryMiB * MIB),
            ],
          },
        ],
      },
    ],
  };
}

// ---- the access token: the task role's web identity token, exchanged (RFC 8693)

export class Tokens {
  private token?: { value: string; expiresMs: number };
  private sts?: STSClient;

  constructor(
    private readonly t: NonNullable<Settings['telemetry']>,
    private readonly region: string | undefined,
    private readonly log: (m: string) => void,
  ) {}

  invalidate(): void {
    this.token = undefined;
  }

  async get(): Promise<string> {
    if (this.token && this.token.expiresMs - Date.now() > 60_000) return this.token.value;
    this.sts ??= new STSClient({ region: this.region });
    const id = await this.sts.send(
      new GetWebIdentityTokenCommand({ Audience: [this.t.stsAudience], SigningAlgorithm: 'ES384', DurationSeconds: 300 }),
    );
    const subject = id.WebIdentityToken;
    if (!subject) throw new Error('sts:GetWebIdentityToken returned no token');
    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: subject,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      audience: this.t.otlpAudience,
      scope: 'openid',
    });
    const res = await fetch(`${this.t.issuer}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // A public client: its id as HTTP Basic with an empty password, form-encoded first.
        Authorization: `Basic ${Buffer.from(`${encodeURIComponent(this.t.otlpAudience)}:`).toString('base64')}`,
      },
      body: form.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`token exchange: HTTP ${res.status}: ${text.slice(0, 300)}`);
    const body = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('token exchange: no access_token');
    this.token = { value: body.access_token, expiresMs: Date.now() + (body.expires_in ?? 900) * 1000 };
    this.log(`token: exchanged, expires in ${body.expires_in ?? '?'} s`);
    return this.token.value;
  }
}

export async function post(t: NonNullable<Settings['telemetry']>, tokens: Tokens, signal: 'logs' | 'metrics', body: unknown): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await tokens.get();
    const res = await fetch(`${t.endpoint}/v1/${signal}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      await res.arrayBuffer();
      return;
    }
    const text = (await res.text()).slice(0, 300);
    if (res.status === 401 && attempt === 0) {
      tokens.invalidate();
      continue;
    }
    throw new Error(`POST /v1/${signal}: HTTP ${res.status}: ${text}`);
  }
}

// ---- the processes

const MAX_RECORDS = 1000;
const BATCH = 200;

function files(s: Settings) {
  return {
    pid: path.join(s.stateDir, 'daemon.pid'),
    summary: path.join(s.stateDir, 'summary.json'),
    log: path.join(s.stateDir, 'agent.log'),
  };
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

export async function daemon(env: NodeJS.ProcessEnv): Promise<void> {
  const s = settings(env);
  const f = files(s);
  const log = (m: string) => {
    try {
      fs.appendFileSync(f.log, `${new Date().toISOString()} ${m}\n`);
    } catch {
      /* fail-open */
    }
  };
  fs.mkdirSync(s.stateDir, { recursive: true, mode: 0o700 });
  fs.rmSync(f.summary, { force: true });
  fs.writeFileSync(f.pid, String(process.pid));
  const job = jobOf(env);
  const started = Date.now();
  const peaks = new Peaks();
  const diag = new DiagTail(s.diagDir);
  const pending: DiagRecord[] = [];
  let dropped = 0;
  let limits = { cpu: 0, memoryMiB: 0 };
  let taskId = '';
  const tokens = s.telemetry ? new Tokens(s.telemetry, s.region, log) : undefined;

  if (s.metadataUri) {
    try {
      const task = await getJson(`${s.metadataUri}/task`);
      limits = { cpu: Number(task?.Limits?.CPU) || 0, memoryMiB: Number(task?.Limits?.Memory) || 0 };
      taskId = String(task?.TaskARN ?? '').split('/').pop() ?? '';
    } catch (e) {
      log(`task metadata: ${String(e)}`);
    }
  } else {
    log('no ECS_CONTAINER_METADATA_URI_V4: no samples');
  }
  const resource = resourceOf(s, job, taskId);
  // Fetch the first token early: the last export at job end then needs only the POSTs.
  tokens?.get().catch((e) => log(`token: ${String(e)}`));

  const sample = async () => {
    if (!s.metadataUri) return;
    try {
      const x = parseStats(await getJson(`${s.metadataUri}/task/stats`));
      if (x) peaks.add(x, Date.now());
    } catch (e) {
      log(`stats: ${String(e)}`);
    }
  };
  const scan = (records: DiagRecord[]) => {
    for (const r of records) {
      if (benign(r)) continue;
      if (pending.length >= MAX_RECORDS) dropped++;
      else pending.push(r);
    }
  };
  const flush = async (extra: ReturnType<typeof eventRecord>[] = []) => {
    if (!s.telemetry || !tokens) {
      pending.length = 0;
      return;
    }
    const records = [...pending.splice(0).map(diagLogRecord), ...extra];
    for (let i = 0; i < records.length; i += BATCH) {
      try {
        await post(s.telemetry, tokens, 'logs', logsBody(resource, records.slice(i, i + BATCH)));
      } catch (e) {
        log(`logs: ${String(e)}`);
        return;
      }
    }
  };

  await sample();
  let sampling = false;
  const sampler = setInterval(() => {
    if (sampling) return;
    sampling = true;
    void sample().finally(() => (sampling = false));
  }, s.sampleMs);
  const scanner = setInterval(() => scan(diag.scan()), s.scanMs);
  let flushing = false;
  const flusher = setInterval(() => {
    if (flushing || pending.length === 0) return;
    flushing = true;
    void flush().finally(() => (flushing = false));
  }, s.flushMs);

  let finishing = false;
  const finish = async () => {
    if (finishing) return;
    finishing = true;
    clearInterval(sampler);
    clearInterval(scanner);
    clearInterval(flusher);
    await sample();
    scan(diag.scan());
    scan(diag.close());
    const summary = summarise(s, job, taskId, limits, peaks, started, Date.now());
    fs.writeFileSync(`${f.summary}.tmp`, JSON.stringify(summary));
    fs.renameSync(`${f.summary}.tmp`, f.summary);
    if (dropped > 0) log(`diag: ${dropped} records over the cap of ${MAX_RECORDS} not sent`);
    if (s.telemetry && tokens) {
      const t = s.telemetry;
      await Promise.allSettled([
        flush([eventRecord(summary)]),
        post(t, tokens, 'metrics', metricsBody(summary)).catch((e) => log(`metrics: ${String(e)}`)),
      ]);
    }
    fs.rmSync(f.pid, { force: true });
    process.exit(0);
  };
  process.on('SIGTERM', () => void finish());
  process.on('SIGINT', () => void finish());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function finishCommand(env: NodeJS.ProcessEnv, out: (line: string) => void): Promise<void> {
  const s = settings(env);
  const f = files(s);
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(f.pid, 'utf8').trim());
  } catch {
    /* no daemon */
  }
  if (!pid || !alive(pid)) {
    out('grun peak: the sampler did not run for this job');
    return;
  }
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 20_000;
  let summary: Summary | undefined;
  while (Date.now() < deadline && !summary) {
    try {
      summary = JSON.parse(fs.readFileSync(f.summary, 'utf8')) as Summary;
    } catch {
      await sleep(200);
    }
  }
  if (summary) {
    out(noticeLine(summary));
    const file = env.GITHUB_STEP_SUMMARY;
    if (file) {
      try {
        fs.appendFileSync(file, `\n${noticeLine(summary).replace(/^::notice title=grun peak::/, '**grun peak** ')}\n`);
      } catch {
        /* not writable from a hook */
      }
    }
  } else {
    out('grun peak: the sampler did not answer');
  }
  // The last export: bounded, so the job is never held long.
  while (Date.now() < deadline && alive(pid)) await sleep(200);
}

async function main(argv: string[]): Promise<void> {
  const cmd = argv[2];
  if (cmd === 'daemon') return daemon(process.env);
  if (cmd === 'finish') return finishCommand(process.env, (l) => process.stdout.write(`${l}\n`));
  process.stderr.write('usage: grun-agent daemon|finish\n');
}

if (require.main === module) {
  main(process.argv).catch((e) => {
    process.stderr.write(`grun-agent: ${String(e)}\n`);
    // Fail-open: a hook never fails the job.
    process.exit(0);
  });
}
