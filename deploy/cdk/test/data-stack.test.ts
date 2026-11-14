import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { loadHarnessConfig } from '../lib/config';
import { DataStack } from '../lib/data-stack';

const CIDRS = ['203.0.113.7/32', '198.51.100.9/32'];

const synth = (allowedCidrs: string = CIDRS.join(',')) => {
  const app = new cdk.App({ context: { allowedCidrs, fineractImageTag: 'abc123' } });
  const config = loadHarnessConfig(app);
  const stack = new DataStack(app, 'HarnessData', {
    env: { account: '111111111111', region: 'us-east-1' },
    allowedCidrs: config.allowedCidrs,
  });
  return { stack, template: Template.fromStack(stack) };
};

const sgByDesc = (t: Template, fragment: string) => {
  const all = t.findResources('AWS::EC2::SecurityGroup');
  const entry = Object.entries(all).find(([, r]) => String(r.Properties.GroupDescription).includes(fragment));
  if (!entry) throw new Error(`no SG with description containing ${fragment}`);
  return entry;
};

describe('DataStack', () => {
  test('all harness secrets are deleted with the stack', () => {
    const { template } = synth();
    const secrets = template.findResources('AWS::SecretsManager::Secret');
    expect(Object.keys(secrets).length).toBeGreaterThanOrEqual(3);
    for (const r of Object.values(secrets)) expect((r as any).DeletionPolicy).toBe('Delete');
  });

  test('no NAT gateways, public subnets only, 2 AZs', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    const subnets = template.findResources('AWS::EC2::Subnet');
    expect(Object.keys(subnets)).toHaveLength(2);
    for (const s of Object.values(subnets)) expect(s.Properties.MapPublicIpOnLaunch).toBe(true);
  });

  test('albSg port 80 ingress is exactly the context CIDRs', () => {
    const { template } = synth();
    const [, sg] = sgByDesc(template, 'ALB');
    const ing = (sg.Properties.SecurityGroupIngress as any[]).filter((i) => i.FromPort === 80);
    expect(ing.map((i) => i.CidrIp).sort()).toEqual([...CIDRS].sort());
    for (const i of ing) expect(i.ToPort).toBe(80);
  });

  test('dbSg 5432 ingress is the context CIDRs plus tasksSg', () => {
    const { template } = synth();
    const [dbId, sg] = sgByDesc(template, 'RDS');
    const ing = sg.Properties.SecurityGroupIngress as any[];
    expect(ing.map((i) => i.CidrIp).sort()).toEqual([...CIDRS].sort());
    for (const i of ing) expect(i.FromPort).toBe(5432);
    const [tasksId] = sgByDesc(template, 'tasks');
    const sgRules = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress')).filter(
      (r: any) => r.Properties.GroupId?.['Fn::GetAtt']?.[0] === dbId,
    ) as any[];
    expect(sgRules).toHaveLength(1);
    expect(sgRules[0].Properties.SourceSecurityGroupId['Fn::GetAtt'][0]).toBe(tasksId);
    expect(sgRules[0].Properties.FromPort).toBe(5432);
  });

  test('RDS is PostgreSQL 18, public, encrypted, snapshot on delete', () => {
    const { template } = synth();
    template.hasResource('AWS::RDS::DBInstance', {
      Properties: Match.objectLike({
        Engine: 'postgres',
        EngineVersion: Match.stringLikeRegexp('^18\\.'),
        DBInstanceClass: 'db.t4g.small',
        PubliclyAccessible: true,
        StorageEncrypted: true,
        DeletionProtection: false,
        MultiAZ: false,
        AllocatedStorage: '20',
        StorageType: 'gp3',
        BackupRetentionPeriod: 1,
      }),
      DeletionPolicy: 'Snapshot',
    });
  });

  test('secrets exist with the expected names and reader username', () => {
    const { template } = synth();
    for (const name of ['harness/db/admin', 'harness/db/reader', 'harness/db/fineract']) {
      template.hasResourceProperties('AWS::SecretsManager::Secret', { Name: name });
    }
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'harness/db/reader',
      GenerateSecretString: Match.objectLike({
        SecretStringTemplate: JSON.stringify({ username: 'reliability_reader' }),
      }),
    });
  });

  test('Cloud Map namespace harness.local', () => {
    synth().template.hasResourceProperties('AWS::ServiceDiscovery::PrivateDnsNamespace', {
      Name: 'harness.local',
    });
  });

  test('synth with 0.0.0.0/0 throws', () => {
    expect(() => synth('0.0.0.0/0')).toThrow(/open CIDR not allowed/);
    expect(() => synth('203.0.113.7/32,0.0.0.0/0')).toThrow(/open CIDR not allowed/);
  });
});
