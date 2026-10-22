import * as fs from 'node:fs';
import * as path from 'node:path';
import { Match } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { roleNameFor } from '../lib/iam';
import { Synth, definition, resources, synth } from './helpers';

let s: Synth;
beforeAll(() => {
  s = synth();
});

const text = (o: unknown) => JSON.stringify(o);

describe('bootstrap qualifier', () => {
  /** The asset manifest of the synthesised stack: where its assets go and who publishes them. */
  const manifest = (t: Synth): string => {
    const dir = t.app.synth().directory;
    return fs.readFileSync(path.join(dir, `${t.stack.stackName}.assets.json`), 'utf8');
  };

  it('deploys through the bootstrap of cdk.qualifier', () => {
    expect(s.config.cdk?.qualifier).toBe('grun');
    expect(s.json.Parameters.BootstrapVersion.Default).toBe('/cdk-bootstrap/grun/version');
    const assets = manifest(s);
    expect(assets).toContain('cdk-grun-assets-');
    expect(assets).toContain('cdk-grun-file-publishing-role-');
    expect(assets).not.toContain('hnb659fds');
    expect(text(s.json)).not.toContain('hnb659fds');
  });

  it('follows the configured qualifier', () => {
    const t = synth((c) => {
      c.cdk = { qualifier: 'other1' };
    });
    expect(t.json.Parameters.BootstrapVersion.Default).toBe('/cdk-bootstrap/other1/version');
    expect(manifest(t)).toContain('cdk-other1-assets-');
    expect(manifest(t)).not.toContain('cdk-grun-');
  });

  it("is CDK's default qualifier when the file sets none", () => {
    const t = synth((c) => {
      delete c.cdk;
    });
    expect(t.json.Parameters.BootstrapVersion.Default).toBe('/cdk-bootstrap/hnb659fds/version');
    expect(manifest(t)).toContain('cdk-hnb659fds-assets-');
  });
});

describe('identity', () => {
  it('names the stack grun-<env>', () => {
    expect(s.stack.stackName).toBe('grun-example');
  });

  it('names every role grun-<env>-..., within the 64 character limit, with no path', () => {
    const roles = resources(s.json, 'AWS::IAM::Role');
    expect(roles.length).toBeGreaterThan(20);
    for (const [id, r] of roles) {
      expect(r.Properties.RoleName, id).toMatch(/^grun-example-/);
      expect(r.Properties.RoleName.length, id).toBeLessThanOrEqual(64);
      expect(r.Properties.Path, id).toBeUndefined();
    }
  });

  it('puts the permissions boundary on every role', () => {
    for (const [id, r] of resources(s.json, 'AWS::IAM::Role')) {
      expect(text(r.Properties.PermissionsBoundary), id).toContain('policy/pb@tech-grun');
    }
  });

  it('takes the boundary name from the config', () => {
    const t = synth((c) => {
      c.iam = { permissionsBoundary: 'pb@other' };
    });
    for (const [id, r] of resources(t.json, 'AWS::IAM::Role')) {
      expect(text(r.Properties.PermissionsBoundary), id).toContain('policy/pb@other');
    }
  });

  it('creates no user and no policy outside a role', () => {
    expect(resources(s.json, 'AWS::IAM::User')).toHaveLength(0);
    expect(resources(s.json, 'AWS::IAM::ManagedPolicy')).toHaveLength(0);
  });

  it('keeps long names unique and short', () => {
    const a = roleNameFor('grun-example', 'grun-example/' + 'x'.repeat(80) + '/A/Resource');
    const b = roleNameFor('grun-example', 'grun-example/' + 'x'.repeat(80) + '/B/Resource');
    expect(a.length).toBeLessThanOrEqual(64);
    expect(a).not.toBe(b);
  });

  it('names the task roles per organisation and shape', () => {
    const names = resources(s.json, 'AWS::IAM::Role').map(([, r]) => r.Properties.RoleName);
    for (const org of ['acme', 'widgets']) {
      for (const shape of ['fg-large', 'fg-medium', 'fg-small']) {
        expect(names).toContain(`grun-example-${org}-${shape}-task`);
      }
    }
  });

  it('gives each organisation its task role policies from the config', () => {
    const policies = resources(s.json, 'AWS::IAM::Policy');
    const acme = policies.filter(([id]) => /^acmefglargetaskTaskRoleDefaultPolicy/.test(id));
    expect(acme).toHaveLength(1);
    const doc = text(acme[0][1].Properties.PolicyDocument);
    expect(doc).toContain('ecr:PutImage');
    expect(doc).toContain('example-ci-cache');
    // widgets has no policy of its own in the example: nothing from acme leaks into it
    const widgets = policies.filter(([id]) => /^widgetsfglargetaskTaskRoleDefaultPolicy/.test(id));
    expect(text(widgets.map(([, p]) => p.Properties.PolicyDocument))).not.toContain('ecr:PutImage');
  });

  it('attaches managed policies named in the config', () => {
    const t = synth((c) => {
      c.orgs[0].taskRole = { managedPolicyArns: ['arn:partition:iam::account-id:policy/example-codeartifact'] };
    });
    const role = resources(t.json, 'AWS::IAM::Role').find(([, r]) => r.Properties.RoleName === 'grun-example-acme-fg-small-task');
    expect(text(role?.[1].Properties.ManagedPolicyArns)).toContain('policy/example-codeartifact');
  });
});

describe('network', () => {
  it('creates no VPC, NAT gateway or internet gateway', () => {
    for (const type of ['AWS::EC2::VPC', 'AWS::EC2::NatGateway', 'AWS::EC2::InternetGateway', 'AWS::EC2::Subnet', 'AWS::EC2::EIP']) {
      expect(resources(s.json, type), type).toHaveLength(0);
    }
  });

  it('runs the tasks in the public subnets with a public IP', () => {
    const machines = resources(s.json, 'AWS::StepFunctions::StateMachine');
    expect(machines).toHaveLength(2);
    const def = definition(machines[0][1]);
    expect(def).toContain('"assignPublicIp":"ENABLED"');
    expect(def).toContain('subnet-0example00000001');
    expect(def).toContain('subnet-0example00000003');
  });

  it('gives the runner security group no inbound rule', () => {
    const groups = resources(s.json, 'AWS::EC2::SecurityGroup');
    expect(groups).toHaveLength(1);
    expect(groups[0][1].Properties.SecurityGroupIngress).toBeUndefined();
    expect(s.json.Outputs.RunnerSecurityGroupId).toBeDefined();
  });

  it('uses security groups from the config instead of creating one', () => {
    const t = synth((c) => {
      c.network.securityGroupIds = ['sg-0example0000000000'];
    });
    expect(resources(t.json, 'AWS::EC2::SecurityGroup')).toHaveLength(0);
    expect(definition(resources(t.json, 'AWS::StepFunctions::StateMachine')[0][1])).toContain('sg-0example0000000000');
  });
});

describe('providers', () => {
  const expected: Record<string, { cpu: string; memory: string; storage: number }> = {
    'fg-large': { cpu: '4096', memory: '24576', storage: 100 },
    'fg-medium': { cpu: '2048', memory: '14336', storage: 50 },
    'fg-small': { cpu: '1024', memory: '6144', storage: 50 },
  };

  it('has three Fargate ARM shapes per organisation', () => {
    const defs = resources(s.json, 'AWS::ECS::TaskDefinition');
    expect(defs).toHaveLength(6);
    for (const [id, d] of defs) {
      const p = d.Properties;
      expect(p.RuntimePlatform.CpuArchitecture, id).toBe('ARM64');
      expect(p.RequiresCompatibilities).toEqual(['FARGATE']);
      const shape = Object.keys(expected).find((k) => id.includes(k.replace('-', '')));
      expect(shape, id).toBeDefined();
      expect(p.Cpu).toBe(expected[shape!].cpu);
      expect(p.Memory).toBe(expected[shape!].memory);
      expect(p.EphemeralStorage.SizeInGiB).toBe(expected[shape!].storage);
    }
  });

  it('uses no EC2, no CodeBuild provider and no Lambda provider', () => {
    const defs = resources(s.json, 'AWS::StepFunctions::StateMachine').map(([, m]) => definition(m)).join('\n');
    expect(defs).not.toContain('"family":"ec2"');
    expect(defs).not.toContain('"family":"codebuild"');
    expect(defs).not.toContain('"family":"lambda"');
    expect(defs).toContain('"family":"fargate"');
    expect(resources(s.json, 'AWS::EC2::LaunchTemplate')).toHaveLength(0);
  });

  it('shares one cluster named after the stack', () => {
    const clusters = resources(s.json, 'AWS::ECS::Cluster');
    expect(clusters).toHaveLength(1);
    expect(clusters[0][1].Properties.ClusterName).toBe('grun-example');
  });

  it('can be given other shapes', () => {
    const t = synth((c) => {
      c.shapes = [{ label: 'fg-x', vcpu: 8, memoryGiB: 32, ephemeralStorageGiB: 200 }];
      c.warm = undefined;
    });
    const defs = resources(t.json, 'AWS::ECS::TaskDefinition');
    expect(defs).toHaveLength(2);
    expect(defs[0][1].Properties.Cpu).toBe('8192');
    expect(defs[0][1].Properties.EphemeralStorage.SizeInGiB).toBe(200);
  });

  const env = (json: any, idPrefix: string) => {
    const def = resources(json, 'AWS::ECS::TaskDefinition').find(([id]) => id.startsWith(idPrefix))![1];
    const runner = def.Properties.ContainerDefinitions.find((c: any) => c.Name === 'runner');
    return Object.fromEntries(runner.Environment.map((e: any) => [e.Name, e.Value]));
  };

  it('sets the cache endpoints and the TLS settings as runner environment', () => {
    const e = env(s.json, 'acmefglarge');
    expect(e).toMatchObject({
      CI_RUNNER_GOPROXY: 'https://goproxy.example.test',
      CI_RUNNER_NPM_REGISTRY: 'https://npm.example.test',
      CI_RUNNER_BAZEL_REMOTE_CACHE: 'grpcs://bazel.example.test:443',
      CI_RUNNER_REMOTE_BUILDERS: 'tcp://builder.example.test:1234',
      CI_RUNNER_GOCACHE_S3_BUCKET: 'example-ci-cache',
      CI_RUNNER_GOCACHE_S3_REGION: 'eu-central-1',
      CI_RUNNER_BUILDX_CACHE: 'account-id.dkr.ecr.eu-central-1.amazonaws.com/ci/buildkit-cache',
      CI_RUNNER_CACHE_WRITES: 'release-credentials',
      CI_BUILDKIT_TLS_DIR: '/etc/ci-buildkit-tls',
      CI_BUILDKIT_TLS_SERVERNAME: 'buildkitd.example.test',
    });
  });

  it('puts the Nix pull-through cache first and the upstream behind it, through NIX_CONFIG', () => {
    expect(env(s.json, 'acmefglarge').NIX_CONFIG).toBe(
      'substituters = https://nix.example.test/nix https://cache.nixos.org/\nconnect-timeout = 5\n',
    );
    const t = synth((c) => {
      c.runnerEnvironment = { goproxy: 'https://goproxy.example.test' };
    });
    expect(env(t.json, 'acmefglarge').NIX_CONFIG).toBeUndefined();
  });

  it('hands the tasks the Maven cache and the Gradle build cache, each only when named', () => {
    const e = env(s.json, 'acmefglarge');
    expect(e.CI_RUNNER_MAVEN_REGISTRY).toBe('https://maven.example.test');
    expect(e.CI_RUNNER_GRADLE_BUILD_CACHE).toBe('https://gradle.example.test');
    // A tier that must read no writable cache names the registry only.
    const t = synth((c) => {
      delete c.runnerEnvironment!.gradleBuildCache;
    });
    expect(env(t.json, 'acmefglarge').CI_RUNNER_MAVEN_REGISTRY).toBe('https://maven.example.test');
    expect(env(t.json, 'acmefglarge').CI_RUNNER_GRADLE_BUILD_CACHE).toBeUndefined();
    const u = synth((c) => {
      c.runnerEnvironment = { goproxy: 'https://goproxy.example.test' };
    });
    expect(env(u.json, 'acmefglarge').CI_RUNNER_MAVEN_REGISTRY).toBeUndefined();
    expect(env(u.json, 'acmefglarge').CI_RUNNER_GRADLE_BUILD_CACHE).toBeUndefined();
  });

  it('points NODE_EXTRA_CA_CERTS at the system bundle that holds the private CA', () => {
    expect(env(s.json, 'acmefglarge').NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/certs/ca-certificates.crt');
    const t = synth((c) => {
      c.runnerImage.extraCertificates = undefined;
    });
    expect(env(t.json, 'acmefglarge').NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it('adds an organisation\'s own environment to its tasks only', () => {
    expect(env(s.json, 'widgetsfgsmall').EXAMPLE_FLAG).toBe('1');
    expect(env(s.json, 'acmefgsmall').EXAMPLE_FLAG).toBeUndefined();
  });

  it('leaves out what the config leaves out', () => {
    const t = synth((c) => {
      c.runnerEnvironment = { goproxy: 'https://goproxy.example.test' };
      c.buildkit = undefined;
    });
    const e = env(t.json, 'acmefglarge');
    expect(Object.keys(e).filter((k) => k.startsWith('CI_'))).toEqual(['CI_RUNNER_GOPROXY']);
    const def = resources(t.json, 'AWS::ECS::TaskDefinition')[0][1];
    expect(def.Properties.ContainerDefinitions.map((c: any) => c.Name)).toEqual(['runner']);
  });

  it('writes the client certificate to one directory through an init container', () => {
    const def = resources(s.json, 'AWS::ECS::TaskDefinition').find(([id]) => id.startsWith('acmefglarge'))![1];
    const containers = def.Properties.ContainerDefinitions;
    const init = containers.find((c: any) => c.Name === 'tls-init');
    const runner = containers.find((c: any) => c.Name === 'runner');
    expect(init.Essential).toBe(false);
    expect(init.Secrets.map((x: any) => x.Name).sort()).toEqual(['TLS_CA', 'TLS_CERT', 'TLS_KEY']);
    const script = init.Command[0];
    for (const f of ['ca.pem', 'cert.pem', 'key.pem']) expect(script).toContain(f);
    expect(runner.DependsOn).toEqual([{ Condition: 'SUCCESS', ContainerName: 'tls-init' }]);
    expect(init.MountPoints[0]).toMatchObject({ ContainerPath: '/etc/ci-buildkit-tls', ReadOnly: false });
    expect(runner.MountPoints[0]).toMatchObject({ ContainerPath: '/etc/ci-buildkit-tls', ReadOnly: true });
    expect(def.Properties.Volumes).toEqual([{ Name: 'ci-buildkit-tls' }]);
  });

  it('lets the execution role read the client certificate secret and nothing wider', () => {
    const policy = resources(s.json, 'AWS::IAM::Policy').find(([id]) => /^acmefglargetaskExecutionRoleDefaultPolicy/.test(id))!;
    const stmts: any[] = policy[1].Properties.PolicyDocument.Statement;
    const read = stmts.find((st) => ([] as string[]).concat(st.Action).includes('secretsmanager:GetSecretValue'));
    expect(text(read.Resource)).toContain('example-buildkit-client');
  });

  it('keeps log retention on every log group', () => {
    for (const [id, g] of resources(s.json, 'AWS::Logs::LogGroup')) {
      expect(g.Properties.RetentionInDays, id).toBeDefined();
    }
  });
});

describe('runner image', () => {
  const project = () => resources(s.json, 'AWS::CodeBuild::Project')[0][1].Properties;

  it('is built by CodeBuild on Arm, outside any VPC', () => {
    expect(resources(s.json, 'AWS::CodeBuild::Project')).toHaveLength(1);
    expect(resources(s.json, 'AWS::ImageBuilder::Image')).toHaveLength(0);
    expect(project().Environment.Type).toBe('ARM_CONTAINER');
    expect(project().VpcConfig).toBeUndefined();
  });

  it('builds from the ci-plane image through the pull-through cache, at the configured version', () => {
    const spec = text(project().Source.BuildSpec);
    expect(spec).toContain('FROM account-id.dkr.ecr.eu-central-1.amazonaws.com/ghcr/example-org/ci-plane/runner:v0.0.0');
  });

  it('works as root and hands back to the runner user', () => {
    const spec = text(project().Source.BuildSpec);
    expect(spec.indexOf('USER root')).toBeGreaterThan(-1);
    expect(spec.lastIndexOf('USER runner')).toBeGreaterThan(spec.indexOf('USER root'));
    expect(spec).toContain('chown -R runner:runner /home/runner');
  });

  it('adds the runner layout, the hooks and the CloudWatch agent', () => {
    const spec = text(project().Source.BuildSpec);
    expect(spec).toContain('job-started-hook.sh');
    expect(spec).toContain('ACTIONS_RUNNER_HOOK_JOB_STARTED');
    expect(spec).toContain('amazon-cloudwatch-agent');
  });

  it('trusts the private CA', () => {
    const spec = text(project().Source.BuildSpec);
    expect(spec).toContain('update-ca-certificates');
    expect(spec).toContain('/usr/local/share/ca-certificates/private-ca-0.crt');
  });

  it('leaves the CA out when none is configured', () => {
    const t = synth((c) => {
      c.runnerImage.extraCertificates = undefined;
    });
    expect(text(resources(t.json, 'AWS::CodeBuild::Project')[0][1].Properties.Source.BuildSpec)).not.toContain('update-ca-certificates');
  });

  it('accepts the CA as PEM content', () => {
    const t = synth((c) => {
      c.runnerImage.extraCertificates = {
        pem: '-----BEGIN CERTIFICATE-----\nMIIBqzCCAVGg\n-----END CERTIFICATE-----',
      };
    });
    expect(text(resources(t.json, 'AWS::CodeBuild::Project')[0][1].Properties.Source.BuildSpec)).toContain('update-ca-certificates');
  });

  it('rebuilds when the configured ci-plane version changes', () => {
    const waitHandles = (json: any) => resources(json, 'AWS::CloudFormation::WaitConditionHandle').map(([id]) => id);
    const before = waitHandles(s.json);
    const after = waitHandles(
      synth((c) => {
        c.runnerImage.version = 'v9.9.9';
      }).json,
    );
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before[0]);
  });

  it('rebuilds on a schedule inside the runner version window', () => {
    const rules = resources(s.json, 'AWS::Events::Rule').filter(([, r]) => r.Properties.ScheduleExpression === 'rate(7 days)');
    expect(rules).toHaveLength(1);
  });

  it('lets the build pull through the cache', () => {
    const docs = text(resources(s.json, 'AWS::IAM::Policy').filter(([id]) => id.startsWith('RunnerImageBuilderRole')));
    expect(docs).toContain('ecr:BatchImportUpstreamImage');
    expect(docs).toContain('ghcr/example-org/ci-plane/runner');
  });
});

describe('webhook', () => {
  it('serves each organisation on its own custom domain, behind mTLS, with the default endpoint off', () => {
    const domains = resources(s.json, 'AWS::ApiGateway::DomainName');
    expect(domains).toHaveLength(2);
    expect(domains.map(([, d]) => d.Properties.DomainName).sort()).toEqual(['runners-acme.example.test', 'runners-widgets.example.test']);
    for (const [, d] of domains) {
      expect(d.Properties.MutualTlsAuthentication.TruststoreUri).toBe('s3://example-truststore-bucket/cloudflare-origin-pull-ca.pem');
      expect(d.Properties.SecurityPolicy).toBe('TLS_1_2');
      expect(d.Properties.EndpointConfiguration.Types).toEqual(['REGIONAL']);
    }
    const apis = resources(s.json, 'AWS::ApiGateway::RestApi');
    expect(apis).toHaveLength(2);
    for (const [, a] of apis) expect(a.Properties.DisableExecuteApiEndpoint).toBe(true);
  });

  it('prints the target of each DNS record', () => {
    expect(s.json.Outputs.WebhookAcmeRegionalDomainName).toBeDefined();
    expect(s.json.Outputs.WebhookWidgetsRegionalDomainName).toBeDefined();
  });

  it('has no function URL: the setup wizard is off and the webhook is behind the gateway', () => {
    expect(resources(s.json, 'AWS::Lambda::Url')).toHaveLength(0);
  });

  it('passes the truststore version when the config has one', () => {
    const t = synth((c) => {
      c.webhook.mtls.truststoreVersion = 'abc123';
    });
    expect(resources(t.json, 'AWS::ApiGateway::DomainName')[0][1].Properties.MutualTlsAuthentication.TruststoreVersion).toBe('abc123');
  });
});

describe('selector, cap and budget', () => {
  const fn = (desc: RegExp) =>
    resources(s.json, 'AWS::Lambda::Function').find(([, f]) => desc.test(f.Properties.Description ?? ''))![1].Properties;

  it('wires the provider selector with the cluster and the cap', () => {
    const env = fn(/Routes a job/).Environment.Variables;
    expect(env.MAX_CONCURRENT_TASKS).toBe('20');
    expect(env.ON_EXCEED).toBe('skip');
    expect(env.SHAPE_LABELS).toBe('fg-small,fg-medium,fg-large');
    expect(text(env.CLUSTER_ARN)).toContain('Cluster');
  });

  it('gives the selector list access to its cluster only', () => {
    const p = resources(s.json, 'AWS::IAM::Policy').find(([id]) => id.startsWith('ProviderSelectorServiceRoleDefaultPolicy'))![1];
    const st = p.Properties.PolicyDocument.Statement.find((x: any) => x.Action === 'ecs:ListTasks');
    expect(st.Condition.ArnEquals['ecs:cluster']).toBeDefined();
  });

  it('hands the selector to every organisation\'s webhook', () => {
    const webhooks = resources(s.json, 'AWS::Lambda::Function').filter(([, f]) => f.Properties.Environment?.Variables?.PROVIDER_SELECTOR_ARN);
    expect(webhooks).toHaveLength(2);
  });

  it('alarms when the cap refuses a job', () => {
    s.template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'Grun',
      MetricName: 'CapRefused',
      Dimensions: [{ Name: 'Stack', Value: 'grun-example' }],
    });
  });

  it('has a daily budget for the stack, with alerts', () => {
    const b = resources(s.json, 'AWS::Budgets::Budget')[0][1].Properties;
    expect(b.Budget.TimeUnit).toBe('DAILY');
    expect(b.Budget.BudgetLimit).toEqual({ Amount: 15, Unit: 'USD' });
    expect(b.Budget.CostFilters.TagKeyValue).toEqual(['user:component$ci']);
    // 80 % and 100 % of the actual spend, nothing else: see the next test.
    const notes = b.NotificationsWithSubscribers.map((n: any) => [n.Notification.NotificationType, n.Notification.Threshold]);
    expect(notes).toEqual([
      ['ACTUAL', 80],
      ['ACTUAL', 100],
    ]);
  });

  it('gives a daily budget no forecast, which AWS refuses at create time', () => {
    const budgets = resources(s.json, 'AWS::Budgets::Budget');
    expect(budgets.some(([, b]) => b.Properties.Budget.TimeUnit === 'DAILY')).toBe(true);
    for (const [id, b] of budgets) {
      if (b.Properties.Budget.TimeUnit !== 'DAILY') continue;
      const types = b.Properties.NotificationsWithSubscribers.map((n: any) => n.Notification.NotificationType);
      expect(types, id).not.toContain('FORECASTED');
    }
  });

  it('obeys the Budgets limits on notifications and subscribers', () => {
    for (const [id, b] of resources(s.json, 'AWS::Budgets::Budget')) {
      const notes = b.Properties.NotificationsWithSubscribers;
      expect(notes.length, id).toBeLessThanOrEqual(5);
      for (const n of notes) {
        expect(n.Subscribers.length, id).toBeGreaterThanOrEqual(1);
        expect(n.Subscribers.length, id).toBeLessThanOrEqual(10);
        expect(n.Notification.Threshold, id).toBeGreaterThan(0);
      }
      expect(b.Properties.Budget.BudgetName, id).toMatch(/^[^:\\]{1,100}$/);
    }
  });

  it('creates the budget after the topic policy that lets Budgets publish, and before the custom domains', () => {
    const budget = s.json.Resources.DailyBudget;
    const depends = [budget.DependsOn].flat().filter(Boolean);
    expect(depends.some((d: string) => /^AlertsPolicy/.test(d))).toBe(true);
    const domains = resources(s.json, 'AWS::ApiGateway::DomainName');
    expect(domains.length).toBeGreaterThan(0);
    for (const [id, d] of domains) expect([d.DependsOn].flat(), id).toContain('DailyBudget');
  });

  it('takes the cap and the budget from the config', () => {
    const t = synth((c) => {
      c.costCap = { maxConcurrentTasks: 5, onExceed: 'defer', dailyBudgetUsd: 7 };
    });
    const f = resources(t.json, 'AWS::Lambda::Function').find(([, x]) => /Routes a job/.test(x.Properties.Description ?? ''))![1];
    expect(f.Properties.Environment.Variables).toMatchObject({ MAX_CONCURRENT_TASKS: '5', ON_EXCEED: 'defer' });
    expect(resources(t.json, 'AWS::Budgets::Budget')[0][1].Properties.Budget.BudgetLimit.Amount).toBe(7);
  });
});

describe('cost tags', () => {
  // CloudFormation tags are a list of Key/Value, or a map on some resource types.
  const tagsOf = (r: any): Record<string, string> => {
    const t = r.Properties?.Tags ?? [];
    return Array.isArray(t) ? Object.fromEntries(t.map((x: any) => [x.Key, x.Value])) : t;
  };

  it('tags every task definition with its organisation, the component and the environment', () => {
    const defs = resources(s.json, 'AWS::ECS::TaskDefinition');
    expect(defs).toHaveLength(6);
    for (const [id, d] of defs) {
      const org = id.startsWith('acme') ? 'acme' : 'widgets';
      expect(tagsOf(d), id).toMatchObject({ company: org, component: 'ci', environment: 'example' });
    }
    expect(defs.filter(([id]) => id.startsWith('acme'))).toHaveLength(3);
    expect(defs.filter(([id]) => id.startsWith('widgets'))).toHaveLength(3);
  });

  it('drops the old Project and GrunEnv tags', () => {
    for (const [id, r] of Object.entries<any>(s.json.Resources)) {
      expect(Object.keys(tagsOf(r)), id).not.toContain('Project');
      expect(Object.keys(tagsOf(r)), id).not.toContain('GrunEnv');
    }
  });

  it('sends the company tag with RunTask, and propagates the task definition\'s tags', () => {
    const machines = resources(s.json, 'AWS::StepFunctions::StateMachine');
    expect(machines).toHaveLength(2);
    for (const [id, m] of machines) {
      const def = definition(m);
      expect(def, id).toContain('PropagateTags');
      expect(def, id).toContain('TASK_DEFINITION');
    }
    // the tag rides on the provider, per organisation
    const byOrg = (org: string) => machines.map(([, m]) => definition(m)).filter((d) => d.includes(`"Key":"company","Value":"${org}"`));
    expect(byOrg('acme')).toHaveLength(1);
    expect(byOrg('widgets')).toHaveLength(1);
  });

  it('registers the runners of an organisation in its runner group, and only that one', () => {
    const t = synth((c) => {
      c.orgs[1].runnerGroup = 'example-pilot-group';
    });
    const machines = resources(t.json, 'AWS::StepFunctions::StateMachine').map(([, m]) => definition(m));
    const company = (org: string) => machines.filter((d) => d.includes(`"Key":"company","Value":"${org}"`));
    expect(company('widgets')).toHaveLength(1);
    expect(company('widgets')[0]).toContain('example-pilot-group');
    expect(company('acme')).toHaveLength(1);
    expect(company('acme')[0]).not.toContain('example-pilot-group');
    // the example configuration, which sets none, names no group
    for (const [id, m] of resources(s.json, 'AWS::StepFunctions::StateMachine')) {
      expect(definition(m), id).not.toContain('example-pilot-group');
    }
  });

  it('takes the key names and the component value from the config', () => {
    const t = synth((c) => {
      c.costTags = { componentKey: 'Component', componentValue: 'runners', environmentKey: 'Env', companyKey: 'Company' };
    });
    for (const [id, d] of resources(t.json, 'AWS::ECS::TaskDefinition')) {
      expect(tagsOf(d), id).toMatchObject({ Component: 'runners', Env: 'example' });
      expect(tagsOf(d).Company, id).toMatch(/^(acme|widgets)$/);
      expect(Object.keys(tagsOf(d)), id).not.toContain('company');
    }
    expect(resources(t.json, 'AWS::Budgets::Budget')[0][1].Properties.Budget.CostFilters.TagKeyValue).toEqual(['user:Component$runners']);
  });
});

describe('runner secrets from SSM', () => {
  const secretEnv = {
    CI_BUILDKIT_TLS_CA_PEM: '/example/ci/buildkit-client/ca',
    CI_BUILDKIT_TLS_CERT_PEM: '/example/ci/buildkit-client/cert',
    CI_BUILDKIT_TLS_KEY_PEM: 'arn:partition:ssm:eu-central-1:account-id:parameter/example/ci/buildkit-client/key',
  };
  const runnerOf = (json: any, idPrefix: string) =>
    resources(json, 'AWS::ECS::TaskDefinition')
      .find(([id]) => id.startsWith(idPrefix))![1]
      .Properties.ContainerDefinitions.find((c: any) => c.Name === 'runner');
  const execPolicy = (json: any, idPrefix: string) =>
    resources(json, 'AWS::IAM::Policy').find(([id]) => new RegExp(`^${idPrefix}taskExecutionRoleDefaultPolicy`).test(id))![1].Properties.PolicyDocument
      .Statement as any[];

  it('injects the parameters into every task of every organisation, as secrets and not as plain environment', () => {
    for (const prefix of ['acmefglarge', 'acmefgsmall', 'widgetsfgmedium']) {
      const runner = runnerOf(s.json, prefix);
      expect(runner.Secrets.map((x: any) => x.Name).sort(), prefix).toEqual(Object.keys(secretEnv).sort());
      const plain = runner.Environment.map((e: any) => e.Name);
      for (const n of Object.keys(secretEnv)) expect(plain, prefix).not.toContain(n);
      // the value in the task definition is a reference to the parameter
      for (const x of runner.Secrets) expect(text(x.ValueFrom), prefix).toContain(':parameter/example/ci/buildkit-client/');
    }
  });

  it('leaves the init container and the other containers without them', () => {
    const def = resources(s.json, 'AWS::ECS::TaskDefinition').find(([id]) => id.startsWith('acmefglarge'))![1];
    const init = def.Properties.ContainerDefinitions.find((c: any) => c.Name === 'tls-init');
    expect(init.Secrets.map((x: any) => x.Name).sort()).toEqual(['TLS_CA', 'TLS_CERT', 'TLS_KEY']);
  });

  it('lets the execution role read exactly those parameters, and the task role none', () => {
    for (const prefix of ['acme', 'widgets']) {
      const stmts = execPolicy(s.json, `${prefix}fglarge`);
      const ssmStmts = stmts.filter((st) => ([] as string[]).concat(st.Action).some((a) => a.startsWith('ssm:')));
      expect(ssmStmts.length, prefix).toBeGreaterThan(0);
      const resourcesText = text(ssmStmts.map((st) => st.Resource));
      for (const n of ['buildkit-client/ca', 'buildkit-client/cert', 'buildkit-client/key']) expect(resourcesText, prefix).toContain(n);
      expect(resourcesText, prefix).not.toContain('"*"');
      expect(text(ssmStmts.map((st) => st.Action)), prefix).toContain('ssm:GetParameters');
    }
    const taskPolicy = text(resources(s.json, 'AWS::IAM::Policy').filter(([id]) => /^acmefglargetaskTaskRoleDefaultPolicy/.test(id)));
    expect(taskPolicy).not.toContain('ssm:');
  });

  it('does not grant KMS without a key, and decrypts with the given key only', () => {
    const none = synth((c) => {
      c.runner = { secretEnv };
    });
    expect(text(execPolicy(none.json, 'acmefglarge'))).not.toContain('kms:');
    const keyArn = 'arn:partition:kms:eu-central-1:account-id:key/example-key';
    const withKey = synth((c) => {
      c.runner = { secretEnv, secretKmsKeyArn: keyArn };
    });
    const kmsStmts = execPolicy(withKey.json, 'acmefglarge').filter((st) => ([] as string[]).concat(st.Action).some((a) => a.startsWith('kms:')));
    expect(text(kmsStmts.map((st) => st.Action))).toContain('kms:Decrypt');
    expect(text(kmsStmts.map((st) => st.Resource))).toBe(text([keyArn]));
  });

  it('adds nothing without runner.secretEnv', () => {
    const t = synth((c) => {
      c.runner = undefined;
    });
    expect(runnerOf(t.json, 'acmefglarge').Secrets).toBeUndefined();
  });

  it('keeps parameter values out of the template', () => {
    // the template only ever names parameters; no value is known to the stack
    expect(text(runnerOf(s.json, 'acmefglarge').Secrets)).not.toContain('BEGIN');
  });
});

describe('warm capacity', () => {
  it('schedules 2 x fg-large and 1 x fg-small on weekdays for the organisations that want it', () => {
    const rules = resources(s.json, 'AWS::Events::Rule').filter(([, r]) => r.Properties.ScheduleExpression === 'cron(0 6 ? * MON-FRI *)');
    expect(rules).toHaveLength(2);
    const inputs = rules.map(([, r]) => text(r.Properties.Targets));
    expect(inputs.some((i) => i.includes('fg-large') && i.includes('\\"count\\":2'))).toBe(true);
    expect(inputs.some((i) => i.includes('fg-small') && i.includes('\\"count\\":1'))).toBe(true);
    for (const i of inputs) {
      expect(i).toContain('acme');
      expect(i).not.toContain('widgets');
      expect(i).toContain('43200');
    }
  });

  it('is absent without a warm section', () => {
    const t = synth((c) => {
      c.warm = undefined;
    });
    expect(resources(t.json, 'AWS::Events::Rule').filter(([, r]) => /cron/.test(r.Properties.ScheduleExpression ?? ''))).toHaveLength(0);
  });
});

describe('secret sync', () => {
  const fn = () => resources(s.json, 'AWS::Lambda::Function').find(([, f]) => /Copies the GitHub Apps/.test(f.Properties.Description ?? ''))![1].Properties;

  it('runs every five minutes', () => {
    const rules = resources(s.json, 'AWS::Events::Rule').filter(
      ([, r]) => r.Properties.ScheduleExpression === 'rate(5 minutes)' && text(r.Properties.Targets).includes('SecretSync'),
    );
    expect(rules).toHaveLength(1);
  });

  it('is told where to read and what to write', () => {
    const cfg = JSON.stringify(fn().Environment.Variables.SYNC_CONFIG).replace(/\\"/g, '"');
    expect(cfg).toContain('role/example-reader');
    expect(cfg).toContain('/example/path/acme-grun');
    expect(cfg).toContain('/example/path/widgets-grun');
    expect(cfg).toContain('acmeRunnersSecretsGitHub');
    expect(cfg).toContain('widgetsRunnersSecretsWebhook');
    expect(cfg).toContain('"runnerLevel":"org"');
  });

  it('may assume the reader role and write its own secrets, and no more', () => {
    const p = resources(s.json, 'AWS::IAM::Policy').find(([id]) => id.startsWith('SecretSyncServiceRoleDefaultPolicy'))![1];
    const st: any[] = p.Properties.PolicyDocument.Statement;
    const assume = st.find((x) => x.Action === 'sts:AssumeRole');
    expect(assume.Resource).toContain('role/example-reader');
    const put = st.find((x) => x.Action === 'secretsmanager:PutSecretValue');
    expect(put.Resource).toHaveLength(6);
    expect(text(st)).not.toContain('"*"');
  });

  it('serialises runs', () => {
    expect(fn().ReservedConcurrentExecutions).toBe(1);
  });

  it('alarms on failure', () => {
    s.template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Errors',
      DatapointsToAlarm: 2,
      Dimensions: Match.arrayWith([Match.objectLike({ Name: 'FunctionName' })]),
    });
  });
});

describe('reports and alerts', () => {
  it('keeps reports without an expiry, private and encrypted', () => {
    const b = resources(s.json, 'AWS::S3::Bucket')[0][1].Properties;
    expect(b.LifecycleConfiguration).toBeUndefined();
    expect(b.PublicAccessBlockConfiguration).toBeDefined();
    expect(b.BucketEncryption).toBeDefined();
  });

  it('lets the task roles use the reports bucket unless the config says no', () => {
    const t = synth((c) => {
      c.reports = { taskRolesCanWrite: false };
    });
    const withGrant = text(resources(s.json, 'AWS::IAM::Policy').filter(([id]) => /^acmefglargetaskTaskRoleDefaultPolicy/.test(id)));
    const without = text(resources(t.json, 'AWS::IAM::Policy').filter(([id]) => /^acmefglargetaskTaskRoleDefaultPolicy/.test(id)));
    expect(withGrant).toContain('s3:PutObject');
    expect(without).not.toContain('Reports');
  });

  it('subscribes the alert addresses', () => {
    const subs = resources(s.json, 'AWS::SNS::Subscription').filter(([, x]) => x.Properties.Protocol === 'email');
    expect(subs).toHaveLength(s.config.alerts.emails.length);
    for (const [, x] of subs) expect(x.Properties.Endpoint).toBe('ci-alerts@example.test');
  });

  describe('failed image builds', () => {
    const rule = () => {
      const found = resources(s.json, 'AWS::Events::Rule').filter(([, r]) => r.Properties.EventPattern?.source?.includes('aws.codebuild'));
      expect(found).toHaveLength(1);
      return found[0][1].Properties;
    };

    it('has no CodeStar Notifications rule (it races the service-linked role on a fresh account)', () => {
      expect(resources(s.json, 'AWS::CodeStarNotifications::NotificationRule')).toHaveLength(0);
    });

    it('watches the image builder project for failed builds', () => {
      const [projectId] = resources(s.json, 'AWS::CodeBuild::Project')[0];
      const p = rule();
      expect(p.State).toBe('ENABLED');
      expect(p.EventPattern['detail-type']).toEqual(['CodeBuild Build State Change']);
      expect(p.EventPattern.detail['build-status']).toEqual(expect.arrayContaining(['FAILED']));
      // A stopped build is somebody's decision, not a failure.
      expect(p.EventPattern.detail['build-status']).not.toContain('STOPPED');
      expect(p.EventPattern.detail['project-name']).toEqual([{ Ref: projectId }]);
    });

    it('publishes to the alert topic with a readable message', () => {
      const [alertsId] = resources(s.json, 'AWS::SNS::Topic').find(([id]) => /^Alerts/.test(id))!;
      const targets = rule().Targets;
      expect(targets).toHaveLength(1);
      expect(targets[0].Arn).toEqual({ Ref: alertsId });
      const t = targets[0].InputTransformer;
      expect(Object.values(t.InputPathsMap)).toEqual(
        expect.arrayContaining(['$.detail.build-status', '$.detail.project-name', '$.detail.build-id']),
      );
      expect(text(t.InputTemplate)).toContain('runner image build');
    });

    it('lets EventBridge publish to the alert topic', () => {
      const policy = text(resources(s.json, 'AWS::SNS::TopicPolicy'));
      expect(policy).toContain('events.amazonaws.com');
    });

    it('creates no second topic or email subscription for it', () => {
      expect(resources(s.json, 'AWS::SNS::Topic')).toHaveLength(1);
      expect(resources(s.json, 'AWS::SNS::Subscription').filter(([, x]) => x.Properties.Protocol === 'email')).toHaveLength(
        s.config.alerts.emails.length,
      );
    });
  });

  it('lets Budgets publish to the alert topic', () => {
    expect(text(resources(s.json, 'AWS::SNS::TopicPolicy'))).toContain('budgets.amazonaws.com');
  });

  it('alarms on management function errors per organisation', () => {
    const alarms = resources(s.json, 'AWS::CloudWatch::Alarm').filter(([id]) => /ManagementLambdaErrors/.test(id));
    expect(alarms).toHaveLength(2);
  });
});

describe('rules AWS enforces at create time', () => {
  const intrinsicRef = (v: any): string | undefined => (typeof v === 'object' && v !== null ? (v.Ref ?? v['Fn::GetAtt']?.[0]) : undefined);

  it('gives every mutual TLS domain a regional endpoint, TLS 1.2 and a truststore, and maps it to a stage', () => {
    const domains = resources(s.json, 'AWS::ApiGateway::DomainName');
    expect(domains).toHaveLength(2);
    const mappings = resources(s.json, 'AWS::ApiGateway::BasePathMapping');
    for (const [id, d] of domains) {
      const p = d.Properties;
      expect(p.MutualTlsAuthentication.TruststoreUri, id).toMatch(/^s3:\/\/[^/]+\/.+/);
      expect(p.EndpointConfiguration.Types, id).toEqual(['REGIONAL']);
      expect(p.SecurityPolicy, id).toBe('TLS_1_2');
      // A regional domain takes a regional certificate, not the edge one.
      expect(p.RegionalCertificateArn, id).toBeDefined();
      expect(p.CertificateArn, id).toBeUndefined();
      // The mapping refers to the domain, so it is created after it.
      expect(mappings.some(([, m]) => intrinsicRef(m.Properties.DomainName) === id), id).toBe(true);
    }
    for (const [id, m] of mappings) {
      expect(domains.some(([did]) => did === intrinsicRef(m.Properties.DomainName)), id).toBe(true);
      expect(m.Properties.Stage, id).toBeDefined();
    }
    for (const [id, a] of resources(s.json, 'AWS::ApiGateway::RestApi')) {
      expect(a.Properties.DisableExecuteApiEndpoint, id).toBe(true);
    }
  });

  it('subscribes alert addresses by email with a plain address, and nothing email cannot take', () => {
    for (const [id, x] of resources(s.json, 'AWS::SNS::Subscription')) {
      if (x.Properties.Protocol !== 'email') continue;
      expect(x.Properties.Endpoint, id).toMatch(/^[^@\s]+@[^@\s]+$/);
      expect(x.Properties.RawMessageDelivery, id).toBeUndefined();
      expect(x.Properties.FilterPolicy, id).toBeUndefined();
    }
    for (const [id, t] of resources(s.json, 'AWS::SNS::Topic')) {
      expect((t.Properties.DisplayName ?? '').length, id).toBeLessThanOrEqual(100);
    }
  });

  it('builds the runner image on an Arm CodeBuild project with a compute type Arm has', () => {
    const arm = ['BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_LARGE', 'BUILD_GENERAL1_XLARGE', 'BUILD_GENERAL1_2XLARGE'];
    const check = (t: Synth) => {
      for (const [id, p] of resources(t.json, 'AWS::CodeBuild::Project')) {
        const e = p.Properties.Environment;
        expect(e.Type, id).toBe('ARM_CONTAINER');
        expect(e.Image, id).toContain('aarch64');
        expect(arm, id).toContain(e.ComputeType);
        expect(e.PrivilegedMode, id).toBe(true);
      }
    };
    check(s);
    for (const computeType of ['BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_LARGE'] as const) {
      const t = synth((c) => {
        c.runnerImage.computeType = computeType;
      });
      check(t);
      expect(resources(t.json, 'AWS::CodeBuild::Project')[0][1].Properties.Environment.ComputeType).toBe(computeType);
    }
  });

  // CloudWatch Logs takes these retention periods and no others.
  const VALID_RETENTION = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653];

  it('gives every log group a retention CloudWatch Logs accepts', () => {
    const groups = resources(s.json, 'AWS::Logs::LogGroup');
    expect(groups.length).toBeGreaterThan(0);
    for (const [id, g] of groups) expect(VALID_RETENTION, id).toContain(g.Properties.RetentionInDays);
    // Log groups made by the log retention custom resource take the same values.
    for (const [id, r] of resources(s.json, 'Custom::LogRetention')) expect(VALID_RETENTION, id).toContain(r.Properties.RetentionInDays);
  });

  it('accepts every retention the schema allows, and each synthesises to a valid one', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'schema.json'), 'utf8'));
    const allowed: number[] = schema.properties.logRetentionDays.enum;
    for (const days of allowed) {
      expect(VALID_RETENTION, `${days}`).toContain(days);
      const t = synth((c) => {
        c.logRetentionDays = days;
      });
      // The groups the stack makes itself follow the setting; the library's own keep their fixed one.
      for (const [id, g] of resources(t.json, 'AWS::Logs::LogGroup')) {
        expect(VALID_RETENTION, id).toContain(g.Properties.RetentionInDays);
        if (/^(ProviderSelectorLogs|SecretSyncLogs|acmefg)/.test(id)) expect(g.Properties.RetentionInDays, id).toBe(days);
      }
    }
  });

  it('gives every DynamoDB table one billing model, and a provisioned one its throughput', () => {
    const tables = resources(s.json, 'AWS::DynamoDB::Table');
    expect(tables.length).toBeGreaterThan(0);
    for (const [id, t] of tables) {
      const p = t.Properties;
      if (p.BillingMode === 'PAY_PER_REQUEST') {
        expect(p.ProvisionedThroughput, id).toBeUndefined();
        for (const g of p.GlobalSecondaryIndexes ?? []) expect(g.ProvisionedThroughput, id).toBeUndefined();
      } else {
        expect(p.ProvisionedThroughput, id).toBeDefined();
      }
    }
  });

  it('keeps every queue behind a Lambda at least as long invisible as the Lambda runs', () => {
    const find = (type: string, id: string) => s.json.Resources[id]?.Type === type ? s.json.Resources[id].Properties : undefined;
    const mappings = resources(s.json, 'AWS::Lambda::EventSourceMapping');
    expect(mappings.length).toBeGreaterThan(0);
    for (const [id, m] of mappings) {
      const arn = m.Properties.EventSourceArn;
      const queue = typeof arn === 'object' ? find('AWS::SQS::Queue', arn['Fn::GetAtt']?.[0]) : undefined;
      if (!queue) continue;
      const fn = find('AWS::Lambda::Function', intrinsicRef(m.Properties.FunctionName) ?? '');
      if (!fn) continue;
      expect(queue.VisibilityTimeout ?? 30, id).toBeGreaterThanOrEqual(fn.Timeout ?? 3);
    }
  });

  it('keeps every alarm\'s datapoints within its evaluation periods', () => {
    for (const [id, a] of resources(s.json, 'AWS::CloudWatch::Alarm')) {
      if (a.Properties.DatapointsToAlarm !== undefined) {
        expect(a.Properties.DatapointsToAlarm, id).toBeLessThanOrEqual(a.Properties.EvaluationPeriods);
      }
    }
  });

  it('keeps every Lambda environment inside the 4 KB limit, an intrinsic counted as a long ARN', () => {
    const size = (v: any): number => {
      if (typeof v === 'string') return v.length;
      if (v?.['Fn::Join']) return (v['Fn::Join'][1] as unknown[]).reduce<number>((n, p) => n + size(p), 0);
      return 128;
    };
    for (const [id, f] of resources(s.json, 'AWS::Lambda::Function')) {
      const vars = f.Properties.Environment?.Variables ?? {};
      const total = Object.entries(vars).reduce((n, [k, v]) => n + k.length + size(v), 0);
      expect(total, id).toBeLessThanOrEqual(4096);
    }
  });
});

describe('summary', () => {
  it('matches the reviewed shape of the stack', () => {
    const counts: Record<string, number> = {};
    for (const r of Object.values<any>(s.json.Resources)) counts[r.Type] = (counts[r.Type] ?? 0) + 1;
    const summary = {
      counts,
      roles: resources(s.json, 'AWS::IAM::Role')
        .map(([, r]) => r.Properties.RoleName as string)
        .sort(),
      outputs: Object.keys(s.json.Outputs).sort(),
    };
    expect(summary).toMatchSnapshot();
  });
});
