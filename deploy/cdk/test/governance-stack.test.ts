import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { loadHarnessConfig } from '../lib/config';
import { BuildStack } from '../lib/build-stack';
import { DataStack } from '../lib/data-stack';
import { DnsStack } from '../lib/dns-stack';
import { AppStack } from '../lib/app-stack';
import { GovernanceStack } from '../lib/governance-stack';

const synth = () => {
  const app = new cdk.App({ context: { allowedCidrs: '203.0.113.7/32', fineractImageTag: 'abc123' } });
  const config = loadHarnessConfig(app);
  const env = { account: '111111111111', region: 'us-east-1' };
  const build = new BuildStack(app, 'HarnessBuild', { env });
  const data = new DataStack(app, 'HarnessData', { env, allowedCidrs: config.allowedCidrs });
  const dns = new DnsStack(app, 'HarnessDns', { env });
  const appStack = new AppStack(app, 'HarnessApp', {
    env, data, dns, fineractRepo: build.fineractRepo, fineractImageTag: 'abc123', trafficRepo: build.trafficRepo, trafficImageTag: 'abc123',
  });
  const gov = new GovernanceStack(app, 'HarnessGovernance', { env, data, app: appStack });
  return Template.fromStack(gov);
};

const t = synth();
const roleOf = (name: string) =>
  Object.values(t.findResources('AWS::IAM::Role')).find((r: any) => r.Properties.RoleName === name)!;
const policyFor = (prop: 'Roles' | 'Users', frag: string): any =>
  (Object.values(t.findResources('AWS::IAM::Policy')) as any[]).find((p) =>
    JSON.stringify(p.Properties[prop] ?? []).includes(frag),
  )!;
const actionsOf = (stmts: any[]) => stmts.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
const allowed = [
  /^(Get|List|Describe|BatchGet|Query|Search|Select)/,
];

describe('reader role', () => {
  const reader: any = roleOf('harness-reliability-reader');
  const readerPolicy = policyFor('Roles', 'ReaderRole');
  const actions: string[] = actionsOf(readerPolicy.Properties.PolicyDocument.Statement);

  test('holds only read/query/describe actions from the approved list', () => {
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) {
      const verb = a.split(':')[1];
      expect(allowed.some((re) => re.test(verb)) || ['FilterLogEvents', 'StartQuery', 'GetQueryResults'].includes(verb)).toBe(true);
    }
  });

  test('has no wildcard-all, Put, Create, Delete or Update', () => {
    for (const a of actions) {
      expect(a).not.toBe('*');
      expect(a).not.toMatch(/:\*$/);
      expect(a).not.toMatch(/:(Put|Create|Delete|Update)/);
    }
  });

  test('trust policy is the connector user with an sts:ExternalId condition', () => {
    const stmt = reader.Properties.AssumeRolePolicyDocument.Statement[0];
    expect(stmt.Action).toBe('sts:AssumeRole');
    expect(stmt.Condition.StringEquals['sts:ExternalId']).toBeDefined();
    expect(JSON.stringify(stmt.Principal)).toContain('ConnectorUser');
  });
});

describe('connector user', () => {
  test('only policy is sts:AssumeRole on the reader role', () => {
    t.hasResourceProperties('AWS::IAM::User', { UserName: 'harness-reliability-connector' });
    const userPolicies = (Object.values(t.findResources('AWS::IAM::Policy')) as any[]).filter((p) =>
      JSON.stringify(p.Properties.Users ?? []).includes('ConnectorUser'),
    );
    expect(userPolicies).toHaveLength(1);
    const stmts = userPolicies[0].Properties.PolicyDocument.Statement;
    expect(stmts).toHaveLength(1);
    expect(stmts[0].Action).toBe('sts:AssumeRole');
  });
  test('secrets exist for external id and access key', () => {
    t.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'harness/reader/external-id' });
    t.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'harness/reader/access-key' });
  });
});

describe('config, resilience, fis', () => {
  test('config recorder (SDK calls) is limited to harness types and has a delivery channel', () => {
    const calls = JSON.stringify(Object.values(t.findResources('Custom::AWS')).map((r: any) => r.Properties.Create));
    expect(calls).toContain('putConfigurationRecorder');
    expect(calls).toContain('putDeliveryChannel');
    expect(calls).toContain('startConfigurationRecorder');
    expect(calls).toContain('AWS::ECS::Service');
    expect(calls).toContain('\\"allSupported\\":false');
  });
  test('resilience hub app and policy (RTO 900s / RPO 300s)', () => {
    t.hasResourceProperties('AWS::ResilienceHub::App', { Name: 'fineract-harness' });
    t.hasResourceProperties('AWS::ResilienceHub::ResiliencyPolicy', {
      Policy: Match.objectLike({ AZ: { RtoInSecs: 900, RpoInSecs: 300 } }),
    });
  });
  test('two FIS templates, FIS-only role with no wildcard resources on write actions', () => {
    t.resourceCountIs('AWS::FIS::ExperimentTemplate', 2);
    const fisRole: any = roleOf('harness-fis');
    expect(JSON.stringify(fisRole.Properties.AssumeRolePolicyDocument)).toContain('fis.amazonaws.com');
    const pol = policyFor('Roles', 'FisRole');
    for (const s of pol.Properties.PolicyDocument.Statement) {
      const acts = Array.isArray(s.Action) ? s.Action : [s.Action];
      if (acts.some((a: string) => /Stop|Reboot/.test(a))) expect(JSON.stringify(s.Resource)).not.toBe('"*"');
    }
  });
});
