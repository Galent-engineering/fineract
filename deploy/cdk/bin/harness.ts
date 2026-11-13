#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { loadHarnessConfig } from '../lib/config';
import { BuildStack } from '../lib/build-stack';

const app = new cdk.App();
// Validates the allow-list at synth time; later stacks are added by later tasks.
const config = loadHarnessConfig(app);

new BuildStack(app, 'HarnessBuild', { env: { account: config.account, region: config.region } });
app.synth();
