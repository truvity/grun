// grun-agent, bundled for the runner image: one CommonJS file with its dependencies
// (the STS client), run by the GitHub runner's own Node. Built with esbuild at synth
// time, deterministically, into a content-addressed temp directory, so the image's
// component hash moves only when the agent's code or its locked dependencies do.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSync } from 'esbuild';

export const AGENT_DIR = path.join(__dirname, '..', 'agent');
export const AGENT_TARGET = '/opt/grun/grun-agent.js';
export const STARTED_HOOK = path.join(AGENT_DIR, 'job-started.sh');
export const COMPLETED_HOOK = path.join(AGENT_DIR, 'job-completed.sh');

let bundled: string | undefined;

/** The bundled agent as a file on disk. */
export function agentBundle(): string {
  if (bundled && fs.existsSync(bundled)) return bundled;
  const result = buildSync({
    entryPoints: [path.join(AGENT_DIR, 'grun-agent.ts')],
    bundle: true,
    platform: 'node',
    // The runner ships Node 20 and 24 (externals/node20, node24); the hook takes the newest.
    target: 'node20',
    format: 'cjs',
    minify: true,
    legalComments: 'none',
    write: false,
    logLevel: 'silent',
  });
  const code = result.outputFiles[0].contents;
  const hash = crypto.createHash('sha256').update(code).digest('hex').slice(0, 16);
  const dir = path.join(os.tmpdir(), `grun-agent-${hash}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'grun-agent.js');
  if (!fs.existsSync(file)) fs.writeFileSync(file, code);
  bundled = file;
  return file;
}
