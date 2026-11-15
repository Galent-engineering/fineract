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
    fineractImageTag: 'abc123', trafficRepo: build.trafficRepo, trafficImageTag: 'abc123',
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

  test('circuit breaker with rollback on the Fineract, webapp and traffic services (I-5)', () => {
    const svcs = Object.values(t.findResources('AWS::ECS::Service'));
    expect(svcs).toHaveLength(3);
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
    // M-A: bare paths must be blocked too; '/x/*' does not match '/x'.
    expect(values).toEqual(expect.arrayContaining(['/actuator', '/fineract-provider/actuator']));
  });

  test('no service pins DesiredCount, so a paused count survives cdk deploy (Task 9)', () => {
    for (const s of Object.values(t.findResources('AWS::ECS::Service'))) {
      expect(s.Properties).not.toHaveProperty('DesiredCount');
    }
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
    expect(c.Image).toMatch(/^postgres:18@sha256:[0-9a-f]{64}$/);
    const keys = (c.Environment ?? []).map((e: any) => e.Name);
    expect(keys.filter((k: string) => /PASSWORD|SECRET|PGPASS|FINERACT_DB_PASS/i.test(k))).toEqual([]);
    expect(c.Secrets.length).toBeGreaterThanOrEqual(2);
  });

  test('db-reader-grant task def pins the postgres image by digest too', () => {
    const c = byFamilyPrefix(t, 'dbreadergrant').Properties.ContainerDefinitions[0];
    expect(c.Image).toMatch(/^postgres:18@sha256:[0-9a-f]{64}$/);
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

  describe('Task 8: traffic, seed, db-reader-grant', () => {
    test('traffic SG may reach the Fineract tasks on 8080 only', () => {
      const ing = Object.values(t.findResources('AWS::EC2::SecurityGroupIngress')).filter((r: any) =>
        JSON.stringify(r.Properties.SourceSecurityGroupId ?? '').includes('TrafficSg'),
      );
      expect(ing).toHaveLength(1);
      expect((ing[0] as any).Properties).toMatchObject({ FromPort: 8080, ToPort: 8080, IpProtocol: 'tcp' });
    });

    test('Fineract registers in Cloud Map as fineract.harness.local', () => {
      t.hasResourceProperties('AWS::ServiceDiscovery::Service', { Name: 'fineract' });
      const traffic = byFamilyPrefix(t, 'harness-traffic').Properties.ContainerDefinitions[0];
      const env = Object.fromEntries(traffic.Environment.map((e: any) => [e.Name, e.Value]));
      expect(env.FINERACT_BASE_URL).toBe('http://fineract.harness.local:8080');
      expect(env.RATE_PER_MIN).toBe('6');
    });

    test('ADOT Java agent samples 25% of traces (parent-based)', () => {
      const env = Object.fromEntries(
        byFamilyPrefix(t, 'harness-fineract').Properties.ContainerDefinitions.find((c: any) => c.Name === 'fineract').Environment.map(
          (e: any) => [e.Name, e.Value],
        ),
      );
      expect(env.OTEL_TRACES_SAMPLER).toBe('parentbased_traceidratio');
      expect(env.OTEL_TRACES_SAMPLER_ARG).toBe('0.25');
    });

    test('new generated secrets exist with DESTROY removal', () => {
      for (const name of ['harness/fineract/reliability-api', 'harness/fineract/mifos']) {
        const r = Object.values(t.findResources('AWS::SecretsManager::Secret')).find(
          (x: any) => x.Properties.Name === name,
        ) as any;
        expect(r).toBeDefined();
        expect(r.DeletionPolicy).toBe('Delete');
        expect(r.Properties.GenerateSecretString.GenerateStringKey).toBe('password');
      }
    });

    test('seed and db-reader-grant task definitions exist; reader SQL grants only SELECT', () => {
      const seed = byFamilyPrefix(t, 'harness-seed').Properties.ContainerDefinitions[0];
      expect(seed.Command).toEqual(['python', '-m', 'harness_traffic.seed']);
      const grant = byFamilyPrefix(t, 'harness-dbreadergrant').Properties.ContainerDefinitions[0];
      const sql = grant.Environment.find((e: any) => e.Name === 'READER_SQL').Value as string;
      expect(sql).toMatch(/GRANT SELECT ON ALL TABLES/);
      expect(sql).not.toMatch(/INSERT|UPDATE|DELETE|ALL PRIVILEGES/i);
    });
  });
});

describe('AppStack demo scenarios (FIS)', () => {
  const t = synth();
  const templates = () => Object.values(t.findResources('AWS::FIS::ExperimentTemplate'));
  const byScenario = (name: string) => {
    const r = templates().find((x) => x.Properties.Tags['harness-scenario'] === name);
    if (!r) throw new Error(`no template ${name}`);
    return r.Properties;
  };
  const acts = (a: unknown): string[] => ([] as string[]).concat(a as string | string[]);

  test('exactly three templates, tagged harness-scenario', () => {
    const names = templates().map((x) => x.Properties.Tags['harness-scenario']).sort();
    expect(names).toEqual(['crash', 'db-outage', 'slowdown']);
  });

  test('db-outage: egress tcp 5432 blackhole for PT4M via the ECS fault endpoints', () => {
    const a = Object.values(byScenario('db-outage').Actions)[0] as any;
    expect(a.ActionId).toBe('aws:ecs:task-network-blackhole-port');
    expect(a.Parameters).toEqual({
      duration: 'PT4M', port: '5432', protocol: 'tcp', trafficType: 'egress', useEcsFaultInjectionEndpoints: 'true',
    });
  });

  test('slowdown: 200 ms latency for PT4M via the ECS fault endpoints', () => {
    const a = Object.values(byScenario('slowdown').Actions)[0] as any;
    expect(a.ActionId).toBe('aws:ecs:task-network-latency');
    expect(a.Parameters).toEqual({ duration: 'PT4M', delayMilliseconds: '200', useEcsFaultInjectionEndpoints: 'true' });
  });

  test('crash: stop-task only', () => {
    const a = Object.values(byScenario('crash').Actions)[0] as any;
    expect(a.ActionId).toBe('aws:ecs:stop-task');
  });

  test('every template targets only the Fineract service in the harness cluster; hard duration is the stop', () => {
    for (const r of templates()) {
      const targets = Object.values(r.Properties.Targets) as any[];
      expect(targets).toHaveLength(1);
      expect(targets[0].ResourceType).toBe('aws:ecs:task');
      expect(targets[0].Parameters).toEqual({ cluster: 'harness', service: 'fineract' });
      expect(r.Properties.StopConditions).toEqual([{ Source: 'none' }]);
    }
  });

  test('FIS role: trusted by fis in this account; no wildcard actions; * resources only where AWS has no scoping', () => {
    const roles = Object.values(t.findResources('AWS::IAM::Role')).filter(
      (r) => r.Properties.RoleName === 'harness-fis-scenarios',
    );
    expect(roles).toHaveLength(1);
    const trust = roles[0].Properties.AssumeRolePolicyDocument.Statement[0];
    expect(trust.Principal.Service).toBe('fis.amazonaws.com');
    expect(trust.Condition.StringEquals['aws:SourceAccount']).toBeDefined();
    const pol = Object.values(t.findResources('AWS::IAM::Policy')).find((p) =>
      JSON.stringify(p.Properties.Roles).includes('FisScenarioRole'),
    );
    const stmts = pol!.Properties.PolicyDocument.Statement as any[];
    for (const s of stmts) {
      for (const act of acts(s.Action)) expect(act).not.toContain('*');
      if (JSON.stringify(s.Resource) === '"*"') {
        expect(acts(s.Action).sort()).toEqual([
          'ec2:DescribeInstances', 'ec2:DescribeSubnets', 'ecs:DescribeContainerInstances', 'ecs:ListTasks',
          'ssm:CancelCommand', 'ssm:ListCommands', 'tag:GetResources',
        ].filter((x) => acts(s.Action).includes(x)));
      }
    }
    const flat = stmts.flatMap((s) => acts(s.Action));
    for (const need of ['ecs:DescribeContainerInstances', 'ec2:DescribeInstances', 'ec2:DescribeSubnets']) {
      expect(flat).toContain(need);
    }
    const list = stmts.find((s) => acts(s.Action).includes('ecs:ListTasks'));
    expect(list.Resource).toBe('*');
    expect(list.Condition).toBeUndefined(); // FIS target resolution has no ecs:cluster in its context (live InvalidTarget)
    const sends = stmts.filter((s) => acts(s.Action).includes('ssm:SendCommand'));
    const docs = sends.find((s) => JSON.stringify(s.Resource).includes('document/'));
    expect(JSON.stringify(docs.Resource)).toContain('AWSFIS-Run-Network-Blackhole-Port-ECS');
    expect(JSON.stringify(docs.Resource)).toContain('AWSFIS-Run-Network-Latency-ECS');
    expect(JSON.stringify(docs.Resource)).not.toContain('managed-instance');
    const inst = sends.find((s) => JSON.stringify(s.Resource).includes('managed-instance/*'));
    expect(inst.Condition.StringEquals['ssm:resourceTag/FAULT_INJECTION_SIDECAR']).toBe('true');
    const stop = stmts.find((s) => acts(s.Action).includes('ecs:StopTask'));
    expect(JSON.stringify(stop.Resource)).toContain('task/harness/*');
  });

  const policyStatements = (rolePart: string) => {
    const pols = Object.values(t.findResources('AWS::IAM::Policy')).filter((p) => JSON.stringify(p.Properties.Roles).includes(rolePart));
    return pols.flatMap((p) => p.Properties.PolicyDocument.Statement as any[]);
  };

  test('sidecar permissions on the Fineract task role are scoped (deregister by tag, tags on instances/activations, PassRole to one role)', () => {
    const st = policyStatements('FineractTaskDefTaskRole');
    const dereg = st.find((s) => acts(s.Action).includes('ssm:DeregisterManagedInstance'));
    expect(JSON.stringify(dereg.Resource)).toContain('managed-instance/*');
    expect(dereg.Condition.StringEquals['ssm:resourceTag/FAULT_INJECTION_SIDECAR']).toBe('true');
    const tag = st.find((s) => acts(s.Action).includes('ssm:AddTagsToResource'));
    expect(tag.Condition.StringEquals['aws:RequestTag/FAULT_INJECTION_SIDECAR']).toBe('true');
    expect(tag.Condition['ForAllValues:StringEquals']['aws:TagKeys'].sort()).toEqual(['ECS_TASK_ARN', 'ECS_TASK_AVAILABILITY_ZONE', 'FAULT_INJECTION_SIDECAR']);
    expect(st.some((s) => acts(s.Action).includes('ssm:DeleteActivation'))).toBe(true);
    const create = st.find((s) => acts(s.Action).includes('ssm:CreateActivation'));
    expect(acts(create.Action)).toEqual(['ssm:CreateActivation']);
    const pass = st.find((s) => acts(s.Action).includes('iam:PassRole') && JSON.stringify(s.Resource).includes('FisSsmManagedInstanceRole'));
    expect(pass.Condition.StringEquals['iam:PassedToService']).toBe('ssm.amazonaws.com');
    expect(Array.isArray(pass.Resource)).toBe(false);
  });

  test('managed-instance role: deregister scoped by the sidecar tag', () => {
    const st = policyStatements('FisSsmManagedInstanceRole');
    const dereg = st.find((s) => acts(s.Action).includes('ssm:DeregisterManagedInstance'));
    expect(dereg.Condition.StringEquals['ssm:resourceTag/FAULT_INJECTION_SIDECAR']).toBe('true');
    expect(dereg.Resource).not.toBe('*');
  });

  test('Fineract task def: fault injection on, pidMode task, SSM agent sidecar with the managed instance role', () => {
    const d = byFamilyPrefix(t, 'harness-fineract').Properties;
    expect(d.EnableFaultInjection).toBe(true);
    expect(d.PidMode).toBe('task');
    const c = d.ContainerDefinitions.find((x: any) => x.Name === 'amazon-ssm-agent');
    expect(c.Essential).toBe(false);
    expect(c.Image).toContain('amazon-ssm-agent');
    expect(c.Environment[0].Name).toBe('MANAGED_INSTANCE_ROLE_NAME');
    expect(c.Command[0]).toContain('amazon-ssm-agent -register');
  });

  test('only the Fineract task def has fault injection', () => {
    expect(taskDefs(t).filter((r) => r.Properties.EnableFaultInjection === true)).toHaveLength(1);
  });

  test('SSM managed instance role trusts ssm and carries AmazonSSMManagedInstanceCore', () => {
    t.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: { Statement: [Match.objectLike({ Principal: { Service: 'ssm.amazonaws.com' } })], Version: '2012-10-17' },
      ManagedPolicyArns: [Match.objectLike({ 'Fn::Join': ['', Match.arrayWith([':iam::aws:policy/AmazonSSMManagedInstanceCore'])] })],
    });
  });

  test('traffic rate parameter exists (default 6); only the traffic role reads it, only that parameter', () => {
    t.hasResourceProperties('AWS::SSM::Parameter', { Name: '/harness/traffic/rate_per_min', Value: '6', Type: 'String' });
    const readers = Object.values(t.findResources('AWS::IAM::Policy')).filter((p) =>
      (p.Properties.PolicyDocument.Statement as any[]).some((s) => acts(s.Action).includes('ssm:GetParameter')),
    );
    expect(readers).toHaveLength(1);
    expect(JSON.stringify(readers[0].Properties.Roles)).toContain('TrafficTaskDefTaskRole');
    const st = (readers[0].Properties.PolicyDocument.Statement as any[]).find((s) => acts(s.Action).includes('ssm:GetParameter'));
    expect(st.Action).toBe('ssm:GetParameter');
    expect(JSON.stringify(st.Resource)).toContain('TrafficRateParam');
  });

  test('traffic container is told the parameter name', () => {
    const env = byFamilyPrefix(t, 'harness-traffic').Properties.ContainerDefinitions[0].Environment;
    expect(env).toContainEqual({ Name: 'RATE_PARAM_NAME', Value: '/harness/traffic/rate_per_min' });
  });
});
