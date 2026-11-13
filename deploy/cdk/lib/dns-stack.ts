import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export const HARNESS_DOMAIN = 'fineract.galent.ai';

/**
 * Child hosted zone for fineract.galent.ai plus a DNS-validated ACM certificate.
 * The parent zone (galent.ai, production account) must delegate to this zone via
 * deploy/scripts/delegate-parent-ns.sh before the certificate can validate.
 */
export class DnsStack extends cdk.Stack {
  public readonly zone: route53.PublicHostedZone;
  public readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.zone = new route53.PublicHostedZone(this, 'Zone', { zoneName: HARNESS_DOMAIN });

    this.certificate = new acm.Certificate(this, 'Cert', {
      domainName: HARNESS_DOMAIN,
      validation: acm.CertificateValidation.fromDns(this.zone),
    });

    new cdk.CfnOutput(this, 'ZoneNameServers', { value: cdk.Fn.join(',', this.zone.hostedZoneNameServers!) });
    new cdk.CfnOutput(this, 'ZoneId', { value: this.zone.hostedZoneId });
  }
}
