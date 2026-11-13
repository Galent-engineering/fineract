import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sd from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';

export interface DataStackProps extends cdk.StackProps {
  allowedCidrs: string[];
}

export class DataStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly albSg: ec2.SecurityGroup;
  public readonly tasksSg: ec2.SecurityGroup;
  public readonly dbSg: ec2.SecurityGroup;
  public readonly db: rds.DatabaseInstance;
  public readonly dbAdminSecret: secretsmanager.ISecret;
  public readonly dbReaderSecret: secretsmanager.Secret;
  public readonly fineractDbSecret: secretsmanager.Secret;
  public readonly namespace: sd.PrivateDnsNamespace;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    // Public subnets only: no NAT gateway (cost); tasks get public IPs, locked down by SGs.
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    this.albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      description: 'Harness ALB: HTTP from allow-listed CIDRs only',
      allowAllOutbound: true,
    });
    this.tasksSg = new ec2.SecurityGroup(this, 'TasksSg', {
      vpc: this.vpc,
      description: 'Harness ECS tasks',
      allowAllOutbound: true,
    });
    this.dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc: this.vpc,
      description: 'Harness RDS: 5432 from allow-listed CIDRs and tasks',
      allowAllOutbound: false,
    });

    for (const cidr of props.allowedCidrs) {
      this.albSg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(80), 'allow-listed HTTP');
      this.dbSg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(5432), 'allow-listed Postgres');
    }
    this.dbSg.addIngressRule(this.tasksSg, ec2.Port.tcp(5432), 'ECS tasks to Postgres');

    this.db = new rds.DatabaseInstance(this, 'Db', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.of('18.6', '18'),
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      publiclyAccessible: true,
      securityGroups: [this.dbSg],
      multiAz: false,
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      backupRetention: cdk.Duration.days(1),
      credentials: rds.Credentials.fromGeneratedSecret('harness_admin', {
        secretName: 'harness/db/admin',
      }),
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });
    this.dbAdminSecret = this.db.secret!;

    const userSecret = (logicalId: string, name: string, username: string) =>
      new secretsmanager.Secret(this, logicalId, {
        secretName: name,
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ username }),
          generateStringKey: 'password',
          passwordLength: 32,
          excludePunctuation: true,
        },
      });
    // Reader secret carries no grants here; Task 8 creates the role and grants.
    this.dbReaderSecret = userSecret('DbReaderSecret', 'harness/db/reader', 'reliability_reader');
    this.fineractDbSecret = userSecret('FineractDbSecret', 'harness/db/fineract', 'fineract');

    this.namespace = new sd.PrivateDnsNamespace(this, 'Namespace', {
      name: 'harness.local',
      vpc: this.vpc,
    });
  }
}
