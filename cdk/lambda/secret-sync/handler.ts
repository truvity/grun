// Copies each organisation's GitHub App from the account that holds it
// (SSM, written by sluis) into the Secrets Manager secrets cdk-github-runners
// reads. Runs on a schedule; writes only when the content differs.
//
// It never logs a value, a hash or a secret id of the App: only the
// organisation name and what was done.
import * as crypto from 'node:crypto';
import { GetSecretValueCommand, PutSecretValueCommand, ResourceNotFoundException, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';

export interface SyncTarget {
  org: string;
  /** SSM parameter in the sluis account: a github/v1 JSON. */
  parameter: string;
  githubSecretId: string;
  privateKeySecretId: string;
  webhookSecretId: string;
  /** 'org' for organisation-level registration. */
  runnerLevel: 'org' | 'repo';
}

export interface SyncConfig {
  readerRoleArn: string;
  ssmRegion: string;
  targets: SyncTarget[];
}

export interface GithubApp {
  appId: number | string;
  privateKey: string;
  webhookSecret: string;
}

export interface OrgResult {
  org: string;
  github: 'unchanged' | 'updated';
  privateKey: 'unchanged' | 'updated';
  webhook: 'unchanged' | 'updated';
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Reads the github/v1 document. Errors name the field, never its value. */
export function parseApp(raw: string): GithubApp {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('the parameter is not JSON');
  }
  const appId = doc.app_id;
  if (!(typeof appId === 'number' && Number.isFinite(appId)) && !(typeof appId === 'string' && /^[0-9]+$/.test(appId))) {
    throw new Error('app_id is missing or not a number');
  }
  const privateKey = doc.private_key;
  if (typeof privateKey !== 'string' || !privateKey.includes('PRIVATE KEY')) {
    throw new Error('private_key is missing or not a PEM private key');
  }
  const webhookSecret = doc.webhook_secret;
  if (typeof webhookSecret !== 'string' || webhookSecret.length === 0) {
    throw new Error('webhook_secret is missing or empty');
  }
  return { appId: typeof appId === 'string' ? Number(appId) : appId, privateKey, webhookSecret };
}

/** The three secret bodies in the shape cdk-github-runners reads, with a fixed key order. */
export function desiredSecrets(app: GithubApp, runnerLevel: 'org' | 'repo') {
  return {
    github: JSON.stringify({ domain: 'github.com', appId: app.appId, personalAuthToken: '', runnerLevel }),
    privateKey: app.privateKey,
    webhook: JSON.stringify({ webhookSecret: app.webhookSecret }),
  };
}

async function currentValue(sm: SecretsManagerClient, id: string): Promise<string | undefined> {
  try {
    const out = await sm.send(new GetSecretValueCommand({ SecretId: id }));
    return out.SecretString;
  } catch (e) {
    // A secret that has no current version yet counts as empty.
    if (e instanceof ResourceNotFoundException) return undefined;
    throw e;
  }
}

async function writeIfChanged(sm: SecretsManagerClient, id: string, desired: string): Promise<'unchanged' | 'updated'> {
  const current = await currentValue(sm, id);
  if (current !== undefined && sha256(current) === sha256(desired)) return 'unchanged';
  await sm.send(new PutSecretValueCommand({ SecretId: id, SecretString: desired }));
  return 'updated';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SyncConfig {
  const raw = env.SYNC_CONFIG;
  if (!raw) throw new Error('SYNC_CONFIG is not set');
  return JSON.parse(raw) as SyncConfig;
}

export async function sync(config: SyncConfig): Promise<OrgResult[]> {
  const sts = new STSClient({});
  const assumed = await sts.send(
    new AssumeRoleCommand({ RoleArn: config.readerRoleArn, RoleSessionName: 'grun-secret-sync', DurationSeconds: 900 }),
  );
  const c = assumed.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) throw new Error('the reader role returned no credentials');
  const ssm = new SSMClient({
    region: config.ssmRegion,
    credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken },
  });
  const sm = new SecretsManagerClient({});

  const results: OrgResult[] = [];
  const failures: string[] = [];
  for (const t of config.targets) {
    try {
      const param = await ssm.send(new GetParameterCommand({ Name: t.parameter, WithDecryption: true }));
      if (!param.Parameter?.Value) throw new Error('the parameter has no value');
      const want = desiredSecrets(parseApp(param.Parameter.Value), t.runnerLevel);
      const result: OrgResult = {
        org: t.org,
        github: await writeIfChanged(sm, t.githubSecretId, want.github),
        privateKey: await writeIfChanged(sm, t.privateKeySecretId, want.privateKey),
        webhook: await writeIfChanged(sm, t.webhookSecretId, want.webhook),
      };
      results.push(result);
      console.log(JSON.stringify({ msg: 'synced', ...result }));
    } catch (e) {
      // The error name and message come from the SDK or from parseApp, which
      // names fields only.
      const err = e as Error;
      failures.push(t.org);
      console.error(JSON.stringify({ msg: 'sync failed', org: t.org, error: err.name, detail: err.message }));
    }
  }
  if (failures.length > 0) throw new Error(`sync failed for: ${failures.join(', ')}`);
  return results;
}

export const handler = async (): Promise<OrgResult[]> => sync(loadConfig());
