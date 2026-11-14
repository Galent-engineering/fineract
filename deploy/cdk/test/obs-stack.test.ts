import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { loadHarnessConfig } from '../lib/config';
import { BuildStack } from '../lib/build-stack';
import { DataStack } from '../lib/data-stack';
import { DnsStack } from '../lib/dns-stack';
import { AppStack } from '../lib/app-stack';
import { ObsStack } from '../lib/obs-stack';

const synth = () => {
  const app = new cdk.App({ context: { allowedCidrs: '203.0.113.7/32' } });
  const config = loadHarnessConfig(app);
  const env = { account: '111111111111', region: 'us-east-1' };
  const build = new BuildStack(app, 'HarnessBuild', { env });
  const data = new DataStack(app, 'HarnessData', { env, allowedCidrs: config.allowedCidrs });
  const dns = new DnsStack(app, 'HarnessDns', { env });
  const appStack = new AppStack(app, 'HarnessApp', {
    env, data, dns, fineractRepo: build.fineractRepo, fineractImageTag: 'abc123',
  });
  const obs = new ObsStack(app, 'HarnessObs', { env, data, app: appStack });
  return { app: Template.fromStack(appStack), obs: Template.fromStack(obs) };
};

const fineractDef = (t: Template) =>
  Object.values(t.findResources('AWS::ECS::TaskDefinition')).find((r) =>
    JSON.stringify(r.Properties.Family).includes('harness-fineract'),
  )!;
const cfg = (f: string) => fs.readFileSync(path.join(__dirname, '..', 'config', f), 'utf8');

describe('Fineract telemetry sidecars', () => {
  const { app } = synth();

  test('task has fineract, adot and log_router containers', () => {
    const names = fineractDef(app).Properties.ContainerDefinitions.map((c: any) => c.Name);
    expect(names).toEqual(expect.arrayContaining(['fineract', 'adot', 'log_router']));
  });

  test('fineract container uses the awsfirelens log driver', () => {
    const c = fineractDef(app).Properties.ContainerDefinitions.find((x: any) => x.Name === 'fineract');
    expect(c.LogConfiguration.LogDriver).toBe('awsfirelens');
  });

  test('task role can write AMP, X-Ray and CloudWatch logs', () => {
    const stmts = Object.values(app.findResources('AWS::IAM::Policy')).flatMap((p: any) => p.Properties.PolicyDocument.Statement);
    const actions = stmts.flatMap((s: any) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(actions).toEqual(expect.arrayContaining(['aps:RemoteWrite', 'xray:PutTraceSegments', 'logs:PutLogEvents']));
    app.hasResourceProperties('AWS::APS::Workspace', Match.anyValue());
  });

  test('Fineract gets spans from the ADOT Java agent (no tracing bridge in 1.16.1)', () => {
    const c = fineractDef(app).Properties.ContainerDefinitions.find((x: any) => x.Name === 'fineract');
    const env = Object.fromEntries(c.Environment.map((e: any) => [e.Name, e.Value]));
    expect(env.JAVA_TOOL_OPTIONS).toMatch(/-Xmx5g/);
    expect(env.JAVA_TOOL_OPTIONS).toMatch(/-javaagent:\/otel\/javaagent\.jar/);
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://localhost:4318');
    const names = fineractDef(app).Properties.ContainerDefinitions.map((x: any) => x.Name);
    expect(names).toContain('otel_agent_init');
  });

  test('log group /harness/fineract exists', () => {
    app.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: '/harness/fineract' });
  });

  test('sidecar configs contain the required wiring', () => {
    const adot = cfg('adot-collector.yaml');
    expect(adot).toMatch(/sigv4auth/);
    expect(adot).toMatch(/awsxray/);
    expect(adot).toMatch(/tempo\.harness\.local:4318/);
    expect(adot).toMatch(/\/fineract-provider\/actuator\/prometheus/);
    const fb = cfg('fluent-bit.conf');
    expect(fb).toMatch(/cloudwatch_logs/);
    expect(fb).toMatch(/\/harness\/fineract/);
    expect(fb).toMatch(/loki\.harness\.local/);
  });
});

describe('ObsStack', () => {
  const { obs } = synth();

  test('nginx config requires auth_basic on both locations and strips the prefix', () => {
    const conf = cfg('nginx.conf');
    for (const loc of ['/tempo/', '/loki/']) {
      const block = conf.split(`location ${loc} {`)[1]?.split('}')[0] ?? '';
      expect(block).toMatch(/auth_basic\s+"/);
      expect(block).toMatch(/auth_basic_user_file/);
    }
    expect(conf).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:3200\/;/);
    expect(conf).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:3100\/;/);
  });

  test('basic-auth secret harness/obs/basic-auth with user reliability', () => {
    obs.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'harness/obs/basic-auth',
      GenerateSecretString: Match.objectLike({ SecretStringTemplate: JSON.stringify({ username: 'reliability' }) }),
    });
  });

  test('S3 bucket and AMP outputs; Cloud Map names tempo and loki', () => {
    obs.hasResourceProperties('AWS::S3::Bucket', { BucketName: Match.anyValue() });
    expect(Object.keys(obs.toJSON().Outputs)).toEqual(expect.arrayContaining(['AmpWorkspaceId', 'AmpQueryUrl']));
    const names = Object.values(obs.findResources('AWS::ServiceDiscovery::Service')).map((r: any) => r.Properties.Name);
    expect(names).toEqual(expect.arrayContaining(['tempo', 'loki']));
  });

  test('no public exposure except via the ALB: ALB rules for /tempo/* and /loki/*, no own LB or CIDR ingress', () => {
    obs.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Conditions: Match.arrayWith([Match.objectLike({ PathPatternConfig: { Values: ['/tempo/*'] } })]),
    });
    obs.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Conditions: Match.arrayWith([Match.objectLike({ PathPatternConfig: { Values: ['/loki/*'] } })]),
    });
    expect(Object.keys(obs.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer'))).toHaveLength(0);
    expect(JSON.stringify(obs.toJSON())).not.toMatch(/0\.0\.0\.0\/0/);
  });

  test('no password values in the template', () => {
    const tpl = JSON.stringify(obs.toJSON());
    expect(tpl).not.toMatch(/"SecretString":/);
    const defs = Object.values(obs.findResources('AWS::ECS::TaskDefinition'));
    const envNames = defs.flatMap((d: any) => d.Properties.ContainerDefinitions.flatMap((c: any) => (c.Environment ?? []).map((e: any) => e.Name)));
    expect(envNames.filter((n: string) => /PASSWORD|PW$/i.test(n))).toEqual([]);
  });
});
