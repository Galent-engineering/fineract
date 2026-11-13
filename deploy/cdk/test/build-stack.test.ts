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
                  'repo:Galent-engineering/fineract:ref:refs/heads/galent/reliability-harness',
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
});
