import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { loadHarnessConfig } from '../lib/config';
import { BuildStack } from '../lib/build-stack';
import { DataStack } from '../lib/data-stack';
import { DnsStack } from '../lib/dns-stack';
import { AppStack } from '../lib/app-stack';
import { GovernanceStack, RECORDED_TYPES } from '../lib/governance-stack';

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
// Literal on purpose (not imported from the lib): a change to the reader's permissions must change this test too.
const EXPECTED_READER_ACTIONS = [
  'aps:GetLabels', 'aps:GetMetricMetadata', 'aps:GetSeries', 'aps:QueryMetrics',
  'cloudwatch:Describe*', 'cloudwatch:Get*', 'cloudwatch:List*',
  'ecs:DescribeClusters', 'ecs:DescribeServices', 'ecs:DescribeTasks',
  'ecs:ListClusters', 'ecs:ListServices', 'ecs:ListTasks',
  'elasticloadbalancing:Describe*',
  'fis:Get*', 'fis:List*',
  'logs:DescribeLogGroups', 'logs:DescribeLogStreams', 'logs:FilterLogEvents', 'logs:GetQueryResults', 'logs:StartQuery',
  'rds:DescribeDBClusters', 'rds:DescribeDBInstances', 'rds:DescribeEvents',
  'resiliencehub:Describe*', 'resiliencehub:List*',
  'resource-explorer-2:Get*', 'resource-explorer-2:List*', 'resource-explorer-2:Search',
  'xray:BatchGet*', 'xray:Get*',
].sort();
const SERVICE_ALLOWLIST = ['aps', 'xray', 'logs', 'cloudwatch', 'resource-explorer-2', 'resiliencehub', 'fis', 'ecs', 'rds', 'elasticloadbalancing'];

describe('reader role', () => {
  const reader: any = roleOf('harness-reliability-reader');
  const readerPolicy = policyFor('Roles', 'ReaderRole');
  const stmts: any[] = readerPolicy.Properties.PolicyDocument.Statement;
  const actions: string[] = actionsOf(stmts);
  const resourcesOf = (action: string) =>
    stmts.filter((s) => ([] as string[]).concat(s.Action).includes(action)).flatMap((s) => ([] as any[]).concat(s.Resource));

  test('holds exactly the approved action set (equality, not a verb heuristic)', () => {
    expect([...actions].sort()).toEqual(EXPECTED_READER_ACTIONS);
  });

  test('holds no AWS Config action (historic config items from other teams in the shared account)', () => {
    expect(actions.filter((a) => a.toLowerCase().startsWith('config:'))).toEqual([]);
    expect(JSON.stringify(stmts)).not.toMatch(/config:/i);
  });

  test('every action is in the service allowlist; no secret-store, KMS, S3, SSM or IAM access', () => {
    for (const a of actions) {
      expect(SERVICE_ALLOWLIST).toContain(a.split(':')[0]);
      expect(a).not.toMatch(/^(secretsmanager|ssm|kms|s3|iam|sts|ec2|lambda|dynamodb):/);
    }
  });

  test('has no wildcard-all, Put, Create, Delete or Update, and only Allow statements without NotAction/NotResource', () => {
    for (const a of actions) {
      expect(a).not.toBe('*');
      expect(a).not.toMatch(/:\*$/);
      expect(a).not.toMatch(/:(Put|Create|Delete|Update)/);
    }
    for (const s of stmts) {
      expect(s.Effect).toBe('Allow');
      expect(s.NotAction).toBeUndefined();
      expect(s.NotResource).toBeUndefined();
    }
  });

  test('log reads are scoped to /harness* log groups, never "*"', () => {
    for (const a of ['logs:FilterLogEvents', 'logs:StartQuery', 'logs:DescribeLogStreams']) {
      const res = resourcesOf(a);
      expect(res.length).toBeGreaterThan(0);
      for (const r of res) {
        expect(JSON.stringify(r)).toContain('log-group:/harness*');
      }
    }
  });

  test('ECS reads are scoped to the harness clusters; task definitions are not readable at all', () => {
    for (const a of ['ecs:DescribeClusters', 'ecs:ListServices', 'ecs:ListTasks', 'ecs:DescribeServices', 'ecs:DescribeTasks']) {
      for (const r of resourcesOf(a)) expect(JSON.stringify(r)).toMatch(/(cluster|service|task)\/harness(-obs)?(\/|")/);
    }
    // ecs:DescribeTaskDefinition has no resource-level support (IAM evaluates it on "*"), and task definitions of other
    // workloads carry plaintext environment variables, so it is not granted: no wildcard escape hatch.
    for (const a of ['ecs:DescribeTaskDefinition', 'ecs:ListTaskDefinitions', 'ecs:ListTaskDefinitionFamilies', 'ecs:Describe*', 'ecs:List*']) {
      expect(actions).not.toContain(a);
    }
  });

  test('AMP queries are scoped to the harness workspace; RDS is describe-only', () => {
    for (const a of ['aps:QueryMetrics', 'aps:GetSeries', 'aps:GetLabels', 'aps:GetMetricMetadata']) {
      const res = resourcesOf(a);
      expect(res).toHaveLength(1);
      expect(JSON.stringify(res[0])).toContain('AmpWorkspace');
    }
    // The unfiltered describe (no identifier) needs "*" and returns metadata only.
    const rds = resourcesOf('rds:DescribeDBInstances');
    expect(rds).toEqual(['*']);
    expect(resourcesOf('rds:DescribeDBClusters')).toEqual(['*']);
    // Describe only: no data-plane or write RDS action.
    expect(actions.filter((a) => a.startsWith('rds:')).sort()).toEqual(
      ['rds:DescribeDBClusters', 'rds:DescribeDBInstances', 'rds:DescribeEvents']);
  });

  test('trust policy is the connector user with an sts:ExternalId condition', () => {
    const stmt = reader.Properties.AssumeRolePolicyDocument.Statement[0];
    expect(stmt.Action).toBe('sts:AssumeRole');
    expect(stmt.Condition.StringEquals['sts:ExternalId']).toBeDefined();
    expect(JSON.stringify(stmt.Principal)).toContain('ConnectorUser');
  });
});

describe('connector user', () => {
  test('only policy is sts:AssumeRole on exactly the reader and recovery roles', () => {
    t.hasResourceProperties('AWS::IAM::User', { UserName: 'harness-reliability-connector' });
    const userPolicies = (Object.values(t.findResources('AWS::IAM::Policy')) as any[]).filter((p) =>
      JSON.stringify(p.Properties.Users ?? []).includes('ConnectorUser'),
    );
    expect(userPolicies).toHaveLength(1);
    const stmts = userPolicies[0].Properties.PolicyDocument.Statement;
    expect(stmts).toHaveLength(1);
    expect(stmts[0].Action).toBe('sts:AssumeRole');
    const res = JSON.stringify(stmts[0].Resource);
    expect(stmts[0].Resource).toHaveLength(2);
    expect(res).toContain('ReaderRole');
    expect(res).toContain('RecoveryTesterRole');
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
  test('config recorder does not record ECS task definitions or IAM roles (env vars / policy documents)', () => {
    const calls = JSON.stringify(Object.values(t.findResources('Custom::AWS')).map((r: any) => r.Properties.Create));
    expect(calls).not.toContain('AWS::ECS::TaskDefinition');
    expect(calls).not.toContain('AWS::IAM::Role');
    expect([...RECORDED_TYPES].sort()).toEqual([
      'AWS::EC2::SecurityGroup', 'AWS::EC2::Subnet', 'AWS::EC2::VPC',
      'AWS::ECS::Cluster', 'AWS::ECS::Service',
      'AWS::ElasticLoadBalancingV2::Listener', 'AWS::ElasticLoadBalancingV2::LoadBalancer', 'AWS::ElasticLoadBalancingV2::TargetGroup',
      'AWS::RDS::DBInstance',
    ]);
  });
  test('recorder custom resource re-runs putConfigurationRecorder on update', () => {
    const rec: any = Object.values(t.findResources('Custom::AWS')).find((r: any) => JSON.stringify(r.Properties.Create).includes('putConfigurationRecorder'));
    expect(JSON.stringify(rec.Properties.Update)).toContain('putConfigurationRecorder');
    expect(JSON.stringify(rec.Properties.Update)).toBe(JSON.stringify(rec.Properties.Create));
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
    const trust = JSON.stringify(fisRole.Properties.AssumeRolePolicyDocument);
    expect(trust).toContain('aws:SourceAccount');
    expect(trust).toContain('aws:SourceArn');
    const pol = policyFor('Roles', 'FisRole');
    for (const s of pol.Properties.PolicyDocument.Statement) {
      const acts = Array.isArray(s.Action) ? s.Action : [s.Action];
      if (acts.some((a: string) => /Stop|Reboot/.test(a))) expect(JSON.stringify(s.Resource)).not.toBe('"*"');
    }
  });
});

describe('recovery tester role', () => {
  const role: any = roleOf('harness-recovery-tester');
  const pol = policyFor('Roles', 'RecoveryTesterRole');
  const stmts: any[] = pol.Properties.PolicyDocument.Statement;
  const arr = (x: any): any[] => ([] as any[]).concat(x);
  const resStr = (s: any) => JSON.stringify(s.Resource);
  const withAction = (a: string) => stmts.filter((s) => arr(s.Action).includes(a));

  test('recovery tester trusts only the connector user with the external id', () => {
    expect(role.Properties.AssumeRolePolicyDocument.Statement).toHaveLength(1);
    const stmt = role.Properties.AssumeRolePolicyDocument.Statement[0];
    expect(stmt.Action).toBe('sts:AssumeRole');
    expect(stmt.Condition.StringEquals['sts:ExternalId']).toBeDefined();
    expect(Object.keys(stmt.Principal)).toEqual(['AWS']);
    expect(stmt.Principal.AWS['Fn::GetAtt'][0]).toMatch(/^ConnectorUser[0-9A-F]+$/);
    expect(stmt.Principal.AWS['Fn::GetAtt'][1]).toBe('Arn');
    expect(stmt.Effect).toBe('Allow');
    expect(role.Properties.MaxSessionDuration).toBe(3600);
  });

  test('recovery tester holds exactly the approved FIS action set', () => {
    expect([...actionsOf(stmts)].sort()).toEqual([
      'fis:GetAction', 'fis:GetExperiment', 'fis:GetExperimentTemplate',
      'fis:ListActions', 'fis:ListExperimentTemplates', 'fis:ListExperiments', 'fis:ListTagsForResource',
      'fis:StartExperiment', 'fis:StartExperiment', 'fis:StopExperiment', 'fis:TagResource',
    ].sort());
  });

  const VALUES = ['db-outage', 'slowdown', 'crash'];
  const NEW_EXP_COND = {
    'ForAllValues:StringEquals': { 'aws:TagKeys': ['harness-scenario', 'recovery-test-id'] },
    StringEquals: { 'aws:RequestTag/harness-scenario': VALUES },
  };

  test('start on a template requires a scenario tag with an allowed value', () => {
    const s = withAction('fis:StartExperiment').find((x) => resStr(x).includes('experiment-template/*'))!;
    expect(s.Condition).toEqual({ StringEquals: { 'aws:ResourceTag/harness-scenario': VALUES } });
  });

  test('start and tag on new experiments are limited to known tag keys and scenario values', () => {
    const start = withAction('fis:StartExperiment').find((x) => resStr(x).includes(':experiment/*'))!;
    expect(start.Condition).toEqual(NEW_EXP_COND);
    const tag = withAction('fis:TagResource');
    expect(tag).toHaveLength(1);
    expect(resStr(tag[0])).toContain(':experiment/*');
    expect(tag[0].Condition).toEqual(NEW_EXP_COND);
  });

  test('stop requires the test-id tag and a scenario value', () => {
    const stop = withAction('fis:StopExperiment');
    expect(stop).toHaveLength(1);
    expect(resStr(stop[0])).toContain(':experiment/*');
    expect(stop[0].Condition).toEqual({
      Null: { 'aws:ResourceTag/recovery-test-id': 'false' },
      StringEquals: { 'aws:ResourceTag/harness-scenario': VALUES },
    });
  });

  test('no write action has Resource "*"', () => {
    for (const s of stmts) {
      if (arr(s.Action).some((a) => /^fis:(Start|Stop|TagResource)/.test(a))) expect(arr(s.Resource)).not.toContain('*');
    }
  });

  test('recovery tester has no non-FIS action, wildcard, NotAction, NotResource or PassRole', () => {
    for (const a of actionsOf(stmts)) expect(a.startsWith('fis:')).toBe(true);
    expect(actionsOf(stmts).filter((a) => a.includes('*'))).toEqual([]);
    for (const s of stmts) {
      expect(s.Effect).toBe('Allow');
      expect(s.NotAction).toBeUndefined();
      expect(s.NotResource).toBeUndefined();
      expect(s.NotPrincipal).toBeUndefined();
    }
    expect(JSON.stringify(stmts)).not.toContain('iam:PassRole');
  });

  test('exports the role arn', () => {
    expect(Object.keys(t.findOutputs('RecoveryTesterRoleArn'))).toEqual(['RecoveryTesterRoleArn']);
  });
});

describe('public fork hygiene', () => {
  test('fork carries no account id or product name', () => {
    const json = JSON.stringify(t.toJSON()).replace(/111111111111/g, '');
    expect(json).not.toMatch(/\b\d{12}\b/);
    expect(json).not.toMatch(/galent|fineract-demo/i);
  });
});
