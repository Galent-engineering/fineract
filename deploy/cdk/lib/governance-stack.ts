import * as cdk from 'aws-cdk-lib';
import * as fis from 'aws-cdk-lib/aws-fis';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as resiliencehub from 'aws-cdk-lib/aws-resiliencehub';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { AppStack } from './app-stack';
import { DataStack } from './data-stack';

export const READER_ROLE_NAME = 'harness-reliability-reader';
export const CONNECTOR_USER_NAME = 'harness-reliability-connector';
export const EXTERNAL_ID_SECRET = 'harness/reader/external-id';
export const ACCESS_KEY_SECRET = 'harness/reader/access-key';

export interface ReaderStatement { actions: string[]; resources: string[] }

/**
 * The reader role's whole policy: read/query/describe only, scoped to the harness wherever AWS supports
 * resource-level permissions. Still account-wide because the services have no resource-level support for
 * these actions: xray, cloudwatch, config, resource-explorer-2, resiliencehub, fis, elasticloadbalancing,
 * and the name-only listings (ecs ListClusters, logs DescribeLogGroups/GetQueryResults,
 * rds DescribeEvents/DescribeDBClusters and the unfiltered DescribeDBInstances).
 */
export function readerStatements(p: { account: string; region: string; partition: string; ampWorkspaceArn: string; dbArn: string }): ReaderStatement[] {
  const ecs = `arn:${p.partition}:ecs:${p.region}:${p.account}`;
  const logGroup = `arn:${p.partition}:logs:${p.region}:${p.account}:log-group:/harness*`;
  return [
    // AMP: the harness workspace only.
    { actions: ['aps:QueryMetrics', 'aps:GetSeries', 'aps:GetLabels', 'aps:GetMetricMetadata'], resources: [p.ampWorkspaceArn] },
    // Logs: /harness* log groups only. (An unscoped DescribeLogGroups / GetQueryResults reveals names and ids, not events.)
    { actions: ['logs:FilterLogEvents', 'logs:StartQuery', 'logs:DescribeLogStreams'], resources: [logGroup, `${logGroup}:*`] },
    { actions: ['logs:DescribeLogGroups', 'logs:GetQueryResults'], resources: ['*'] },
    // ECS: the two harness clusters. ecs:DescribeTaskDefinition is deliberately absent: it has no resource-level
    // support (IAM evaluates it on "*", verified live), and other workloads' task definitions carry plaintext
    // environment variables. Image, cpu and memory are still visible through DescribeServices/DescribeTasks.
    { actions: ['ecs:DescribeClusters', 'ecs:ListServices', 'ecs:ListTasks'], resources: [`${ecs}:cluster/harness`, `${ecs}:cluster/harness-obs`] },
    { actions: ['ecs:DescribeServices'], resources: [`${ecs}:service/harness/*`, `${ecs}:service/harness-obs/*`] },
    { actions: ['ecs:DescribeTasks'], resources: [`${ecs}:task/harness/*`, `${ecs}:task/harness-obs/*`] },
    { actions: ['ecs:ListClusters'], resources: ['*'] },
    // RDS: describe calls on "*" because the topology and RDS-probe adapters call them without an identifier (an
    // ARN-scoped grant denies that). Instance/cluster metadata only: no data access, no credentials. p.dbArn is kept
    // in the signature but no longer needed for scoping.
    { actions: ['rds:DescribeDBInstances', 'rds:DescribeDBClusters', 'rds:DescribeEvents'], resources: ['*'] },
    // No resource-level support: account-wide, read-only.
    {
      actions: [
        'xray:Get*', 'xray:BatchGet*',
        'cloudwatch:Get*', 'cloudwatch:List*', 'cloudwatch:Describe*',
        'config:Get*', 'config:List*', 'config:Select*', 'config:BatchGet*',
        'resource-explorer-2:Search', 'resource-explorer-2:Get*', 'resource-explorer-2:List*',
        'resiliencehub:Describe*', 'resiliencehub:List*',
        'fis:Get*', 'fis:List*',
        'elasticloadbalancing:Describe*',
      ],
      resources: ['*'],
    },
  ];
}

/** Config records only the harness's resource types (no global recording). */
export const RECORDED_TYPES = [
  // No AWS::ECS::TaskDefinition / AWS::IAM::Role: a Config item carries the full task-definition environment
  // (plaintext variables) and role policy documents for every workload in the shared account, readable through
  // config:Select* / GetResourceConfigHistory. The reader has no DescribeTaskDefinition for the same reason.
  'AWS::ECS::Service', 'AWS::ECS::Cluster',
  'AWS::RDS::DBInstance',
  'AWS::ElasticLoadBalancingV2::LoadBalancer', 'AWS::ElasticLoadBalancingV2::Listener',
  'AWS::ElasticLoadBalancingV2::TargetGroup',
  'AWS::EC2::SecurityGroup', 'AWS::EC2::VPC', 'AWS::EC2::Subnet',
];

export interface GovernanceStackProps extends cdk.StackProps {
  data: DataStack;
  app: AppStack;
}

/**
 * Governance + read-only access for the reliability product's connectors.
 *
 * Reused, not created here: the Resource Explorer index and default view that already exist in
 * us-east-1 in this account (verified 2026-11-14). The Config recorder is created here because the
 * account had none.
 */
export class GovernanceStack extends cdk.Stack {
  public readonly readerRole: iam.Role;

  constructor(scope: Construct, id: string, props: GovernanceStackProps) {
    super(scope, id, props);
    const { data, app } = props;

    // ---- Reader role + connector user ------------------------------------------------------
    // The external ID is a confused-deputy guard, not a credential; it is generated into Secrets
    // Manager (never in git) and resolved into the trust policy at deploy time via a dynamic
    // reference. Rotating the secret requires a redeploy of this stack to update the trust policy.
    const externalId = new secretsmanager.Secret(this, 'ExternalId', {
      secretName: EXTERNAL_ID_SECRET,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      generateSecretString: { passwordLength: 32, excludePunctuation: true },
    });

    const user = new iam.User(this, 'ConnectorUser', { userName: CONNECTOR_USER_NAME });

    this.readerRole = new iam.Role(this, 'ReaderRole', {
      roleName: READER_ROLE_NAME,
      assumedBy: new iam.ArnPrincipal(user.userArn).withConditions({
        StringEquals: { 'sts:ExternalId': externalId.secretValue.unsafeUnwrap() },
      }),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    for (const st of readerStatements({
      account: this.account, region: this.region, partition: this.partition,
      ampWorkspaceArn: app.ampWorkspace.attrArn, dbArn: data.db.instanceArn,
    })) {
      this.readerRole.addToPolicy(new iam.PolicyStatement(st));
    }

    user.addToPolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [this.readerRole.roleArn] }));

    const accessKey = new iam.AccessKey(this, 'ConnectorAccessKey', { user });
    new secretsmanager.Secret(this, 'AccessKeySecret', {
      secretName: ACCESS_KEY_SECRET,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      secretObjectValue: {
        access_key_id: cdk.SecretValue.unsafePlainText(accessKey.accessKeyId),
        secret_access_key: accessKey.secretAccessKey,
      },
    });

    new cdk.CfnOutput(this, 'ReaderRoleArn', { value: this.readerRole.roleArn });

    // ---- AWS Config (account had no recorder) ------------------------------------------------
    const configBucket = new s3.Bucket(this, 'ConfigBucket', {
      bucketName: `harness-config-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
    });
    const configRole = new iam.Role(this, 'ConfigRole', {
      assumedBy: new iam.ServicePrincipal('config.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWS_ConfigRole')],
    });
    configBucket.grantReadWrite(configRole);
    configBucket.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('config.amazonaws.com')],
      actions: ['s3:GetBucketAcl', 's3:ListBucket'],
      resources: [configBucket.bucketArn],
    }));
    configBucket.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('config.amazonaws.com')],
      actions: ['s3:PutObject'],
      resources: [configBucket.arnForObjects(`AWSLogs/${this.account}/Config/*`)],
      conditions: { StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control' } },
    }));

    // CFN's AWS::Config::ConfigurationRecorder failed to stabilise on first deploy (NotStabilized),
    // so the recorder, delivery channel and start are made with SDK calls instead.
    const sdk = (id: string, create: cdk.custom_resources.AwsSdkCall, del?: cdk.custom_resources.AwsSdkCall) =>
      new cdk.custom_resources.AwsCustomResource(this, id, {
        onCreate: create,
        onUpdate: create,
        onDelete: del,
        installLatestAwsSdk: false,
        policy: cdk.custom_resources.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: [
              'config:PutConfigurationRecorder', 'config:DeleteConfigurationRecorder',
              'config:PutDeliveryChannel', 'config:DeleteDeliveryChannel',
              'config:StartConfigurationRecorder', 'config:StopConfigurationRecorder',
              'config:DescribeConfigurationRecorders',
            ],
            resources: ['*'],
          }),
          new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [configRole.roleArn] }),
        ]),
      });
    const physical = (v: string) => cdk.custom_resources.PhysicalResourceId.of(v);
    const recorder = sdk('Recorder', {
      service: 'ConfigService',
      action: 'putConfigurationRecorder',
      parameters: {
        ConfigurationRecorder: {
          name: 'harness',
          roleARN: configRole.roleArn,
          recordingGroup: { allSupported: false, includeGlobalResourceTypes: false, resourceTypes: RECORDED_TYPES },
        },
      },
      physicalResourceId: physical('harness-recorder'),
    }, {
      service: 'ConfigService',
      action: 'deleteConfigurationRecorder',
      parameters: { ConfigurationRecorderName: 'harness' },
    });
    recorder.node.addDependency(configRole, configBucket);
    const channel = sdk('DeliveryChannel', {
      service: 'ConfigService',
      action: 'putDeliveryChannel',
      parameters: { DeliveryChannel: { name: 'harness', s3BucketName: configBucket.bucketName } },
      physicalResourceId: physical('harness-channel'),
    }, {
      service: 'ConfigService',
      action: 'deleteDeliveryChannel',
      parameters: { DeliveryChannelName: 'harness' },
    });
    channel.node.addDependency(recorder);
    const start = sdk('StartRecorder', {
      service: 'ConfigService',
      action: 'startConfigurationRecorder',
      parameters: { ConfigurationRecorderName: 'harness' },
      physicalResourceId: physical('harness-start'),
    }, {
      service: 'ConfigService',
      action: 'stopConfigurationRecorder',
      parameters: { ConfigurationRecorderName: 'harness' },
    });
    start.node.addDependency(channel);

    // ---- Resilience Hub -----------------------------------------------------------------------
    const policy = new resiliencehub.CfnResiliencyPolicy(this, 'ResiliencyPolicy', {
      policyName: 'fineract-harness-15m-rto-5m-rpo',
      tier: 'Important',
      policy: {
        AZ: { rtoInSecs: 900, rpoInSecs: 300 },
        Hardware: { rtoInSecs: 900, rpoInSecs: 300 },
        Software: { rtoInSecs: 900, rpoInSecs: 300 },
        Region: { rtoInSecs: 900, rpoInSecs: 300 },
      },
    });

    const logicalIn = (stack: cdk.Stack, res: Construct) => ({
      identifier: stack.getLogicalId(res.node.defaultChild as cdk.CfnElement),
      logicalStackName: stack.stackName,
    });
    const rhApp = new resiliencehub.CfnApp(this, 'ResilienceApp', {
      name: 'fineract-harness',
      resiliencyPolicyArn: policy.attrPolicyArn,
      appTemplateBody: JSON.stringify({
        version: 2,
        resources: [
          { logicalResourceId: logicalIn(app, app.fineractService), type: 'AWS::ECS::Service', name: 'fineract-service' },
          { logicalResourceId: logicalIn(data, data.db), type: 'AWS::RDS::DBInstance', name: 'fineract-db' },
        ],
        appComponents: [
          { name: 'fineract-service', type: 'AWS::ResilienceHub::ComputeAppComponent', resourceNames: ['fineract-service'] },
          { name: 'fineract-db', type: 'AWS::ResilienceHub::DatabaseAppComponent', resourceNames: ['fineract-db'] },
        ],
        excludedResources: {},
      }),
      resourceMappings: [app, data].map((s) => ({
        mappingType: 'CfnStack',
        logicalStackName: s.stackName,
        physicalResourceId: { type: 'Arn', identifier: s.stackId },
      })),
    });
    rhApp.addDependency(policy);

    // ---- Fault Injection Service: templates only; no experiment is ever started here --------------
    const fisRole = new iam.Role(this, 'FisRole', {
      roleName: 'harness-fis',
      assumedBy: new iam.PrincipalWithConditions(new iam.ServicePrincipal('fis.amazonaws.com'), {
        StringEquals: { 'aws:SourceAccount': this.account },
        ArnLike: { 'aws:SourceArn': `arn:${this.partition}:fis:${this.region}:${this.account}:experiment/*` },
      }),
    });
    const taskArns = `arn:${this.partition}:ecs:${this.region}:${this.account}:task/harness/*`;
    fisRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecs:StopTask', 'ecs:DescribeTasks'],
      resources: [taskArns],
    }));
    fisRole.addToPolicy(new iam.PolicyStatement({ actions: ['ecs:ListTasks'], resources: ['*'] }));
    fisRole.addToPolicy(new iam.PolicyStatement({
      actions: ['rds:RebootDBInstance'],
      resources: [data.db.instanceArn],
    }));
    fisRole.addToPolicy(new iam.PolicyStatement({ actions: ['rds:DescribeDBInstances'], resources: ['*'] }));

    new fis.CfnExperimentTemplate(this, 'StopFineractTask', {
      description: 'Stop one running Fineract task (harness/fineract) to exercise ECS recovery',
      roleArn: fisRole.roleArn,
      stopConditions: [{ source: 'none' }],
      tags: { Name: 'stop-fineract-task' },
      targets: {
        fineractTasks: {
          resourceType: 'aws:ecs:task',
          selectionMode: 'COUNT(1)',
          parameters: { cluster: 'harness', service: 'fineract' },
        },
      },
      actions: {
        stopTask: { actionId: 'aws:ecs:stop-task', targets: { Tasks: 'fineractTasks' } },
      },
    });
    new fis.CfnExperimentTemplate(this, 'RdsReboot', {
      description: 'Reboot the harness RDS instance',
      roleArn: fisRole.roleArn,
      stopConditions: [{ source: 'none' }],
      tags: { Name: 'rds-reboot' },
      targets: {
        db: { resourceType: 'aws:rds:db', selectionMode: 'ALL', resourceArns: [data.db.instanceArn] },
      },
      actions: {
        reboot: { actionId: 'aws:rds:reboot-db-instances', targets: { DBInstances: 'db' }, parameters: { forceFailover: 'false' } },
      },
    });
  }
}
