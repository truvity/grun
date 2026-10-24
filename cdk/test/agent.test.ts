import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DiagTail,
  benign,
  Peaks,
  cgroupCpuNs,
  diskUsage,
  eventRecord,
  jobDisplayName,
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

  it('measures CPU against the readings\' own time: a cached reading polled twice is no burst', () => {
    const at = (iso: string, cpuNs: number) => parseStats({ a: { read: iso, memory_stats: { usage: 1 }, cpu_stats: { cpu_usage: { total_usage: cpuNs } } } })!;
    expect(at('0001-01-01T00:00:00Z', 1).readMs).toBeUndefined();
    const p = new Peaks();
    p.add(at('2026-10-23T22:00:00Z', 1e9), 0);
    // The poll ran 1 s later but the endpoint served the same reading; then a reading 20 s on.
    p.add(at('2026-10-23T22:00:00Z', 1e9), 1_000);
    p.add(at('2026-10-23T22:00:20Z', 61e9), 21_500); // 60 s of CPU in 20 s: 3 cores, not 60/20.5 or 60/1
    expect(p.cpuPeak).toBeCloseTo(3);
    expect(p.cpuAverage()).toBeCloseTo(3);
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

  it('drops the broker ping that every healthy job logs as an error, nothing else', () => {
    expect(benign({ message: 'GET request to wss://broker.actions.githubusercontent.com/_ws/ping.sock failed. HTTP Status: SwitchingProtocols' })).toBe(true);
    expect(benign({ message: 'GET request to wss://broker.actions.githubusercontent.com/_ws/ping.sock failed. HTTP Status: Unauthorized' })).toBe(false);
    expect(benign({ message: 'boom' })).toBe(false);
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
      '::notice title=grun peak::fg-medium 2 vCPU / 4096 MiB: memory 1000 MiB peak (24%) (1100 MiB with page cache), CPU 1.5 cores peak (75%), 1.5 average, 125 s, 2 samples, 0 s at the CPU cap (>= 95%), disk 0 MiB used at peak (0 at start, 0 MiB volume)',
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
      'grun_job_cpu_at_cap_seconds',
      'grun_job_disk_peak_bytes',
    ]);
    const labels = m[0].gauge.dataPoints[0].attributes.map((a) => a.key);
    expect(labels).toEqual(['tier', 'org', 'size', 'repo', 'workflow', 'workflow_job']);
    expect(m[0].gauge.dataPoints[0].asDouble).toBe(1000 * MIB);
  });
});

describe('grun-agent: time at the CPU cap, disk, the job name', () => {
  const at = (iso: string, cpuNs: number) =>
    parseStats({ a: { read: iso, memory_stats: { usage: 1 }, cpu_stats: { cpu_usage: { total_usage: cpuNs } } } })!;

  it('counts the seconds whose CPU rate reached 95% of the task\'s vCPU', () => {
    const p = new Peaks(2); // a 2 vCPU task: the cap is 1.9 cores
    p.add(at('2026-10-24T10:00:00Z', 0), 0);
    p.add(at('2026-10-24T10:00:05Z', 10e9), 0); // 2.0 cores for 5 s: at the cap
    p.add(at('2026-10-24T10:00:10Z', 19.5e9), 0); // 1.9 cores: exactly 95%, at the cap
    p.add(at('2026-10-24T10:00:15Z', 24e9), 0); // 0.9 cores: not
    p.add(at('2026-10-24T10:00:25Z', 24e9), 0); // idle for 10 s
    expect(p.cpuAtCapS).toBe(10);
    expect(p.cpuMeasuredS).toBe(25);
    const x = summarise(settings({}), jobOf({}), 't', { cpu: 2, memoryMiB: 4096 }, p, 0, 25_000);
    expect(x).toMatchObject({ cpuAtCapS: 10, cpuMeasuredS: 25, cpuAtCapFraction: 0.4, cpuSource: 'task-stats' });
  });

  it('counts nothing at the cap when the task\'s vCPU is unknown, and a cached reading adds no time', () => {
    const p = new Peaks();
    p.add(at('2026-10-24T10:00:00Z', 0), 0);
    p.add(at('2026-10-24T10:00:00Z', 0), 1000);
    p.add(at('2026-10-24T10:00:05Z', 50e9), 0);
    expect(p.cpuAtCapS).toBe(0);
    expect(p.cpuMeasuredS).toBe(5);
  });

  it('falls back on the container\'s cgroup for a job too short for two distinct task readings', () => {
    const p = new Peaks(2);
    p.add(at('2026-10-24T10:00:00Z', 1e9), 0);
    p.add(at('2026-10-24T10:00:00Z', 1e9), 3000); // the same cached reading at the end of a 3 s job
    expect(p.cpuSource()).toBe('none');
    p.addCgroup(40e9, 1_000);
    p.addCgroup(44e9, 3_000); // 4 s of CPU in 2 s
    expect(p.cpuSource()).toBe('cgroup');
    expect(p.cpuAverage()).toBeCloseTo(2);
    expect(p.cpuPeakCores()).toBeCloseTo(2);
    const x = summarise(settings({}), jobOf({}), 't', { cpu: 2, memoryMiB: 4096 }, p, 0, 3000);
    expect(x).toMatchObject({ peakCpuCores: 2, avgCpuCores: 2, cpuSource: 'cgroup' });
  });

  it('keeps the task stats where they have a rate', () => {
    const p = new Peaks(4);
    p.add(at('2026-10-24T10:00:00Z', 0), 0);
    p.add(at('2026-10-24T10:00:05Z', 5e9), 0);
    p.addCgroup(0, 0);
    p.addCgroup(1e9, 5000);
    expect(p.cpuSource()).toBe('task-stats');
    expect(p.cpuAverage()).toBeCloseTo(1);
  });

  it('reads the CPU time of a cgroup v2 or v1 directory', () => {
    const v2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cg2-'));
    fs.writeFileSync(path.join(v2, 'cpu.stat'), 'usage_usec 1500000\nuser_usec 1\nsystem_usec 2\n');
    expect(cgroupCpuNs(v2)).toBe(1.5e9);
    const v1 = fs.mkdtempSync(path.join(os.tmpdir(), 'cg1-'));
    fs.mkdirSync(path.join(v1, 'cpuacct'));
    fs.writeFileSync(path.join(v1, 'cpuacct', 'cpuacct.usage'), '2500000000\n');
    expect(cgroupCpuNs(v1)).toBe(2.5e9);
    expect(cgroupCpuNs('/nonexistent/grun')).toBeUndefined();
  });

  it('keeps the first, the highest and the size of the used disk', () => {
    const p = new Peaks();
    p.addDisk(3000 * MIB, 50_000 * MIB);
    p.addDisk(9000 * MIB, 50_000 * MIB);
    p.addDisk(4000 * MIB, 50_000 * MIB);
    p.addDisk(-1, 0); // a bad reading changes nothing
    const x = summarise(settings({}), jobOf({}), 't', { cpu: 2, memoryMiB: 4096 }, p, 0, 1000);
    expect(x).toMatchObject({ peakDiskMiB: 9000, diskStartMiB: 3000, diskTotalMiB: 50_000 });
    const u = diskUsage(os.tmpdir());
    expect(u?.total).toBeGreaterThan(0);
    expect(u?.used).toBeLessThanOrEqual(u!.total);
    expect(diskUsage('/nonexistent/grun')).toBeUndefined();
  });

  it('reads the job\'s display name, matrix values included, from the newest Worker log', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'grun-diag-'));
    const message = JSON.stringify({ steps: [{ displayName: 'x' }], jobDisplayName: 'test (go, "1.27")', jobId: 'abc' }, null, 2);
    fs.writeFileSync(path.join(d, 'Worker_20261024-100000-utc.log'), `[2026-10-24 10:00:00Z INFO Worker] Job message:\n ${message}\n`);
    expect(jobDisplayName(d)).toBe('test (go, "1.27")');
    expect(jobDisplayName('/nonexistent/grun')).toBeUndefined();
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'grun-diag-'));
    fs.writeFileSync(path.join(empty, 'Worker_1.log'), '[2026-10-24 10:00:00Z INFO Worker] Worker started\n');
    expect(jobDisplayName(empty)).toBeUndefined();
  });

  it('adds the new fields to the event and keeps the old ones', () => {
    const p = new Peaks(2);
    p.add(at('2026-10-24T10:00:00Z', 0), 0);
    p.add(at('2026-10-24T10:00:10Z', 20e9), 0);
    p.addDisk(1000 * MIB, 20_000 * MIB);
    const x = summarise(settings({}), jobOf({}), 't', { cpu: 2, memoryMiB: 4096 }, p, 0, 10_000, 'recipes / ci-verify (a, b)');
    const ev = Object.fromEntries(eventRecord(x).attributes.map((a) => [a.key, Object.values(a.value)[0]]));
    expect(ev).toMatchObject({
      event: 'grun.job.peak',
      // whole numbers travel as OTLP intValue (a string)
      peak_cpu_cores: '2',
      avg_cpu_cores: '2',
      cpu_at_cap_s: '10',
      cpu_at_cap_fraction: '1',
      cpu_measured_s: '10',
      cpu_source: 'task-stats',
      peak_disk_mib: '1000',
      disk_start_mib: '1000',
      disk_total_mib: '20000',
      job_name: 'recipes / ci-verify (a, b)',
    });
    const without = Object.fromEntries(eventRecord(summarise(settings({}), jobOf({}), 't', { cpu: 2, memoryMiB: 4096 }, p, 0, 10_000)).attributes.map((a) => [a.key, 1]));
    expect(without).not.toHaveProperty('job_name');
  });
});

describe('grun-agent: the bundle', () => {
  it('is one CommonJS file that runs on the runner\'s Node', () => {
    const file = agentBundle();
    const code = fs.readFileSync(file, 'utf8');
    expect(code.length).toBeLessThan(2 * 1024 * 1024);
    // The SDK is inside (the image has no node_modules); only the optional signers it names in its own messages are not.
    expect(code).not.toMatch(/require\("@(aws-sdk\/client-sts|smithy\/[a-z-]+)"\)/);
    // Built once per process; the asset is hashed by content, so a rebuild with the same input changes nothing.
    expect(agentBundle()).toBe(file);
  });
});
