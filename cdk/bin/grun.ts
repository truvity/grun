#!/usr/bin/env node
import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { loadConfig, resolveCaFile, stackName } from '../lib/config';
import { GrunStack } from '../lib/stack';

const app = new App();
const file = app.node.tryGetContext('config') as string | undefined;
if (!file) {
  throw new Error('pass the environment configuration: cdk <command> -c config=<path to the env config file>');
}
const config = loadConfig(file);
const ca = config.runnerImage.extraCertificates;
const caFile = ca ? resolveCaFile(ca, path.resolve(file)) : undefined;

new GrunStack(app, stackName(config), {
  config,
  caFile,
  env: { region: config.region, account: config.account ?? process.env.CDK_DEFAULT_ACCOUNT },
  description: 'GitHub Actions runners on ECS Fargate (cdk-github-runners)',
});
