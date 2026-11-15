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
import * as fis from 'aws-cdk-lib/aws-fis';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sd from 'aws-cdk-lib/aws-servicediscovery';
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
/** Cloud Map name of the Fineract service inside the VPC (namespace harness.local). */
const FINERACT_DNS_LABEL = 'fineract';
const FINERACT_DNS_NAME = `${FINERACT_DNS_LABEL}.harness.local`;
/**
 * FIS ECS task actions need an SSM-agent sidecar that registers the task as an SSM managed instance
 * (https://docs.aws.amazon.com/fis/latest/userguide/ecs-task-actions.html). Image and script are the documented ones, verbatim.
 */
export const SSM_AGENT_IMAGE = 'public.ecr.aws/amazon-ssm-agent/amazon-ssm-agent:latest';
export const FIS_SCENARIO_DURATION = 'PT4M';
export const TRAFFIC_RATE_PARAM = '/harness/traffic/rate_per_min';
/** Port the Fineract task is blackholed on for the db-outage scenario. */
const POSTGRES_PORT = '5432';
const SSM_AGENT_SCRIPT = [
  'set -e; dnf upgrade -y; dnf install jq procps awscli -y;',
  'term_handler() { echo "Deleting SSM activation $ACTIVATION_ID"; if ! aws ssm delete-activation --activation-id $ACTIVATION_ID --region $ECS_TASK_REGION; then echo "SSM activation $ACTIVATION_ID failed to be deleted" 1>&2; fi;',
  'MANAGED_INSTANCE_ID=$(jq -e -r .ManagedInstanceID /var/lib/amazon/ssm/registration); echo "Deregistering SSM Managed Instance $MANAGED_INSTANCE_ID";',
  'if ! aws ssm deregister-managed-instance --instance-id $MANAGED_INSTANCE_ID --region $ECS_TASK_REGION; then echo "SSM Managed Instance $MANAGED_INSTANCE_ID failed to be deregistered" 1>&2; fi; kill -SIGTERM $SSM_AGENT_PID; };',
  'trap term_handler SIGTERM SIGINT;',
  'if [[ -z $MANAGED_INSTANCE_ROLE_NAME ]]; then echo "Environment variable MANAGED_INSTANCE_ROLE_NAME not set, exiting" 1>&2; exit 1; fi;',
  'if ! ps ax | grep amazon-ssm-agent | grep -v grep > /dev/null; then if [[ -n $ECS_CONTAINER_METADATA_URI_V4 ]] ; then echo "Found ECS Container Metadata, running activation with metadata";',
  'TASK_METADATA=$(curl "${ECS_CONTAINER_METADATA_URI_V4}/task"); ECS_TASK_AVAILABILITY_ZONE=$(echo $TASK_METADATA | jq -e -r \'.AvailabilityZone\'); ECS_TASK_ARN=$(echo $TASK_METADATA | jq -e -r \'.TaskARN\'); ECS_TASK_REGION=$(echo $ECS_TASK_AVAILABILITY_ZONE | sed \'s/.$//\');',
  "ECS_TASK_AVAILABILITY_ZONE_REGEX='^(af|ap|ca|cn|eu|me|sa|us|us-gov)-(central|north|(north(east|west))|south|south(east|west)|east|west)-[0-9]{1}[a-z]{1}$';",
  'if ! [[ $ECS_TASK_AVAILABILITY_ZONE =~ $ECS_TASK_AVAILABILITY_ZONE_REGEX ]]; then echo "Error extracting Availability Zone from ECS Container Metadata, exiting" 1>&2; exit 1; fi;',
  "ECS_TASK_ARN_REGEX='^arn:(aws|aws-cn|aws-us-gov):ecs:[a-z0-9-]+:[0-9]{12}:task/[a-zA-Z0-9_-]+/[a-zA-Z0-9]+$';",
  'if ! [[ $ECS_TASK_ARN =~ $ECS_TASK_ARN_REGEX ]]; then echo "Error extracting Task ARN from ECS Container Metadata, exiting" 1>&2; exit 1; fi;',
  'CREATE_ACTIVATION_OUTPUT=$(aws ssm create-activation --iam-role $MANAGED_INSTANCE_ROLE_NAME --tags Key=ECS_TASK_AVAILABILITY_ZONE,Value=$ECS_TASK_AVAILABILITY_ZONE Key=ECS_TASK_ARN,Value=$ECS_TASK_ARN Key=FAULT_INJECTION_SIDECAR,Value=true --region $ECS_TASK_REGION);',
  'ACTIVATION_CODE=$(echo $CREATE_ACTIVATION_OUTPUT | jq -e -r .ActivationCode); ACTIVATION_ID=$(echo $CREATE_ACTIVATION_OUTPUT | jq -e -r .ActivationId);',
  'if ! amazon-ssm-agent -register -code $ACTIVATION_CODE -id $ACTIVATION_ID -region $ECS_TASK_REGION; then echo "Failed to register with AWS Systems Manager (SSM), exiting" 1>&2; exit 1; fi;',
  'amazon-ssm-agent & SSM_AGENT_PID=$!; wait $SSM_AGENT_PID; else echo "ECS Container Metadata not found, exiting" 1>&2; exit 1; fi; else echo "SSM agent is already running, exiting" 1>&2; exit 1; fi',
].join(' ');
const SIDECAR_CONFIG_WRITER_IMAGE = 'busybox:1.37.0';
const readConfig = (file: string): string => fs.readFileSync(path.join(__dirname, '..', 'config', file), 'utf8');

// postgres:18 (psql client for the one-off db-init and db-reader-grant tasks), pinned by digest (multi-arch index).
const POSTGRES_IMAGE = 'postgres:18@sha256:b9f6b8ff03b62f3cfd9d9ba3fe56226a9991c79d3fb46fd46536263bf02be553';

export interface AppStackProps extends cdk.StackProps {
  data: DataStack;
  dns: DnsStack;
  fineractRepo: ecr.IRepository;
  fineractImageTag: string;
  trafficRepo: ecr.IRepository;
  /** Immutable tag (git sha) of harness/traffic; used by the traffic service and the seed task. */
  trafficImageTag: string;
  /**
   * Desired counts are NOT managed by CloudFormation after creation, so pause.sh/resume.sh survive `cdk deploy`.
   * Context `fineractDesiredCount` is only meant for the first deploy (0 until db-init has run, then 1 once);
   * when absent the property is omitted and the live count is left alone.
   */
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
  public readonly seedTaskDef: ecs.FargateTaskDefinition;
  public readonly dbReaderGrantTaskDef: ecs.FargateTaskDefinition;
  public readonly trafficService: ecs.FargateService;
  public readonly trafficSg: ec2.SecurityGroup;
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

    // Read-only Fineract API user for the reliability product (Task 8 creates the user and role).
    const reliabilityApiSecret = new secretsmanager.Secret(this, 'ReliabilityApiSecret', {
      secretName: 'harness/fineract/reliability-api',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'reliability_api' }),
        generateStringKey: 'password',
        passwordLength: 32,
        excludePunctuation: true,
      },
    });
    // New random password for the built-in `mifos` user, so the rotated value is never lost.
    const mifosSecret = new secretsmanager.Secret(this, 'FineractMifosSecret', {
      secretName: 'harness/fineract/mifos',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'mifos' }),
        generateStringKey: 'password',
        passwordLength: 32,
        excludePunctuation: true,
      },
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
      image: ecs.ContainerImage.fromRegistry(POSTGRES_IMAGE),
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
      // FIS aws:ecs:task network actions on Fargate: fault injection endpoints on, one PID namespace for the task
      // (https://docs.aws.amazon.com/fis/latest/userguide/ecs-task-actions.html).
      enableFaultInjection: true,
      pidMode: ecs.PidMode.TASK,
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
        // 0.25: with always_on the harness produced ~7,400 traces/h (measured 2026-11-14, 6 journeys/min + Quartz
        // JDBC root spans), over the ~2,000/h budget. Parent-based so ALB/propagated decisions are honoured.
        OTEL_TRACES_SAMPLER: 'parentbased_traceidratio',
        OTEL_TRACES_SAMPLER_ARG: '0.25',
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

    // FIS sidecar: registers this task as an SSM managed instance (tags ECS_TASK_ARN) so FIS can run its SSM documents in it.
    const ssmManagedInstanceRole = new iam.Role(this, 'FisSsmManagedInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ssm.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    // The documented script tags its activation (and so the registered instance) FAULT_INJECTION_SIDECAR=true.
    // Deregister is scoped to such instances. DeleteActivation has no resource types or condition keys in the Service
    // Authorization Reference (https://docs.aws.amazon.com/service-authorization/latest/reference/list_ssm.html), so it stays `*`.
    // The managed-instance role gets the pair the docs list; the task role gets it too because the sidecar's SIGTERM handler
    // runs the CLI with the task role credentials (otherwise every task stop leaves a stale instance and activation).
    const ssmArn = (rest: string) => `arn:${this.partition}:ssm:${this.region}:${this.account}:${rest}`;
    const sidecarCleanup = () => [
      new iam.PolicyStatement({
        actions: ['ssm:DeregisterManagedInstance'],
        resources: [ssmArn('managed-instance/*')],
        conditions: { StringEquals: { 'ssm:resourceTag/FAULT_INJECTION_SIDECAR': 'true' } },
      }),
      new iam.PolicyStatement({ actions: ['ssm:DeleteActivation'], resources: ['*'] }),
    ];
    sidecarCleanup().forEach((st) => ssmManagedInstanceRole.addToPolicy(st));
    sidecarCleanup().forEach((st) => taskDef.taskRole.addToPrincipalPolicy(st));
    // CreateActivation cannot be resource-scoped (it creates the resource). Accepted risk: dev account, and the only code in
    // this task is the allow-listed Fineract app. A compromised container could register its own node (PassRole below limits the
    // role it can attach to the one managed-instance role) and, by tagging it, receive the FIS network documents meant for the task.
    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ['ssm:CreateActivation'], resources: ['*'] }),
    );
    // The only tagging is create-activation's own --tags, which always carries FAULT_INJECTION_SIDECAR=true. The Service
    // Authorization Reference lists no activation resource type, so scope by the request tag instead of the resource.
    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:AddTagsToResource'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:RequestTag/FAULT_INJECTION_SIDECAR': 'true' } },
      }),
    );
    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [ssmManagedInstanceRole.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'ssm.amazonaws.com' } },
      }),
    );
    taskDef.addContainer('amazon-ssm-agent', {
      image: ecs.ContainerImage.fromRegistry(SSM_AGENT_IMAGE),
      essential: false,
      entryPoint: ['/bin/bash', '-c'],
      command: [SSM_AGENT_SCRIPT],
      environment: { MANAGED_INSTANCE_ROLE_NAME: ssmManagedInstanceRole.roleName },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'ssm-agent', logRetention: logs.RetentionDays.ONE_WEEK }),
    });

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

    const ctxDesired = this.node.tryGetContext('fineractDesiredCount');
    const desired = props.fineractDesiredCount ?? (ctxDesired === undefined ? undefined : Number(ctxDesired));
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
      circuitBreaker: { rollback: true },
      cloudMapOptions: {
        name: FINERACT_DNS_LABEL,
        cloudMapNamespace: data.namespace,
        dnsRecordType: sd.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
      },
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

    // ---- Traffic generator, seed and db-reader-grant (Task 8) ----
    // The ALB is IP-allow-listed and tasks have no NAT, so in-VPC clients call Fineract directly on its task port.
    this.trafficSg = new ec2.SecurityGroup(this, 'TrafficSg', {
      vpc: data.vpc,
      description: 'Harness traffic generator and seed tasks',
      allowAllOutbound: true,
    });
    new ec2.CfnSecurityGroupIngress(this, 'TrafficToTasks', {
      groupId: data.tasksSg.securityGroupId,
      sourceSecurityGroupId: this.trafficSg.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: FINERACT_PORT,
      toPort: FINERACT_PORT,
      description: 'Traffic/seed to Fineract (plain HTTP, in-VPC)',
    });
    const trafficImage = ecs.ContainerImage.fromEcrRepository(props.trafficRepo, props.trafficImageTag);
    const internalFineractUrl = `http://${FINERACT_DNS_NAME}:${FINERACT_PORT}`;

    const trafficTaskDef = new ecs.FargateTaskDefinition(this, 'TrafficTaskDef', {
      family: 'harness-traffic',
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    trafficTaskDef.addContainer('traffic', {
      image: trafficImage,
      environment: {
        FINERACT_BASE_URL: internalFineractUrl,
        SECRET_ARN: this.fineractAdminSecret.secretArn,
        RATE_PER_MIN: '6',
        RATE_PARAM_NAME: TRAFFIC_RATE_PARAM,
        ERROR_RATE: '0.02',
        SLOW_RATE: '0.01',
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'traffic', logRetention: logs.RetentionDays.TWO_WEEKS }),
    });
    this.fineractAdminSecret.grantRead(trafficTaskDef.taskRole);
    // Journey rate, switchable at runtime (deploy/scripts/demo.sh on|off). The traffic task reads it about once a minute.
    const rateParam = new ssm.StringParameter(this, 'TrafficRateParam', {
      parameterName: TRAFFIC_RATE_PARAM,
      stringValue: '6',
      description: 'Traffic generator journeys per minute (1..120); RATE_PER_MIN is the fallback',
    });
    trafficTaskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [rateParam.parameterArn] }),
    );
    this.trafficService = new ecs.FargateService(this, 'TrafficService', {
      serviceName: 'traffic',
      cluster: this.cluster,
      taskDefinition: trafficTaskDef,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [this.trafficSg],
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { rollback: true },
    });

    // One-off: seed data + credential rotation + read-only API user + Loan COB job.
    this.seedTaskDef = new ecs.FargateTaskDefinition(this, 'SeedTaskDef', {
      family: 'harness-seed',
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    this.seedTaskDef.addContainer('seed', {
      image: trafficImage,
      command: ['python', '-m', 'harness_traffic.seed'],
      environment: { FINERACT_BASE_URL: internalFineractUrl },
      secrets: {
        ADMIN_USERNAME: pw(this.fineractAdminSecret, 'username'),
        ADMIN_PASSWORD: pw(this.fineractAdminSecret, 'password'),
        API_USERNAME: pw(reliabilityApiSecret, 'username'),
        API_PASSWORD: pw(reliabilityApiSecret, 'password'),
        MIFOS_PASSWORD: pw(mifosSecret, 'password'),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'seed', logRetention: logs.RetentionDays.TWO_WEEKS }),
    });

    // One-off: grants for the read-only DB role (also creates the role, which Task 4 never did).
    this.dbReaderGrantTaskDef = new ecs.FargateTaskDefinition(this, 'DbReaderGrantTaskDef', {
      family: 'harness-dbreadergrant',
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    this.dbReaderGrantTaskDef.addContainer('dbreadergrant', {
      image: ecs.ContainerImage.fromRegistry(POSTGRES_IMAGE),
      entryPoint: ['/bin/bash', '-c'],
      command: [
        'set -e; printf "%s" "$READER_SQL" > /tmp/db_reader.sql; ' +
          'psql -v ON_ERROR_STOP=1 -v rpw="$RP" -f /tmp/db_reader.sql; echo db-reader-grant complete',
      ],
      environment: {
        PGHOST: dbHost,
        PGPORT: '5432',
        PGDATABASE: 'postgres',
        PGSSLMODE: 'require',
        READER_SQL: fs.readFileSync(path.join(__dirname, '..', '..', 'traffic', 'harness_traffic', 'db_reader.sql'), 'utf8'),
      },
      secrets: {
        PGUSER: pw(data.dbAdminSecret, 'username'),
        PGPASSWORD: pw(data.dbAdminSecret, 'password'),
        RP: pw(data.dbReaderSecret, 'password'),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'dbreadergrant', logRetention: logs.RetentionDays.ONE_WEEK }),
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
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [data.tasksSg],
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { rollback: true },
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
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
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
    // Actuator is never served through the ALB (metrics reach AMP via the ADOT sidecar scraping localhost;
    // target-group health checks hit the targets directly, so they are unaffected).
    const actuatorBlock = {
      priority: 5,
      conditions: [
        elbv2.ListenerCondition.pathPatterns([
          '/actuator', '/actuator/*', `${FINERACT_CONTEXT}/actuator`, `${FINERACT_CONTEXT}/actuator/*`,
        ]),
      ],
      action: elbv2.ListenerAction.fixedResponse(404, { contentType: 'text/plain', messageBody: 'Not Found' }),
    };
    this.listener.addAction('BlockActuator', actuatorBlock);
    this.httpListener.addAction('BlockActuator', actuatorBlock);
    this.listener.addAction('Fineract', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns([`${FINERACT_CONTEXT}/*`])],
      action: elbv2.ListenerAction.forward([tg]),
    });

    // ---- Demo scenarios (AWS FIS). Templates only: nothing runs until deploy/scripts/demo.sh starts one. ----
    // Each action has a hard duration, so every scenario reverts on its own; no stop-condition alarm by design.
    const fisRole = new iam.Role(this, 'FisScenarioRole', {
      roleName: 'harness-fis-scenarios',
      assumedBy: new iam.PrincipalWithConditions(new iam.ServicePrincipal('fis.amazonaws.com'), {
        StringEquals: { 'aws:SourceAccount': this.account },
        ArnLike: { 'aws:SourceArn': `arn:${this.partition}:fis:${this.region}:${this.account}:experiment/*` },
      }),
    });
    const ecsArn = (rest: string) => `arn:${this.partition}:ecs:${this.region}:${this.account}:${rest}`;
    const ssmDoc = (name: string) => `arn:${this.partition}:ssm:${this.region}::document/${name}`;
    // StopTask authorizes on the task ARN (task/<cluster>/<id>), which carries no service name, so it cannot be limited to
    // the fineract service; the cluster scope is the narrowest IAM allows. The templates themselves only select fineract.
    fisRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecs:DescribeTasks', 'ecs:StopTask'],
      resources: [ecsArn('task/harness/*')],
    }));
    // ListTasks authorizes on container-instance (none on Fargate), not on the cluster ARN, so `*` plus the ecs:cluster key
    // (https://docs.aws.amazon.com/service-authorization/latest/reference/list_ecs.html). Read-only.
    fisRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecs:ListTasks'],
      resources: ['*'],
      conditions: { ArnEquals: { 'ecs:cluster': ecsArn('cluster/harness') } },
    }));
    // SendCommand: only the two FIS network documents, and only on instances registered by the Fineract sidecar.
    fisRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:SendCommand'],
      resources: [ssmDoc('AWSFIS-Run-Network-Blackhole-Port-ECS'), ssmDoc('AWSFIS-Run-Network-Latency-ECS')],
    }));
    fisRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:SendCommand'],
      resources: [ssmArn('managed-instance/*')],
      conditions: { StringEquals: { 'ssm:resourceTag/FAULT_INJECTION_SIDECAR': 'true' } },
    }));
    // No resource-level scoping exists for these: command listing/cancel, tag lookup for target resolution, and the
    // describe calls the FIS actions reference lists for aws:ecs:task-network-latency. All read-only or self-limiting.
    fisRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ssm:ListCommands', 'ssm:CancelCommand', 'tag:GetResources',
        'ecs:DescribeContainerInstances', 'ec2:DescribeInstances', 'ec2:DescribeSubnets',
      ],
      resources: ['*'],
    }));

    const scenario = (
      id: string,
      name: string,
      description: string,
      actionId: string,
      parameters: Record<string, string>,
    ) =>
      new fis.CfnExperimentTemplate(this, id, {
        description,
        roleArn: fisRole.roleArn,
        stopConditions: [{ source: 'none' }],
        tags: { Name: `harness-${name}`, 'harness-scenario': name },
        targets: {
          fineractTasks: {
            resourceType: 'aws:ecs:task',
            selectionMode: 'ALL',
            parameters: { cluster: 'harness', service: 'fineract' },
          },
        },
        actions: {
          [name.replace(/-/g, '')]: { actionId, parameters: Object.keys(parameters).length ? parameters : undefined, targets: { Tasks: 'fineractTasks' } },
        },
      });
    scenario('ScenarioDbOutage', 'db-outage', 'Fineract task cannot reach Postgres (egress tcp 5432) for 4 minutes',
      'aws:ecs:task-network-blackhole-port',
      { duration: FIS_SCENARIO_DURATION, port: POSTGRES_PORT, protocol: 'tcp', trafficType: 'egress', useEcsFaultInjectionEndpoints: 'true' });
    scenario('ScenarioSlowdown', 'slowdown', 'About 200 ms added to every outgoing packet of the Fineract task (database calls included) for 4 minutes',
      'aws:ecs:task-network-latency',
      { duration: FIS_SCENARIO_DURATION, delayMilliseconds: '200', useEcsFaultInjectionEndpoints: 'true' });
    scenario('ScenarioCrash', 'crash', 'Stop the running Fineract task; the ECS service replaces it',
      'aws:ecs:stop-task', {});

    new route53.ARecord(this, 'DomainAlias', {
      zone: props.dns.zone,
      recordName: HARNESS_DOMAIN,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(this.alb)),
    });

    new cdk.CfnOutput(this, 'AlbDnsName', { value: this.alb.loadBalancerDnsName });
  }
}
