import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

// Org uses immutable OIDC subject claims (owner/repo ids), not names.
const GITHUB_SUB_PREFIX = 'repo:Galent-engineering@219138393/fineract@1456802084';
const GITHUB_BRANCH = 'galent/reliability-harness';
const DEPLOY_ENVIRONMENT = 'harness-deploy';

export class BuildStack extends cdk.Stack {
  public readonly fineractRepo: ecr.Repository;
  public readonly trafficRepo: ecr.Repository;
  public readonly ciRole: iam.Role;
  public readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const mkRepo = (logicalId: string, name: string) =>
      new ecr.Repository(this, logicalId, {
        repositoryName: name,
        imageScanOnPush: true,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        emptyOnDelete: true,
        // Untagged manifests (old attestations, superseded pushes) go after 7 days; the newest 30 images
        // stay so the deployed sha tag cannot expire while a task still needs to pull it.
        lifecycleRules: [
          { rulePriority: 1, tagStatus: ecr.TagStatus.UNTAGGED, maxImageAge: cdk.Duration.days(7) },
          { rulePriority: 2, tagStatus: ecr.TagStatus.ANY, maxImageCount: 30 },
        ],
      });
    this.fineractRepo = mkRepo('FineractRepo', 'harness/fineract');
    this.trafficRepo = mkRepo('TrafficRepo', 'harness/traffic');

    // The account had no GitHub OIDC provider (checked with list-open-id-connect-providers).
    const provider = new iam.CfnOIDCProvider(this, 'GithubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIdList: ['sts.amazonaws.com'],
      thumbprintList: ['6938fd4d98bab03faadb97b34396831e3780aea1'],
    });

    const githubTrust = (sub: string) =>
      new iam.FederatedPrincipal(
        provider.attrArn,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': sub,
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      );

    // Build job (Gradle, Maven dependencies, docker): ECR push/pull only.
    this.ciRole = new iam.Role(this, 'CiRole', {
      roleName: 'harness-github-ci',
      assumedBy: githubTrust(`${GITHUB_SUB_PREFIX}:ref:refs/heads/${GITHUB_BRANCH}`),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    // Deploy job (cdk + npm): separate role, trusted only for tokens of the `harness-deploy` GitHub environment
    // (the deploy job declares it), so a token minted in the build job cannot assume it.
    this.deployRole = new iam.Role(this, 'DeployRole', {
      roleName: 'harness-github-deploy',
      assumedBy: githubTrust(`${GITHUB_SUB_PREFIX}:environment:${DEPLOY_ENVIRONMENT}`),
      maxSessionDuration: cdk.Duration.hours(1),
    });

    this.fineractRepo.grantPullPush(this.ciRole);
    this.trafficRepo.grantPullPush(this.ciRole);

    // Deploy: the deploy role only assumes the CDK bootstrap roles (the CFN execution role does the
    // actual changes; it is broad by default, accepted for the dev account) and reads ECS service
    // state for `aws ecs wait services-stable`. No UpdateService: CDK rolls the task definition.
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: ['deploy', 'file-publishing', 'image-publishing', 'lookup'].map(
          (r) => `arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-${r}-role-${this.account}-${this.region}`,
        ),
      }),
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:DescribeServices'],
        resources: [`arn:${this.partition}:ecs:${this.region}:${this.account}:service/harness/*`],
      }),
    );
  }
}
