import * as cdk from 'aws-cdk-lib';

export class HarnessConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessConfigError';
  }
}

export interface HarnessConfig {
  allowedCidrs: string[];
  account: string;
  region: 'us-east-1';
  githubRepo: 'Galent-engineering/fineract';
  githubBranch: 'galent/reliability-harness';
  fineractImageTag: string;
}

const OPEN_CIDRS = new Set(['0.0.0.0/0', '::/0']);

export function loadHarnessConfig(app: cdk.App): HarnessConfig {
  const raw = app.node.tryGetContext('allowedCidrs');
  const allowedCidrs = String(raw ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  if (allowedCidrs.length === 0) {
    throw new HarnessConfigError('allowedCidrs must list at least one CIDR (-c allowedCidrs=1.2.3.4/32)');
  }
  for (const cidr of allowedCidrs) {
    if (OPEN_CIDRS.has(cidr) || /\/0$/.test(cidr)) {
      throw new HarnessConfigError(`open CIDR not allowed: ${cidr}`);
    }
  }

  const fineractImageTag = String(app.node.tryGetContext('fineractImageTag') ?? '').trim();
  if (fineractImageTag === '' || fineractImageTag === 'latest') {
    throw new HarnessConfigError(
      'fineractImageTag is required and must be an immutable tag, not "latest" (-c fineractImageTag=<git sha pushed to harness/fineract>)',
    );
  }

  return {
    allowedCidrs,
    account: process.env.CDK_DEFAULT_ACCOUNT ?? String(app.node.tryGetContext('account') ?? ''),
    region: 'us-east-1',
    githubRepo: 'Galent-engineering/fineract',
    githubBranch: 'galent/reliability-harness',
    fineractImageTag: fineractImageTag,
  };
}

/** Traffic/seed image tag, pinned like fineractImageTag (immutable: git sha or digest, never "latest"). */
export function loadTrafficImageTag(app: cdk.App): string {
  const tag = String(app.node.tryGetContext('trafficImageTag') ?? '').trim();
  if (tag === '' || tag === 'latest') {
    throw new HarnessConfigError(
      'trafficImageTag is required and must be an immutable tag, not "latest" (-c trafficImageTag=<git sha pushed to harness/traffic>)',
    );
  }
  return tag;
}
