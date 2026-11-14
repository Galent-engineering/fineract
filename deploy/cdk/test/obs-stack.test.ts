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
  const app = new cdk.App({ context: { allowedCidrs: '203.0.113.7/32', fineractImageTag: 'abc123' } });
  const config = loadHarnessConfig(app);
  const env = { account: '111111111111', region: 'us-east-1' };
  const build = new BuildStack(app, 'HarnessBuild', { env });
  const data = new DataStack(app, 'HarnessData', { env, allowedCidrs: config.allowedCidrs });
  const dns = new DnsStack(app, 'HarnessDns', { env });
  const appStack = new AppStack(app, 'HarnessApp', {
    env, data, dns, fineractRepo: build.fineractRepo, fineractImageTag: 'abc123', trafficRepo: build.trafficRepo, trafficImageTag: 'abc123',
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

  test('nginx: basic auth server-wide except /healthz, prefix stripped', () => {
    const conf = cfg('nginx.conf');
    expect(conf).toMatch(/server \{[^]*?auth_basic\s+"[^"]+";\s*auth_basic_user_file/);
    const health = conf.split('location = /healthz {')[1]?.split('}')[0] ?? '';
    expect(health).toMatch(/auth_basic off;/);
    expect(conf).toMatch(/rewrite \^\/tempo\/\(\.\*\)\$ \/\$1 break;/);
    expect(conf).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:3200;/);
    expect(conf).toMatch(/rewrite \^\/loki\/\(\.\*\)\$ \/\$1 break;/);
    expect(conf).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:3100;/);
  });

  test('nginx I-3: read-only allowlist, everything else 403', () => {
    const conf = cfg('nginx.conf');
    // no wholesale prefix proxy
    expect(conf).not.toMatch(/location \/(tempo|loki)\/ \{/);
    const locs: { head: string; body: string }[] = [];
    const lines = conf.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*location (.+) \{\s*$/);
      if (!m) continue;
      let depth = 1;
      let body = '';
      for (i++; i < lines.length && depth > 0; i++) {
        depth += (lines[i].match(/\{\s*$/) ? 1 : 0) - (lines[i].match(/^\s*\}/) ? 1 : 0);
        if (depth > 0) body += lines[i] + '\n';
      }
      i--;
      locs.push({ head: m[1].trim(), body });
    }
    const proxied = locs.filter((l) => /proxy_pass/.test(l.body));
    expect(proxied.length).toBeGreaterThanOrEqual(3);
    for (const l of proxied) {
      expect(l.body).toMatch(/limit_except (GET HEAD|GET HEAD POST) \{\s*deny all;/);
      expect(l.head).toMatch(/^~ \^\/(tempo|loki)\//);
    }
    // POST only on loki query, query_range, series
    const post = proxied.filter((l) => /GET HEAD POST/.test(l.body));
    expect(post).toHaveLength(1);
    expect(post[0].head).toMatch(/\(query\|query_range\|series\)\$/);
    // none of the write/admin endpoints is in an allowed pattern
    const allowed = proxied.map((l) => l.head).join('\n');
    for (const bad of ['push', 'delete', 'flush', 'shutdown', 'config', 'ring', 'admin', 'metrics']) {
      expect(allowed).not.toMatch(new RegExp(bad));
    }
    const fallback = locs.find((l) => l.head === '/')!;
    expect(fallback.body).toMatch(/return 403;/);
  });

  test('Loki flushes chunks quickly (I-7): idle 1m, max age 5m', () => {
    const loki = cfg('loki.yaml');
    expect(loki).toMatch(/chunk_idle_period: 1m/);
    expect(loki).toMatch(/max_chunk_age: 5m/);
  });

  test('obs service has a circuit breaker with rollback (I-5)', () => {
    const svcs = Object.values(obs.findResources('AWS::ECS::Service'));
    expect(svcs).toHaveLength(1);
    expect((svcs[0] as any).Properties.DeploymentConfiguration.DeploymentCircuitBreaker).toEqual({ Enable: true, Rollback: true });
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
