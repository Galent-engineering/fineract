import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sd from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import { AppStack } from './app-stack';
import { DataStack } from './data-stack';
import { substituteToken } from './fineract-env';

/** Image pins, chosen 2026-11-13 (current stable on each registry). */
export const TEMPO_IMAGE = 'grafana/tempo:2.10.10';
export const LOKI_IMAGE = 'grafana/loki:3.7.10';
export const NGINX_IMAGE = 'nginx:1.30.6-alpine';
export const BUSYBOX_IMAGE = 'busybox:1.37.0';

const NGINX_PORT = 8080;
export const TEMPO_PORT = 3200;
export const TEMPO_OTLP_PORT = 4318;
export const LOKI_PORT = 3100;

export const readConfig = (file: string): string =>
  fs.readFileSync(path.join(__dirname, '..', 'config', file), 'utf8');

export interface ObsStackProps extends cdk.StackProps {
  data: DataStack;
  /** Provides the ALB listener (rules live here) and the AMP workspace (the Fineract task needs it). */
  app: AppStack;
}

/**
 * Tempo + Loki + an nginx basic-auth front on one task, S3-backed, registered in Cloud Map as
 * tempo.harness.local and loki.harness.local. The AMP workspace itself is created in AppStack
 * (Fineract's task definition needs it, and this stack depends on AppStack for the listener) and
 * exported from here as outputs.
 */
export class ObsStack extends cdk.Stack {
  public readonly bucket: s3.Bucket;
  public readonly basicAuthSecret: secretsmanager.Secret;
  public readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props: ObsStackProps) {
    super(scope, id, props);
    const { data, app } = props;

    new cdk.CfnOutput(this, 'AmpWorkspaceId', { value: app.ampWorkspace.attrWorkspaceId });
    new cdk.CfnOutput(this, 'AmpQueryUrl', { value: `${app.ampWorkspace.attrPrometheusEndpoint}api/v1/query` });

    this.bucket = new s3.Bucket(this, 'Bucket', {
      bucketName: `harness-obs-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(14) }],
    });

    this.basicAuthSecret = new secretsmanager.Secret(this, 'BasicAuthSecret', {
      secretName: 'harness/obs/basic-auth',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'reliability' }),
        generateStringKey: 'password',
        passwordLength: 32,
        excludePunctuation: true,
      },
    });

    const cluster = new ecs.Cluster(this, 'Cluster', { clusterName: 'harness-obs', vpc: data.vpc });

    const taskDef = new ecs.FargateTaskDefinition(this, 'ObsTaskDef', {
      family: 'harness-obs',
      cpu: 1024,
      memoryLimitMiB: 4096,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    this.bucket.grantReadWrite(taskDef.taskRole);
    taskDef.addVolume({ name: 'cfg' });

    const bucketName = this.bucket.bucketName;
    const withBucket = (file: string) => substituteToken(readConfig(file), '__BUCKET__', bucketName);
    const log = (prefix: string) =>
      ecs.LogDrivers.awsLogs({ streamPrefix: prefix, logRetention: logs.RetentionDays.ONE_WEEK });

    // Config files travel as (non-secret) env vars into a one-shot writer; the htpasswd is hashed
    // here from the Secrets-Manager password so no password is ever in an image or config file.
    const init = taskDef.addContainer('config-init', {
      image: ecs.ContainerImage.fromRegistry(BUSYBOX_IMAGE),
      essential: false,
      entryPoint: ['/bin/sh', '-c'],
      command: [
        [
          'set -e',
          'printf "%s" "$TEMPO_YAML" > /cfg/tempo.yaml',
          'printf "%s" "$LOKI_YAML" > /cfg/loki.yaml',
          'printf "%s" "$NGINX_CONF" > /cfg/nginx.conf',
          'printf "%s:%s\\n" "$OBS_USER" "$(printf "%s" "$OBS_PW" | cryptpw -m sha512 -s)" > /cfg/htpasswd',
          'chmod -R a+rX /cfg',
          'echo config-init complete',
        ].join('\n'),
      ],
      environment: {
        TEMPO_YAML: withBucket('tempo.yaml'),
        LOKI_YAML: withBucket('loki.yaml'),
        NGINX_CONF: readConfig('nginx.conf'),
      },
      secrets: {
        OBS_USER: ecs.Secret.fromSecretsManager(this.basicAuthSecret, 'username'),
        OBS_PW: ecs.Secret.fromSecretsManager(this.basicAuthSecret, 'password'),
      },
      logging: log('config-init'),
    });
    init.addMountPoints({ containerPath: '/cfg', sourceVolume: 'cfg', readOnly: false });

    const mount = { containerPath: '/cfg', sourceVolume: 'cfg', readOnly: true };
    const dependOnInit = (c: ecs.ContainerDefinition) =>
      c.addContainerDependencies({ container: init, condition: ecs.ContainerDependencyCondition.SUCCESS });

    const tempo = taskDef.addContainer('tempo', {
      image: ecs.ContainerImage.fromRegistry(TEMPO_IMAGE),
      command: ['-config.file=/cfg/tempo.yaml'],
      portMappings: [{ containerPort: TEMPO_PORT }, { containerPort: TEMPO_OTLP_PORT }],
      logging: log('tempo'),
    });
    tempo.addMountPoints(mount);
    dependOnInit(tempo);

    const loki = taskDef.addContainer('loki', {
      image: ecs.ContainerImage.fromRegistry(LOKI_IMAGE),
      command: ['-config.file=/cfg/loki.yaml'],
      portMappings: [{ containerPort: LOKI_PORT }],
      logging: log('loki'),
    });
    loki.addMountPoints(mount);
    dependOnInit(loki);

    const nginx = taskDef.addContainer('nginx', {
      image: ecs.ContainerImage.fromRegistry(NGINX_IMAGE),
      command: ['nginx', '-c', '/cfg/nginx.conf', '-g', 'daemon off;'],
      portMappings: [{ containerPort: NGINX_PORT }],
      logging: log('nginx'),
    });
    nginx.addMountPoints(mount);
    dependOnInit(nginx);

    this.service = new ecs.FargateService(this, 'ObsService', {
      serviceName: 'obs',
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [data.tasksSg],
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
    });

    // ECS allows one service registry per service: tempo.harness.local is the real A record for the
    // task; loki.harness.local is a Cloud Map CNAME to it (both names resolve to the same task).
    const tempoCm = new sd.Service(this, 'Cmtempo', {
      namespace: data.namespace,
      name: 'tempo',
      dnsRecordType: sd.DnsRecordType.A,
      dnsTtl: cdk.Duration.seconds(10),
      customHealthCheck: { failureThreshold: 1 },
    });
    (this.service.node.defaultChild as cdk.aws_ecs.CfnService).serviceRegistries = [
      { registryArn: tempoCm.serviceArn },
    ];
    const lokiCm = new sd.Service(this, 'Cmloki', {
      namespace: data.namespace,
      name: 'loki',
      dnsRecordType: sd.DnsRecordType.CNAME,
      dnsTtl: cdk.Duration.seconds(10),
    });
    lokiCm.registerCnameInstance('LokiAlias', { instanceCname: 'tempo.harness.local' });

    // Fineract's ADOT/FireLens sidecars reach Tempo OTLP and Loki over the VPC (same task SG).
    for (const port of [TEMPO_OTLP_PORT, LOKI_PORT]) {
      new ec2.CfnSecurityGroupIngress(this, `TasksSelf${port}`, {
        groupId: data.tasksSg.securityGroupId,
        sourceSecurityGroupId: data.tasksSg.securityGroupId,
        ipProtocol: 'tcp',
        fromPort: port,
        toPort: port,
        description: `Fineract sidecars to obs :${port}`,
      });
    }

    // ---- ALB: the only way in from outside. HTTPS listener, /tempo/* and /loki/* -> nginx ----
    const tg = new elbv2.ApplicationTargetGroup(this, 'ObsTg', {
      vpc: data.vpc,
      port: NGINX_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targets: [this.service.loadBalancerTarget({ containerName: 'nginx', containerPort: NGINX_PORT })],
      healthCheck: { path: '/healthz', healthyHttpCodes: '200', interval: cdk.Duration.seconds(30) },
      deregistrationDelay: cdk.Duration.seconds(30),
    });
    new elbv2.ApplicationListenerRule(this, 'TempoRule', {
      listener: app.listener,
      priority: 20,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/tempo/*'])],
      action: elbv2.ListenerAction.forward([tg]),
    });
    new elbv2.ApplicationListenerRule(this, 'LokiRule', {
      listener: app.listener,
      priority: 21,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/loki/*'])],
      action: elbv2.ListenerAction.forward([tg]),
    });
  }
}
