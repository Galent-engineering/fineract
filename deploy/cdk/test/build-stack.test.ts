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

  const BRANCH_SUB = 'repo:Galent-engineering@219138393/fineract@1456802084:ref:refs/heads/galent/reliability-harness';

  test('deploy role (harness-github-deploy) has the same immutable branch-pinned trust', () => {
    synth().hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'harness-github-deploy',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub': BRANCH_SUB,
              },
            },
          }),
        ]),
      }),
    });
  });

  // statements attached to the role whose RoleName is `name`
  const statementsFor = (t: Template, name: string) => {
    const roleId = Object.entries(t.findResources('AWS::IAM::Role')).find(([, r]: any) => r.Properties.RoleName === name)![0];
    return Object.values(t.findResources('AWS::IAM::Policy'))
      .filter((p: any) => (p.Properties.Roles ?? []).some((r: any) => r.Ref === roleId))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
  };
  const actionsOf = (stmts: any[]) => stmts.flatMap((s: any) => ([] as string[]).concat(s.Action));

  test('both repos scan on push, expire untagged after 7 days and keep 30 images', () => {
    const t = synth();
    t.resourceCountIs('AWS::ECR::Repository', 2);
    for (const name of ['harness/fineract', 'harness/traffic']) {
      t.hasResourceProperties('AWS::ECR::Repository', {
        RepositoryName: name,
        ImageScanningConfiguration: { ScanOnPush: true },
        LifecyclePolicy: {
          LifecyclePolicyText: Match.stringLikeRegexp('"countNumber":30'),
        },
      });
    }
    const repos = Object.values(t.findResources('AWS::ECR::Repository')) as any[];
    for (const r of repos) {
      const rules = JSON.parse(r.Properties.LifecyclePolicy.LifecyclePolicyText).rules;
      const untagged = rules.find((x: any) => x.selection.tagStatus === 'untagged');
      expect(untagged.selection).toMatchObject({ countType: 'sinceImagePushed', countUnit: 'days', countNumber: 7 });
      const any = rules.find((x: any) => x.selection.tagStatus === 'any');
      expect(any.selection.countNumber).toBe(30);
      expect(untagged.rulePriority).toBeLessThan(any.rulePriority);
    }
  });

  test('CI (build) role holds ECR push/pull only: no assume-role, no ECS, no IAM', () => {
    const acts = actionsOf(statementsFor(synth(), 'harness-github-ci'));
    expect(acts.length).toBeGreaterThan(0);
    for (const a of acts) expect(a).toMatch(/^ecr:/);
    expect(acts).toContain('ecr:PutImage');
    expect(acts).toContain('ecr:GetAuthorizationToken');
  });

  test('deploy role may only assume the CDK bootstrap roles and read ECS services (no wildcards, no ECR)', () => {
    const stmts = statementsFor(synth(), 'harness-github-deploy');
    const assume = stmts.find((s: any) => ([] as string[]).concat(s.Action).includes('sts:AssumeRole'));
    expect(assume.Resource).toHaveLength(4);
    for (const r of assume.Resource) expect(JSON.stringify(r)).toMatch(/cdk-hnb659fds-(deploy|file-publishing|image-publishing|lookup)-role-/);
    const acts = actionsOf(stmts);
    expect(acts.sort()).toEqual(['ecs:DescribeServices', 'sts:AssumeRole']);
  });
});
