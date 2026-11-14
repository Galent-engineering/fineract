import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as aps from 'aws-cdk-lib/aws-aps';
import * as fs from 'fs';
import * as path from 'path';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { DataStack } from './data-stack';
import { DnsStack, HARNESS_DOMAIN } from './dns-stack';
import {
  FINERACT_CONTEXT,
  FINERACT_PORT,
  TENANTS_DB,
  TENANT_DEFAULT_DB,
  fineractEnvironment,
  substituteToken,
} from './fineract-env';

/**
 * Mifos web app. Docker Hub has no 1.15.x/1.16.x tag (only `1.14`, amd64-only, plus `dev*`/`master*`);
 * pinned by digest so the mutable tag cannot drift. Recorded 2026-11-13.
 */
export const WEBAPP_IMAGE =
  'openmf/web-app:1.14@sha256:3a6c14ee8e5be90169ab2f7418035f6bab027d6b44dd8dfb0237560a47f69551';
const WEBAPP_PORT = 80;

/** Telemetry sidecar images, pinned 2026-11-13. */
export const ADOT_IMAGE = 'public.ecr.aws/aws-observability/aws-otel-collector:v0.51.0';
export const FLUENT_BIT_IMAGE = 'public.ecr.aws/aws-observability/aws-for-fluent-bit:3.5.7';
/**
 * Fineract 1.16.1 ships no micrometer-tracing/OTel bridge (only micrometer-registry-otlp for metrics), so
 * the FINERACT_MANAGEMENT_TRACIING_ENABLED / MANAGEMENT_OTLP_TRACING_* settings produce no spans.
 * Spans come from the ADOT Java agent, copied into a shared volume by an init container and attached via
 * JAVA_TOOL_OPTIONS (no Fineract source change).
 */
export const ADOT_JAVA_AGENT_IMAGE = 'public.ecr.aws/aws-observability/adot-autoinstrumentation-java:v2.33.0';
const SIDECAR_CONFIG_WRITER_IMAGE = 'busybox:1.37.0';
const readConfig = (file: string): string => fs.readFileSync(path.join(__dirname, '..', 'config', file), 'utf8');

export interface AppStackProps extends cdk.StackProps {
  data: DataStack;
  dns: DnsStack;
  fineractRepo: ecr.IRepository;
  fineractImageTag: string;
  /** 0 until db-init has run once, then 1. Context `fineractDesiredCount` overrides the default of 1. */
  fineractDesiredCount?: number;
}

export class AppStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly fineractService: ecs.FargateService;
  public readonly webappService: ecs.FargateService;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly listener: elbv2.ApplicationListener;
  public readonly httpListener: elbv2.ApplicationListener;
  public readonly fineractAdminSecret: secretsmanager.Secret;
  public readonly dbInitTaskDef: ecs.FargateTaskDefinition;
  /** Created here (not in ObsStack) because Fineract's task needs it and ObsStack depends on this stack. */
  public readonly ampWorkspace: aps.CfnWorkspace;

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
    this.ampWorkspace = new aps.CfnWorkspace(this, 'AmpWorkspace', { alias: 'harness' });
    const fineractLogGroup = new logs.LogGroup(this, 'FineractLogGroup', {
      logGroupName: '/harness/fineract',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ['aps:RemoteWrite'], resources: [this.ampWorkspace.attrArn] }),
    );
    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
          'xray:GetSamplingRules',
          'xray:GetSamplingTargets',
          'xray:GetSamplingStatisticSummaries',
        ],
        resources: ['*'],
      }),
    );
    fineractLogGroup.grantWrite(taskDef.taskRole);

    taskDef.addVolume({ name: 'otel' });
    const fineractContainer = taskDef.addContainer('fineract', {
      image: ecs.ContainerImage.fromEcrRepository(props.fineractRepo, props.fineractImageTag),
      portMappings: [{ containerPort: FINERACT_PORT }],
      environment: {
        ...fineractEnvironment(dbHost),
        JAVA_TOOL_OPTIONS: '-Xmx5g -javaagent:/otel/javaagent.jar',
        OTEL_SERVICE_NAME: 'fineract',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
        OTEL_TRACES_SAMPLER: 'always_on',
        OTEL_METRICS_EXPORTER: 'none',
        OTEL_LOGS_EXPORTER: 'none',
        OTEL_AWS_APPLICATION_SIGNALS_ENABLED: 'false',
      },
      secrets: {
        FINERACT_HIKARI_USERNAME: pw(data.fineractDbSecret, 'username'),
        FINERACT_HIKARI_PASSWORD: pw(data.fineractDbSecret, 'password'),
        FINERACT_DEFAULT_TENANTDB_UID: pw(data.fineractDbSecret, 'username'),
        FINERACT_DEFAULT_TENANTDB_PWD: pw(data.fineractDbSecret, 'password'),
        FINERACT_DEFAULT_TENANTDB_MASTER_PASSWORD: ecs.Secret.fromSecretsManager(masterSecret),
      },
      logging: ecs.LogDrivers.firelens({ options: {} }),
    });
    const otelInit = taskDef.addContainer('otel_agent_init', {
      image: ecs.ContainerImage.fromRegistry(ADOT_JAVA_AGENT_IMAGE),
      essential: false,
      command: ['cp', '/javaagent.jar', '/otel/javaagent.jar'],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'otel-agent-init', logRetention: logs.RetentionDays.ONE_WEEK }),
    });
    otelInit.addMountPoints({ containerPath: '/otel', sourceVolume: 'otel', readOnly: false });

    fineractContainer.addMountPoints({ containerPath: '/otel', sourceVolume: 'otel', readOnly: true });
    fineractContainer.addContainerDependencies({ container: otelInit, condition: ecs.ContainerDependencyCondition.SUCCESS });

    // ADOT: scrapes Prometheus -> AMP (SigV4); OTLP :4318 -> X-Ray + Tempo.
    taskDef.addContainer('adot', {
      image: ecs.ContainerImage.fromRegistry(ADOT_IMAGE),
      essential: false,
      environment: {
        AOT_CONFIG_CONTENT: substituteToken(
          readConfig('adot-collector.yaml'),
          '__AMP_ENDPOINT__',
          this.ampWorkspace.attrPrometheusEndpoint,
        ),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'adot', logRetention: logs.RetentionDays.ONE_WEEK }),
    });

    // FireLens log router: custom fluent-bit config written to a shared volume by a one-shot init.
    taskDef.addVolume({ name: 'fbcfg' });
    const fbInit = taskDef.addContainer('fb_config_init', {
      image: ecs.ContainerImage.fromRegistry(SIDECAR_CONFIG_WRITER_IMAGE),
      essential: false,
      entryPoint: ['/bin/sh', '-c'],
      command: ['printf "%s" "$FLUENT_BIT_CONF" > /fbcfg/fluent-bit.conf && chmod a+r /fbcfg/fluent-bit.conf'],
      environment: { FLUENT_BIT_CONF: readConfig('fluent-bit.conf') },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'fb-config-init', logRetention: logs.RetentionDays.ONE_WEEK }),
    });
    fbInit.addMountPoints({ containerPath: '/fbcfg', sourceVolume: 'fbcfg', readOnly: false });
    const router = taskDef.addFirelensLogRouter('log_router', {
      image: ecs.ContainerImage.fromRegistry(FLUENT_BIT_IMAGE),
      firelensConfig: {
        type: ecs.FirelensLogRouterType.FLUENTBIT,
        options: {
          enableECSLogMetadata: false,
          configFileType: ecs.FirelensConfigFileType.FILE,
          configFileValue: '/fbcfg/fluent-bit.conf',
        },
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'log-router', logRetention: logs.RetentionDays.ONE_WEEK }),
    });
    router.addMountPoints({ containerPath: '/fbcfg', sourceVolume: 'fbcfg', readOnly: true });
    router.addContainerDependencies({ container: fbInit, condition: ecs.ContainerDependencyCondition.SUCCESS });

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
    // HTTP only redirects to HTTPS; all routing lives on the 443 listener.
    this.httpListener = this.alb.addListener('Http', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: elbv2.ApplicationProtocol.HTTPS,
        port: '443',
        permanent: true,
      }),
    });

    // ---- Mifos web app: ALB default route on the HTTPS listener ----
    const webTaskDef = new ecs.FargateTaskDefinition(this, 'WebappTaskDef', {
      family: 'harness-webapp',
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    const apiUrl = `https://${HARNESS_DOMAIN}`;
    webTaskDef.addContainer('webapp', {
      image: ecs.ContainerImage.fromRegistry(WEBAPP_IMAGE),
      portMappings: [{ containerPort: WEBAPP_PORT }],
      environment: {
        FINERACT_API_URL: apiUrl,
        FINERACT_API_URLS: apiUrl,
        FINERACT_API_PROVIDER: `${FINERACT_CONTEXT}/api`,
        FINERACT_API_VERSION: '/v1',
        FINERACT_API_ACTUATOR: FINERACT_CONTEXT,
        FINERACT_PLATFORM_TENANT_IDENTIFIER: 'default',
        FINERACT_PLATFORM_TENANTS_IDENTIFIER: 'default',
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'webapp', logRetention: logs.RetentionDays.ONE_WEEK }),
    });
    this.webappService = new ecs.FargateService(this, 'WebappService', {
      serviceName: 'webapp',
      cluster: this.cluster,
      taskDefinition: webTaskDef,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [data.tasksSg],
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
    });
    // The target group's connections add the ALB -> tasks :80 ingress rule automatically.
    const webTg = new elbv2.ApplicationTargetGroup(this, 'WebappTg', {
      vpc: data.vpc,
      port: WEBAPP_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targets: [this.webappService],
      healthCheck: { path: '/', healthyHttpCodes: '200' },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    this.listener = this.alb.addListener('Https', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [props.dns.certificate],
      open: false,
      defaultAction: elbv2.ListenerAction.forward([webTg]),
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

    new route53.ARecord(this, 'DomainAlias', {
      zone: props.dns.zone,
      recordName: HARNESS_DOMAIN,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(this.alb)),
    });

    new cdk.CfnOutput(this, 'AlbDnsName', { value: this.alb.loadBalancerDnsName });
  }
}
