#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { loadHarnessConfig } from '../lib/config';

const app = new cdk.App();
// Validates the allow-list at synth time; stacks are added by later tasks.
loadHarnessConfig(app);
app.synth();
