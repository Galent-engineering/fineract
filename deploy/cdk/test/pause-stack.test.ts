import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DataStack } from '../lib/data-stack';
import { PauseStack } from '../lib/pause-stack';

const synth = () => {
  const app = new cdk.App();
  const env = { account: '111111111111', region: 'us-east-1' };
  const data = new DataStack(app, 'HarnessData', { env, allowedCidrs: ['203.0.113.7/32'] });
  return Template.fromStack(new PauseStack(app, 'HarnessPause', { env, data }));
};

describe('PauseStack', () => {
  const t = synth();

  test('EventBridge rule on aws.rds RDS-EVENT-0154 for the harness instance targets the lambda', () => {
    const rules = Object.values(t.findResources('AWS::Events::Rule')) as any[];
    expect(rules).toHaveLength(1);
    const p = rules[0].Properties;
    expect(p.EventPattern.source).toEqual(['aws.rds']);
    expect(p.EventPattern.detail.EventID).toEqual(['RDS-EVENT-0154']);
    expect(JSON.stringify(p.EventPattern.detail.SourceIdentifier)).toContain('HarnessData');
    expect(JSON.stringify(p.Targets[0].Arn)).toContain('Fn::GetAtt');
  });

  test('lambda is python3.12 and permits EventBridge', () => {
    t.hasResourceProperties('AWS::Lambda::Function', { Runtime: 'python3.12', Handler: 'restop_rds.handler' });
    t.hasResourceProperties('AWS::Lambda::Permission', { Principal: 'events.amazonaws.com' });
  });

  test('IAM is least privilege: stop/describe on the instance ARN, ssm:GetParameter on /harness/paused', () => {
    const stmts = Object.values(t.findResources('AWS::IAM::Policy')).flatMap((p: any) => p.Properties.PolicyDocument.Statement);
    const rds = stmts.find((s: any) => ([] as any[]).concat(s.Action).includes('rds:StopDBInstance'));
    expect(([] as any[]).concat(rds.Action).sort()).toEqual(['rds:DescribeDBInstances', 'rds:StopDBInstance']);
    expect(JSON.stringify(rds.Resource)).not.toBe('"*"');
    const ssm = stmts.find((s: any) => ([] as any[]).concat(s.Action).includes('ssm:GetParameter'));
    expect(ssm.Action).toBe('ssm:GetParameter');
    expect(JSON.stringify(ssm.Resource)).toContain('PausedBC22E7EB');
  });

  test('paused parameter exists with initial value false', () => {
    t.hasResourceProperties('AWS::SSM::Parameter', { Name: '/harness/paused', Value: 'false' });
  });

  test('outputs the DB identifier for the scripts', () => {
    t.hasOutput('DbInstanceIdentifier', Match.anyValue());
  });
});
