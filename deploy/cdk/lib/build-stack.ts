import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

const GITHUB_REPO = 'Galent-engineering/fineract';
const GITHUB_BRANCH = 'galent/reliability-harness';

export class BuildStack extends cdk.Stack {
  public readonly fineractRepo: ecr.Repository;
  public readonly trafficRepo: ecr.Repository;
  public readonly ciRole: iam.Role;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const mkRepo = (logicalId: string, name: string) =>
      new ecr.Repository(this, logicalId, {
        repositoryName: name,
        imageScanOnPush: true,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        emptyOnDelete: true,
        lifecycleRules: [{ maxImageCount: 10 }],
      });
    this.fineractRepo = mkRepo('FineractRepo', 'harness/fineract');
    this.trafficRepo = mkRepo('TrafficRepo', 'harness/traffic');

    // The account had no GitHub OIDC provider (checked with list-open-id-connect-providers).
    const provider = new iam.CfnOIDCProvider(this, 'GithubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIdList: ['sts.amazonaws.com'],
      thumbprintList: ['6938fd4d98bab03faadb97b34396831e3780aea1'],
    });

    this.ciRole = new iam.Role(this, 'CiRole', {
      roleName: 'harness-github-ci',
      assumedBy: new iam.FederatedPrincipal(
        provider.attrArn,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': `repo:${GITHUB_REPO}:ref:refs/heads/${GITHUB_BRANCH}`,
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      maxSessionDuration: cdk.Duration.hours(1),
    });

    this.fineractRepo.grantPullPush(this.ciRole);
    this.trafficRepo.grantPullPush(this.ciRole);

    this.ciRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:UpdateService', 'ecs:DescribeServices'],
        resources: [`arn:${this.partition}:ecs:${this.region}:${this.account}:service/harness/*`],
      }),
    );
  }
}
