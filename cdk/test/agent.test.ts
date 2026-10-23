import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DiagTail,
  Peaks,
  eventRecord,
  jobOf,
  kv,
  logsBody,
  metricsBody,
  noticeLine,
  parseStats,
  resourceOf,
  settings,
  summarise,
} from '../agent/grun-agent';
import { agentBundle } from '../lib/agent';

const MIB = 1024 * 1024;

describe('grun-agent: task stats', () => {
  const container = (usage: number, inactive: number, cpuNs: number, extra: Record<string, unknown> = {}) => ({
    memory_stats: { usage, stats: { total_inactive_file: inactive }, ...extra },
    cpu_stats: { cpu_usage: { total_usage: cpuNs } },
  });

  it('sums every container, less the inactive page cache, and skips a stopped one', () => {
    const s = parseStats({ a: container(900 * MIB, 100 * MIB, 5e9, { max_usage: 950 * MIB }), b: container(100 * MIB, 0, 1e9), c: null });
    expect(s).toEqual({ usage: 1000 * MIB, workingSet: 900 * MIB, maxUsage: 950 * MIB, cpuNs: 6e9 });
  });

  it('reads cgroup v2 names too', () => {
    const s = parseStats({ a: { memory_stats: { usage: 10 * MIB, stats: { inactive_file: 4 * MIB } }, cpu_stats: { cpu_usage: { total_usage: 1 } } } });
    expect(s?.workingSet).toBe(6 * MIB);
  });

  it('answers nothing for nothing', () => {
    expect(parseStats(undefined)).toBeUndefined();
    expect(parseStats({})).toBeUndefined();
    expect(parseStats({ a: null })).toBeUndefined();
  });

  it('keeps the peaks: memory as the highest sample, CPU as the busiest interval, and the average', () => {
    const p = new Peaks();
    p.add({ usage: 100, workingSet: 80, maxUsage: 0, cpuNs: 0 }, 0);
    p.add({ usage: 300, workingSet: 250, maxUsage: 0, cpuNs: 10e9 }, 5_000); // 2 cores
    p.add({ usage: 200, workingSet: 150, maxUsage: 0, cpuNs: 30e9 }, 10_000); // 4 cores
    p.add({ usage: 200, workingSet: 150, maxUsage: 0, cpuNs: 30e9 }, 20_000); // idle
    expect(p.samples).toBe(4);
    expect(p.usage).toBe(300);
    expect(p.workingSet).toBe(250);
    expect(p.cpuPeak).toBeCloseTo(4);
    expect(p.cpuAverage()).toBeCloseTo(1.5);
  });
});

describe('grun-agent: the runner diagnostic logs', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'grun-diag-'));

  it('keeps warnings, errors and critical records with their continuation lines, drops the rest', () => {
    const d = dir();
    fs.writeFileSync(
      path.join(d, 'Runner_20261023-120000-utc.log'),
      [
        '[2026-10-23 12:00:00Z INFO Runner] Listening for Jobs',
        '[2026-10-23 12:00:01Z WARN BrokerServer] slow answer',
        '[2026-10-23 12:00:02Z ERR  JobDispatcher] boom',
        'System.Exception: boom',
        '   at X.Y()',
        '[2026-10-23 12:00:03Z INFO Runner] fine',
        'an INFO continuation that is dropped',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(d, 'Worker_20261023-120001-utc.log'), '[2026-10-23 12:00:04Z CRIT Worker] died\n');
    fs.writeFileSync(path.join(d, 'other.txt'), '[2026-10-23 12:00:05Z ERR  X] not a runner log\n');
    const t = new DiagTail(d);
    const got = [...t.scan(), ...t.close()];
    expect(got.map((r) => [r.level, r.source, r.process, r.message])).toEqual([
      ['WARN', 'BrokerServer', 'Runner', 'slow answer'],
      ['ERR', 'JobDispatcher', 'Runner', 'boom\nSystem.Exception: boom\n   at X.Y()'],
      ['CRIT', 'Worker', 'Worker', 'died'],
    ]);
    expect(got[0].timeMs).toBe(Date.parse('2026-10-23T12:00:01Z'));
  });

  it('reads only what was appended, and finishes a line split between two scans', () => {
    const d = dir();
    const f = path.join(d, 'Runner_1.log');
    fs.writeFileSync(f, '[2026-10-23 12:00:01Z WARN A] one\n[2026-10-23 12:00:02Z WA');
    const t = new DiagTail(d);
    expect(t.scan()).toEqual([]); // `one` stays open: a stack trace may follow
    fs.appendFileSync(f, 'RN B] two\n[2026-10-23 12:00:03Z INFO C] three\n');
    expect(t.scan().map((r) => r.message)).toEqual(['one', 'two']);
    expect(t.scan()).toEqual([]);
    expect(t.close()).toEqual([]);
  });

  it('bounds a record', () => {
    const d = dir();
    const lines = ['[2026-10-23 12:00:01Z ERR  A] head', ...Array.from({ length: 100 }, (_, i) => `line ${i}`), ''];
    fs.writeFileSync(path.join(d, 'Runner_1.log'), lines.join('\n'));
    const t = new DiagTail(d);
    const [r] = [...t.scan(), ...t.close()];
    expect(r.message.split('\n')).toHaveLength(41);
  });

  it('is empty without the directory', () => {
    expect(new DiagTail('/nonexistent/grun').scan()).toEqual([]);
  });
});

describe('grun-agent: what it reports', () => {
  const env = {
    GRUN_TIER: 'devel',
    GRUN_ORG: 'acme',
    GRUN_SIZE: 'fg-medium',
    GITHUB_REPOSITORY: 'acme/app',
    GITHUB_WORKFLOW: 'CI',
    GITHUB_JOB: 'build',
    GITHUB_RUN_ID: '42',
    GITHUB_RUN_ATTEMPT: '1',
    RUNNER_NAME: 'r-1',
  };
  const s = settings(env);
  const job = jobOf(env);
  const peaks = new Peaks();
  peaks.add({ usage: 1100 * MIB, workingSet: 1000 * MIB, maxUsage: 0, cpuNs: 0 }, 0);
  peaks.add({ usage: 1100 * MIB, workingSet: 1000 * MIB, maxUsage: 0, cpuNs: 15e9 }, 10_000);
  const x = summarise(s, job, 'task-1', { cpu: 2, memoryMiB: 4096 }, peaks, 0, 125_000);

  it('sends nothing unless the endpoint and the issuer are both set', () => {
    expect(s.telemetry).toBeUndefined();
    expect(settings({ GRUN_OTLP_ENDPOINT: 'https://o.example.test' }).telemetry).toBeUndefined();
    expect(settings({ GRUN_OTLP_ENDPOINT: 'https://o.example.test/', GRUN_OTLP_ISSUER: 'https://i.example.test' }).telemetry).toEqual({
      endpoint: 'https://o.example.test',
      issuer: 'https://i.example.test',
      stsAudience: 'https://i.example.test',
      otlpAudience: 'otlp',
    });
    expect(s.sampleMs).toBe(5000);
  });

  it('prints one notice line with the shape, the peaks and the share of the task', () => {
    expect(noticeLine(x)).toBe(
      '::notice title=grun peak::fg-medium 2 vCPU / 4096 MiB: memory 1000 MiB peak (24%) (1100 MiB with page cache), CPU 1.5 cores peak (75%), 1.5 average, 125 s, 2 samples',
    );
  });

  it('labels the resource with the tier, organisation, size and the job', () => {
    const r = Object.fromEntries(resourceOf(s, job, 'task-1').map((a) => [a.key, (a.value as { stringValue: string }).stringValue]));
    expect(r).toEqual({
      'service.name': 'grun',
      tier: 'devel',
      org: 'acme',
      size: 'fg-medium',
      repo: 'acme/app',
      workflow: 'CI',
      job: 'build',
      run_id: '42',
      run_attempt: '1',
      runner: 'r-1',
      task_id: 'task-1',
    });
  });

  it('writes OTLP JSON logs with the runner levels mapped to OTLP severities', () => {
    const body = logsBody([kv('service.name', 'grun')], [
      { timeMs: 1000, severity: 'WARN', body: 'w', attributes: [] },
      { timeMs: 2000, severity: 'ERR', body: 'e', attributes: [] },
      { timeMs: 3000, severity: 'CRIT', body: 'c', attributes: [] },
      eventRecord(x),
    ]);
    const recs = body.resourceLogs[0].scopeLogs[0].logRecords;
    expect(recs.map((r) => [r.severityNumber, r.severityText])).toEqual([
      [13, 'WARN'],
      [17, 'ERROR'],
      [21, 'FATAL'],
      [9, 'INFO'],
    ]);
    expect(recs[0].timeUnixNano).toBe('1000000000');
    const ev = Object.fromEntries(recs[3].attributes.map((a) => [a.key, Object.values(a.value)[0]]));
    expect(ev).toMatchObject({ event: 'grun.job.peak', peak_memory_mib: '1000', peak_cpu_cores: 1.5, duration_s: '125', task_vcpu: '2' });
  });

  it('writes the peaks as gauges with low-cardinality labels only', () => {
    const m = metricsBody(x).resourceMetrics[0].scopeMetrics[0].metrics;
    expect(m.map((g) => g.name)).toEqual([
      'grun_job_memory_peak_bytes',
      'grun_job_memory_usage_peak_bytes',
      'grun_job_cpu_peak_cores',
      'grun_job_cpu_average_cores',
      'grun_job_duration_seconds',
      'grun_task_vcpu',
      'grun_task_memory_bytes',
    ]);
    const labels = m[0].gauge.dataPoints[0].attributes.map((a) => a.key);
    expect(labels).toEqual(['tier', 'org', 'size', 'repo', 'workflow', 'workflow_job']);
    expect(m[0].gauge.dataPoints[0].asDouble).toBe(1000 * MIB);
  });
});

describe('grun-agent: the bundle', () => {
  it('is one CommonJS file that runs on the runner\'s Node', () => {
    const file = agentBundle();
    const code = fs.readFileSync(file, 'utf8');
    expect(code.length).toBeLessThan(2 * 1024 * 1024);
    // The SDK is inside (the image has no node_modules); only the optional signers it names in its own messages are not.
    expect(code).not.toMatch(/require\("@(aws-sdk\/client-sts|smithy\/[a-z-]+)"\)/);
    // The same input gives the same file, so the image is not rebuilt for nothing.
    expect(agentBundle()).toBe(file);
  });
});
