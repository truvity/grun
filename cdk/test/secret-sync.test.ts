import { GetSecretValueCommand, PutSecretValueCommand, ResourceNotFoundException, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncConfig, desiredSecrets, parseApp, sync } from '../lambda/secret-sync/handler';

const KEY = '-----BEGIN RSA PRIVATE KEY-----\nTOPSECRETKEYMATERIAL\n-----END RSA PRIVATE KEY-----\n';
const doc = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ app_id: 4242, installation_id: 7, private_key: KEY, webhook_secret: 'whsec-TOPSECRET', ...over });

const config: SyncConfig = {
  readerRoleArn: 'arn:partition:iam::account-id:role/reader',
  ssmRegion: 'eu-central-1',
  targets: [
    { org: 'acme', parameter: '/p/acme', githubSecretId: 'sm-acme-gh', privateKeySecretId: 'sm-acme-key', webhookSecretId: 'sm-acme-wh', runnerLevel: 'org' },
    { org: 'widgets', parameter: '/p/widgets', githubSecretId: 'sm-w-gh', privateKeySecretId: 'sm-w-key', webhookSecretId: 'sm-w-wh', runnerLevel: 'org' },
  ],
};

const sts = mockClient(STSClient);
const ssm = mockClient(SSMClient);
const sm = mockClient(SecretsManagerClient);

/** An in-memory Secrets Manager. */
function store(initial: Record<string, string> = {}) {
  const values = { ...initial };
  sm.on(GetSecretValueCommand).callsFake(async (i) => {
    if (!(i.SecretId in values)) throw new ResourceNotFoundException({ message: 'nothing', $metadata: {} });
    return { SecretString: values[i.SecretId] };
  });
  sm.on(PutSecretValueCommand).callsFake(async (i) => {
    values[i.SecretId] = i.SecretString;
    return {};
  });
  return values;
}

let logged: string[];
beforeEach(() => {
  sts.reset();
  ssm.reset();
  sm.reset();
  sts.on(AssumeRoleCommand).resolves({ Credentials: { AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: 'TK' } as never });
  ssm.on(GetParameterCommand, { Name: '/p/acme' }).resolves({ Parameter: { Value: doc() } });
  ssm.on(GetParameterCommand, { Name: '/p/widgets' }).resolves({ Parameter: { Value: doc({ app_id: '99', webhook_secret: 'whsec-OTHER' }) } });
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => void logged.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => void logged.push(a.join(' ')));
});
afterEach(() => vi.restoreAllMocks());

describe('parseApp', () => {
  it('reads the github/v1 fields', () => {
    expect(parseApp(doc())).toEqual({ appId: 4242, privateKey: KEY, webhookSecret: 'whsec-TOPSECRET' });
  });

  it('takes an app id written as a string', () => {
    expect(parseApp(doc({ app_id: '17' })).appId).toBe(17);
  });

  it.each([
    ['app_id', { app_id: 'abc' }],
    ['app_id', { app_id: undefined }],
    ['private_key', { private_key: 'nope' }],
    ['webhook_secret', { webhook_secret: '' }],
  ])('names the field when %s is wrong, and nothing else', (field, over) => {
    expect(() => parseApp(doc(over))).toThrow(field);
    try {
      parseApp(doc(over));
    } catch (e) {
      expect((e as Error).message).not.toContain('TOPSECRET');
    }
  });

  it('refuses something that is not JSON without echoing it', () => {
    expect(() => parseApp('whsec-TOPSECRET')).toThrow('not JSON');
  });
});

describe('desiredSecrets', () => {
  it('writes what cdk-github-runners reads', () => {
    const d = desiredSecrets({ appId: 4242, privateKey: KEY, webhookSecret: 'w' }, 'org');
    expect(JSON.parse(d.github)).toEqual({ domain: 'github.com', appId: 4242, personalAuthToken: '', runnerLevel: 'org' });
    expect(d.privateKey).toBe(KEY);
    expect(JSON.parse(d.webhook)).toEqual({ webhookSecret: 'w' });
  });
});

describe('sync', () => {
  it('assumes the reader role and reads with it', async () => {
    store();
    await sync(config);
    expect(sts.commandCalls(AssumeRoleCommand)[0].args[0].input.RoleArn).toBe(config.readerRoleArn);
    expect(ssm.commandCalls(GetParameterCommand)[0].args[0].input.WithDecryption).toBe(true);
  });

  it('fills the three secrets of every organisation on the first run', async () => {
    const values = store({ 'sm-acme-gh': '{"domain":"github.com","appId":"","personalAuthToken":"","dummy":"x"}', 'sm-acme-wh': '{"webhookSecret":"generated"}' });
    const out = await sync(config);
    expect(out.map((r) => [r.org, r.github, r.privateKey, r.webhook])).toEqual([
      ['acme', 'updated', 'updated', 'updated'],
      ['widgets', 'updated', 'updated', 'updated'],
    ]);
    expect(JSON.parse(values['sm-acme-gh']).appId).toBe(4242);
    expect(values['sm-acme-key']).toBe(KEY);
    expect(JSON.parse(values['sm-acme-wh'])).toEqual({ webhookSecret: 'whsec-TOPSECRET' });
    expect(JSON.parse(values['sm-w-gh']).appId).toBe(99);
    expect(JSON.parse(values['sm-w-wh'])).toEqual({ webhookSecret: 'whsec-OTHER' });
  });

  it('writes nothing when nothing changed', async () => {
    store();
    await sync(config);
    sm.resetHistory();
    const out = await sync(config);
    expect(out.every((r) => r.github === 'unchanged' && r.privateKey === 'unchanged' && r.webhook === 'unchanged')).toBe(true);
    expect(sm.commandCalls(PutSecretValueCommand)).toHaveLength(0);
  });

  it('writes only the secret that changed when the webhook secret rotates', async () => {
    store();
    await sync(config);
    sm.resetHistory();
    ssm.on(GetParameterCommand, { Name: '/p/acme' }).resolves({ Parameter: { Value: doc({ webhook_secret: 'whsec-ROTATED' }) } });
    const out = await sync(config);
    expect(out[0]).toMatchObject({ org: 'acme', github: 'unchanged', privateKey: 'unchanged', webhook: 'updated' });
    const puts = sm.commandCalls(PutSecretValueCommand);
    expect(puts).toHaveLength(1);
    expect(puts[0].args[0].input.SecretId).toBe('sm-acme-wh');
  });

  it('treats a secret with no current version as empty', async () => {
    store();
    const out = await sync(config);
    expect(out[0].github).toBe('updated');
  });

  it('never logs a value', async () => {
    store();
    await sync(config);
    ssm.on(GetParameterCommand, { Name: '/p/widgets' }).resolves({ Parameter: { Value: doc({ private_key: 'broken TOPSECRET' }) } });
    await expect(sync(config)).rejects.toThrow('widgets');
    const all = logged.join('\n');
    for (const value of ['TOPSECRET', 'whsec', 'KEYMATERIAL', 'PRIVATE KEY', 'OTHER', '4242']) {
      expect(all, value).not.toContain(value);
    }
    expect(all).toContain('acme');
  });

  it('carries on with the other organisations when one fails, then fails the run', async () => {
    const values = store();
    ssm.on(GetParameterCommand, { Name: '/p/acme' }).rejects(new Error('boom'));
    await expect(sync(config)).rejects.toThrow('sync failed for: acme');
    expect(values['sm-w-key']).toBe(KEY);
    expect(values['sm-acme-key']).toBeUndefined();
  });

  it('fails when the reader role gives no credentials', async () => {
    store();
    sts.on(AssumeRoleCommand).resolves({});
    await expect(sync(config)).rejects.toThrow('no credentials');
  });
});
