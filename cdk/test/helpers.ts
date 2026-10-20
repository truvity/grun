import * as fs from 'node:fs';
import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { parse } from 'yaml';
import { GrunConfig, resolveCaFile, stackName, validate } from '../lib/config';
import { GrunStack } from '../lib/stack';

export const EXAMPLE = path.join(__dirname, '..', 'config', 'example.yaml');

export function exampleConfig(): GrunConfig {
  return parse(fs.readFileSync(EXAMPLE, 'utf8')) as GrunConfig;
}

export interface Synth {
  config: GrunConfig;
  stack: GrunStack;
  template: Template;
  json: any;
}

/** Synthesises the example configuration, optionally changed first. */
export function synth(mutate?: (c: GrunConfig) => void): Synth {
  const raw = exampleConfig();
  mutate?.(raw);
  const config = validate(JSON.parse(JSON.stringify(raw)));
  const ca = config.runnerImage.extraCertificates;
  const caFile = ca ? resolveCaFile(ca, EXAMPLE) : undefined;
  // The same feature flags as `cdk synth` (cdk.json), so tests see what deploys.
  const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'));
  const app = new App({ context: cdkJson.context });
  const stack = new GrunStack(app, stackName(config), { config, caFile, env: { region: config.region } });
  const template = Template.fromStack(stack);
  return { config, stack, template, json: template.toJSON() };
}

/** All resources of a type as [logicalId, resource]. */
export function resources(json: any, type: string): [string, any][] {
  return Object.entries<any>(json.Resources).filter(([, r]) => r.Type === type);
}

/** A state machine definition as one string, with references shown as <ref>. */
export function definition(machine: any): string {
  const d = machine.Properties.DefinitionString;
  if (typeof d === 'string') return d;
  return (d['Fn::Join'][1] as unknown[]).map((p) => (typeof p === 'string' ? p : '<ref>')).join('');
}
