import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { DataStack } from './data-stack';
import {
  FINERACT_CONTEXT,
  FINERACT_PORT,
  TENANTS_DB,
  TENANT_DEFAULT_DB,
  fineractEnvironment,
} from './fineract-env';

export interface AppStackProps extends cdk.StackProps {
  data: DataStack;
  fineractRepo: ecr.IRepository;
  fineractImageTag: string;
  /** 0 until db-init has run once, then 1. Context `fineractDesiredCount` overrides the default of 1. */
  fineractDesiredCount?: number;
}

export class AppStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly fineractService: ecs.FargateService;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly listener: elbv2.ApplicationListener;
  public readonly fineractAdminSecret: secretsmanager.Secret;
  public readonly dbInitTaskDef: ecs.FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { data } = props;

    this.cluster = new ecs.Cluster(this, 'Cluster', { clusterName: 'harness', vpc: data.vpc });

    // Rotated into Fineract by Task 8; username matches the spec.
    this.fineractAdminSecret = new secretsmanager.Secret(this, 'FineractAdminSecret', {
      secretName: 'harness/fineract/admin',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'harness_admin' }),
        generateStringKey: 'password',
        passwordLength: 32,
        excludePunctuation: true,
      },
    });
    // Replaces Fineract's default tenant master password ("fineract").
    const masterSecret = new secretsmanager.Secret(this, 'FineractMasterSecret', {
      secretName: 'harness/fineract/master',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      generateSecretString: { passwordLength: 32, excludePunctuation: true },
    });

    const dbHost = data.db.dbInstanceEndpointAddress;
    const pw = (s: secretsmanager.ISecret, field: string) => ecs.Secret.fromSecretsManager(s, field);

    // ---- One-off db-init task (run via `aws ecs run-task` before the service first starts) ----
    this.dbInitTaskDef = new ecs.FargateTaskDefinition(this, 'DbInitTaskDef', {
      family: 'harness-dbinit',
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    // Mirrors config/docker/postgresql/docker-entrypoint-initdb.d/01-init.sh (1.16.1), made idempotent.
    const dbInitScript = [
      'set -e',
      `psql -v ON_ERROR_STOP=1 -d postgres <<EOSQL`,
      `SELECT 'CREATE ROLE "$FU" LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='$FU') \\gexec`,
      `ALTER ROLE "$FU" WITH PASSWORD '$FP';`,
      `GRANT "$FU" TO CURRENT_USER;`,
      `SELECT 'CREATE DATABASE ${TENANTS_DB} OWNER "$FU"' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='${TENANTS_DB}') \\gexec`,
      `SELECT 'CREATE DATABASE ${TENANT_DEFAULT_DB} OWNER "$FU"' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='${TENANT_DEFAULT_DB}') \\gexec`,
      `GRANT ALL PRIVILEGES ON DATABASE ${TENANTS_DB} TO "$FU";`,
      `GRANT ALL PRIVILEGES ON DATABASE ${TENANT_DEFAULT_DB} TO "$FU";`,
      `EOSQL`,
      `echo db-init complete`,
    ].join('\n');
    this.dbInitTaskDef.addContainer('dbinit', {
      image: ecs.ContainerImage.fromRegistry('postgres:18'),
      entryPoint: ['/bin/bash', '-c'],
      command: [dbInitScript],
      environment: { PGHOST: dbHost, PGPORT: '5432', PGDATABASE: 'postgres', PGSSLMODE: 'require' },
      secrets: {
        PGUSER: pw(data.dbAdminSecret, 'username'),
        PGPASSWORD: pw(data.dbAdminSecret, 'password'),
        FU: pw(data.fineractDbSecret, 'username'),
        FP: pw(data.fineractDbSecret, 'password'),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'dbinit', logRetention: logs.RetentionDays.ONE_WEEK }),
    });

    // ---- Fineract service ----
    const taskDef = new ecs.FargateTaskDefinition(this, 'FineractTaskDef', {
      family: 'harness-fineract',
      cpu: 2048,
      memoryLimitMiB: 8192,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    taskDef.addContainer('fineract', {
      image: ecs.ContainerImage.fromEcrRepository(props.fineractRepo, props.fineractImageTag),
      portMappings: [{ containerPort: FINERACT_PORT }],
      environment: fineractEnvironment(dbHost),
      secrets: {
        FINERACT_HIKARI_USERNAME: pw(data.fineractDbSecret, 'username'),
        FINERACT_HIKARI_PASSWORD: pw(data.fineractDbSecret, 'password'),
        FINERACT_DEFAULT_TENANTDB_UID: pw(data.fineractDbSecret, 'username'),
        FINERACT_DEFAULT_TENANTDB_PWD: pw(data.fineractDbSecret, 'password'),
        FINERACT_DEFAULT_TENANTDB_MASTER_PASSWORD: ecs.Secret.fromSecretsManager(masterSecret),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'fineract', logRetention: logs.RetentionDays.TWO_WEEKS }),
    });

    const desired =
      props.fineractDesiredCount ?? Number(this.node.tryGetContext('fineractDesiredCount') ?? 1);
    this.fineractService = new ecs.FargateService(this, 'FineractService', {
      serviceName: 'fineract',
      cluster: this.cluster,
      taskDefinition: taskDef,
      desiredCount: desired,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [data.tasksSg],
      healthCheckGracePeriod: cdk.Duration.seconds(900),
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
    });

    // tasksSg ingress only from albSg on the container port (CfnSecurityGroupIngress avoids a Data<->App cycle).
    new ec2.CfnSecurityGroupIngress(this, 'AlbToTasks', {
      groupId: data.tasksSg.securityGroupId,
      sourceSecurityGroupId: data.albSg.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: FINERACT_PORT,
      toPort: FINERACT_PORT,
      description: 'ALB to Fineract',
    });

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: data.vpc,
      internetFacing: true,
      securityGroup: data.albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
    this.listener = this.alb.addListener('Http', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'not found',
      }),
    });
    const tg = new elbv2.ApplicationTargetGroup(this, 'FineractTg', {
      vpc: data.vpc,
      port: FINERACT_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targets: [this.fineractService],
      healthCheck: {
        path: `${FINERACT_CONTEXT}/actuator/health/readiness`,
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });
    this.listener.addAction('Fineract', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns([`${FINERACT_CONTEXT}/*`])],
      action: elbv2.ListenerAction.forward([tg]),
    });

    new cdk.CfnOutput(this, 'AlbDnsName', { value: this.alb.loadBalancerDnsName });
  }
}
