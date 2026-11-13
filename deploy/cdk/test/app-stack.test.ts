import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { loadHarnessConfig } from '../lib/config';
import { BuildStack } from '../lib/build-stack';
import { DataStack } from '../lib/data-stack';
import { DnsStack } from '../lib/dns-stack';
import { AppStack } from '../lib/app-stack';

const synth = () => {
  const app = new cdk.App({ context: { allowedCidrs: '203.0.113.7/32' } });
  const config = loadHarnessConfig(app);
  const env = { account: '111111111111', region: 'us-east-1' };
  const build = new BuildStack(app, 'HarnessBuild', { env });
  const data = new DataStack(app, 'HarnessData', { env, allowedCidrs: config.allowedCidrs });
  const dns = new DnsStack(app, 'HarnessDns', { env });
  const stack = new AppStack(app, 'HarnessApp', {
    env,
    data,
    dns,
    fineractRepo: build.fineractRepo,
    fineractImageTag: 'abc123',
  });
  return Template.fromStack(stack);
};

const taskDefs = (t: Template) => Object.values(t.findResources('AWS::ECS::TaskDefinition'));
const byFamilyPrefix = (t: Template, prefix: string) => {
  const d = taskDefs(t).find((r) => String(JSON.stringify(r.Properties.Family ?? '')).includes(prefix));
  if (!d) throw new Error(`no task def ${prefix}`);
  return d;
};

describe('AppStack', () => {
  const t = synth();

  test('fineract container env has no PASSWORD/SECRET keys; credentials via Secrets', () => {
    const def = byFamilyPrefix(t, 'fineract');
    const c = def.Properties.ContainerDefinitions[0];
    const keys = (c.Environment ?? []).map((e: any) => e.Name);
    expect(keys.filter((k: string) => /PASSWORD|SECRET/i.test(k))).toEqual([]);
    expect(keys).toContain('JAVA_TOOL_OPTIONS');
    const secretNames = (c.Secrets ?? []).map((s: any) => s.Name);
    expect(secretNames).toEqual(expect.arrayContaining(['FINERACT_HIKARI_PASSWORD', 'FINERACT_DEFAULT_TENANTDB_PWD', 'FINERACT_DEFAULT_TENANTDB_MASTER_PASSWORD']));
  });

  test('JAVA_TOOL_OPTIONS has -Xmx5g', () => {
    const c = byFamilyPrefix(t, 'fineract').Properties.ContainerDefinitions[0];
    expect(c.Environment.find((e: any) => e.Name === 'JAVA_TOOL_OPTIONS').Value).toContain('-Xmx5g');
  });

  test('service health-check grace period is 900', () => {
    t.hasResourceProperties('AWS::ECS::Service', { HealthCheckGracePeriodSeconds: 900 });
  });

  test('target group health check is readiness, matcher 200', () => {
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/fineract-provider/actuator/health/readiness',
      Matcher: { HttpCode: '200' },
    });
  });

  test('listener rule /fineract-provider/* forwards', () => {
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Conditions: Match.arrayWith([Match.objectLike({ PathPatternConfig: { Values: ['/fineract-provider/*'] } })]),
    });
  });

  test('task cpu 2048, memory 8192, X86_64', () => {
    t.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '2048',
      Memory: '8192',
      RuntimePlatform: Match.objectLike({ CpuArchitecture: 'X86_64' }),
    });
  });

  test('db-init task def exists and takes credentials only via Secrets', () => {
    const def = byFamilyPrefix(t, 'dbinit');
    const c = def.Properties.ContainerDefinitions[0];
    expect(c.Image).toBe('postgres:18');
    const keys = (c.Environment ?? []).map((e: any) => e.Name);
    expect(keys.filter((k: string) => /PASSWORD|SECRET|PGPASS|FINERACT_DB_PASS/i.test(k))).toEqual([]);
    expect(c.Secrets.length).toBeGreaterThanOrEqual(2);
  });

  test('no secret values in template', () => {
    expect(JSON.stringify(t.toJSON())).not.toMatch(/"SecretString"\s*:\s*"[^{]/);
  });
});
