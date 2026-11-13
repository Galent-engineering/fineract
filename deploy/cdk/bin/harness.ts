#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { loadHarnessConfig } from '../lib/config';
import { BuildStack } from '../lib/build-stack';
import { DataStack } from '../lib/data-stack';
import { DnsStack } from '../lib/dns-stack';
import { AppStack } from '../lib/app-stack';

const app = new cdk.App();
// Validates the allow-list at synth time; later stacks are added by later tasks.
const config = loadHarnessConfig(app);

const build = new BuildStack(app, 'HarnessBuild', { env: { account: config.account, region: config.region } });
const data = new DataStack(app, 'HarnessData', {
  env: { account: config.account, region: config.region },
  allowedCidrs: config.allowedCidrs,
});
const dns = new DnsStack(app, 'HarnessDns', { env: { account: config.account, region: config.region } });
new AppStack(app, 'HarnessApp', {
  env: { account: config.account, region: config.region },
  data,
  dns,
  fineractRepo: build.fineractRepo,
  fineractImageTag: config.fineractImageTag,
});
app.synth();
