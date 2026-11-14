import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { BuildStack } from '../lib/build-stack';

const synth = () => {
  const app = new cdk.App();
  const stack = new BuildStack(app, 'HarnessBuild', { env: { account: '111111111111', region: 'us-east-1' } });
  return Template.fromStack(stack);
};

describe('BuildStack', () => {
  test('CI role trusts only the harness branch', () => {
    synth().hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'harness-github-ci',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              StringEquals: Match.objectLike({
                'token.actions.githubusercontent.com:sub':
                  'repo:Galent-engineering@219138393/fineract@1456802084:ref:refs/heads/galent/reliability-harness',
              }),
            }),
          }),
        ]),
      }),
    });
  });

  test('both repos scan on push and keep 10 images', () => {
    const t = synth();
    t.resourceCountIs('AWS::ECR::Repository', 2);
    for (const name of ['harness/fineract', 'harness/traffic']) {
      t.hasResourceProperties('AWS::ECR::Repository', {
        RepositoryName: name,
        ImageScanningConfiguration: { ScanOnPush: true },
        LifecyclePolicy: { LifecyclePolicyText: Match.stringLikeRegexp('"countNumber":10') },
      });
    }
  });

  test('CI role may only assume the CDK bootstrap roles and read ECS services (no wildcards)', () => {
    const policies = synth().findResources('AWS::IAM::Policy');
    const stmts = Object.values(policies).flatMap((p: any) => p.Properties.PolicyDocument.Statement);
    const assume = stmts.find((s: any) => ([] as string[]).concat(s.Action).includes('sts:AssumeRole'));
    expect(assume.Resource).toHaveLength(4);
    for (const r of assume.Resource) expect(JSON.stringify(r)).toMatch(/cdk-hnb659fds-(deploy|file-publishing|image-publishing|lookup)-role-/);
    for (const s of stmts) {
      for (const a of ([] as string[]).concat(s.Action)) {
        expect(a).not.toBe('*');
        expect(a).not.toMatch(/^iam:/);
        expect(a).not.toBe('ecs:UpdateService');
      }
    }
  });
});
