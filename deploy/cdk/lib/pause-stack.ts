import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { DataStack } from './data-stack';

export interface PauseStackProps extends cdk.StackProps {
  data: DataStack;
}

/**
 * Support for deploy/scripts/pause.sh and resume.sh: the /harness/paused flag and the Lambda that stops RDS
 * again when AWS auto-starts it after the 7-day maximum stop time (RDS-EVENT-0154) while the harness is paused.
 */
export class PauseStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PauseStackProps) {
    super(scope, id, props);
    const db = props.data.db;

    // The value is only the initial state; pause.sh/resume.sh own it afterwards (CloudFormation does not
    // re-apply an unchanged property, so a deploy never flips it).
    const paused = new ssm.StringParameter(this, 'Paused', {
      parameterName: '/harness/paused',
      stringValue: 'false',
      description: 'true while the harness is paused (pause.sh); read by the RDS re-stop Lambda',
    });

    const fn = new lambda.Function(this, 'RestopRds', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'restop_rds.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda'), {
        exclude: ['test_*', '__pycache__', '*.pyc', '.pytest_cache'],
      }),
      timeout: cdk.Duration.minutes(15), // the handler waits for the DB to become available before stopping it
      environment: { DB_INSTANCE_ID: db.instanceIdentifier, PAUSED_PARAM: paused.parameterName },
      logGroup: new logs.LogGroup(this, 'RestopLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [paused.parameterArn] }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['rds:StopDBInstance', 'rds:DescribeDBInstances'],
      resources: [db.instanceArn],
    }));

    new events.Rule(this, 'RdsAutoStarted', {
      description: 'RDS-EVENT-0154: harness DB auto-started after max stop time; Lambda stops it again if paused',
      eventPattern: {
        source: ['aws.rds'],
        detailType: ['RDS DB Instance Event'],
        detail: { EventID: ['RDS-EVENT-0154'], SourceIdentifier: [db.instanceIdentifier] },
      },
      targets: [new eventTargets.LambdaFunction(fn)],
    });

    new cdk.CfnOutput(this, 'DbInstanceIdentifier', { value: db.instanceIdentifier });
    new cdk.CfnOutput(this, 'RestopFunctionName', { value: fn.functionName });
  }
}
