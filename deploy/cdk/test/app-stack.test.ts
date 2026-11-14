import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { loadHarnessConfig } from '../lib/config';
import { BuildStack } from '../lib/build-stack';
import { DataStack } from '../lib/data-stack';
import { DnsStack } from '../lib/dns-stack';
import { AppStack } from '../lib/app-stack';

const synth = () => {
  const app = new cdk.App({ context: { allowedCidrs: '203.0.113.7/32', fineractImageTag: 'abc123' } });
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

  test('HTTPS listener uses the TLS 1.2+/1.3 policy (I-1)', () => {
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
    });
  });

  test('circuit breaker with rollback on the Fineract and webapp services (I-5)', () => {
    const svcs = Object.values(t.findResources('AWS::ECS::Service'));
    expect(svcs).toHaveLength(2);
    for (const s of svcs) {
      expect(s.Properties.DeploymentConfiguration.DeploymentCircuitBreaker).toEqual({ Enable: true, Rollback: true });
    }
  });

  test.each(['HTTPS', 'HTTP'])('%s listener blocks actuator paths with a fixed 404 above the default (I-6)', (kind) => {
    const port = kind === 'HTTPS' ? 443 : 80;
    const listeners = t.findResources('AWS::ElasticLoadBalancingV2::Listener');
    const lid = Object.keys(listeners).find((k) => listeners[k].Properties.Port === port)!;
    const rules = Object.values(t.findResources('AWS::ElasticLoadBalancingV2::ListenerRule')).filter(
      (r: any) => JSON.stringify(r.Properties.ListenerArn).includes(lid) && r.Properties.Actions[0].Type === 'fixed-response',
    );
    expect(rules).toHaveLength(1);
    const r: any = rules[0];
    expect(r.Properties.Actions[0].FixedResponseConfig.StatusCode).toBe('404');
    expect(r.Properties.Priority).toBeLessThan(10);
    const values = r.Properties.Conditions.flatMap((c: any) => c.PathPatternConfig?.Values ?? []);
    expect(values).toEqual(expect.arrayContaining(['/actuator/*', '/fineract-provider/actuator/*']));
  });

  test('target group health check still targets readiness directly on the targets (I-6)', () => {
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/fineract-provider/actuator/health/readiness',
    });
  });

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

  test('webapp: pinned openmf/web-app image, 256/512, X86_64, env points at the HTTPS domain', () => {
    const def = byFamilyPrefix(t, 'webapp');
    expect(def.Properties.Cpu).toBe('256');
    expect(def.Properties.Memory).toBe('512');
    expect(def.Properties.RuntimePlatform.CpuArchitecture).toBe('X86_64');
    const c = def.Properties.ContainerDefinitions[0];
    expect(c.Image).toMatch(/^openmf\/web-app:1\.\d+(\.\d+)?@sha256:[0-9a-f]{64}$/);
    const env = Object.fromEntries((c.Environment ?? []).map((e: any) => [e.Name, e.Value]));
    expect(env.FINERACT_API_URL).toBe('https://fineract.galent.ai');
    expect(env.FINERACT_API_URLS).toBe('https://fineract.galent.ai');
    expect(env.FINERACT_PLATFORM_TENANT_IDENTIFIER).toBe('default');
    expect(env.FINERACT_API_PROVIDER).toBe('/fineract-provider/api');
    expect(env.FINERACT_API_VERSION).toBe('/v1');
    expect(env.FINERACT_API_ACTUATOR).toBe('/fineract-provider');
    expect(c.Secrets ?? []).toEqual([]);
  });

  test('HTTPS listener default action forwards to the webapp target group', () => {
    const listeners = Object.values(t.findResources('AWS::ElasticLoadBalancingV2::Listener'));
    const https = listeners.find((l: any) => l.Properties.Port === 443) as any;
    const action = https.Properties.DefaultActions[0];
    expect(action.Type).toBe('forward');
    const tgs = t.findResources('AWS::ElasticLoadBalancingV2::TargetGroup');
    const tgId = action.TargetGroupArn.Ref;
    expect(tgs[tgId].Properties.Port).toBe(80);
  });

  test('port 80 listener still only redirects to HTTPS', () => {
    const listeners = Object.values(t.findResources('AWS::ElasticLoadBalancingV2::Listener'));
    const http = listeners.find((l: any) => l.Properties.Port === 80) as any;
    expect(http.Properties.DefaultActions[0].Type).toBe('redirect');
  });

    test('no secret values in template', () => {
    expect(JSON.stringify(t.toJSON())).not.toMatch(/"SecretString"\s*:\s*"[^{]/);
  });
});
