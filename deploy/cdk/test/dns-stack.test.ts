import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { loadHarnessConfig } from '../lib/config';
import { BuildStack } from '../lib/build-stack';
import { DataStack } from '../lib/data-stack';
import { DnsStack } from '../lib/dns-stack';
import { AppStack } from '../lib/app-stack';

const env = { account: '111111111111', region: 'us-east-1' };
const build = () => {
  const app = new cdk.App({ context: { allowedCidrs: '203.0.113.7/32,198.51.100.0/24', fineractImageTag: 'abc123' } });
  const config = loadHarnessConfig(app);
  const buildStack = new BuildStack(app, 'HarnessBuild', { env });
  const data = new DataStack(app, 'HarnessData', { env, allowedCidrs: config.allowedCidrs });
  const dns = new DnsStack(app, 'HarnessDns', { env });
  const appStack = new AppStack(app, 'HarnessApp', {
    env,
    data,
    dns,
    fineractRepo: buildStack.fineractRepo,
    fineractImageTag: 'abc123',
  });
  return { dns: Template.fromStack(dns), app: Template.fromStack(appStack), data: Template.fromStack(data) };
};

describe('custom domain', () => {
  const t = build();

  test('certificate for fineract.galent.ai, DNS-validated in the child zone', () => {
    t.dns.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'fineract.galent.ai',
      ValidationMethod: 'DNS',
      DomainValidationOptions: [
        Match.objectLike({ DomainName: 'fineract.galent.ai', HostedZoneId: { Ref: Match.stringLikeRegexp('Zone') } }),
      ],
    });
    t.dns.hasResourceProperties('AWS::Route53::HostedZone', { Name: 'fineract.galent.ai.' });
    expect(Object.keys(t.dns.toJSON().Outputs)).toEqual(expect.arrayContaining(['ZoneNameServers', 'ZoneId']));
  });

  test('HTTPS listener on 443 uses the certificate and carries the Fineract path rule', () => {
    t.app.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
      Certificates: [Match.objectLike({ CertificateArn: Match.anyValue() })],
    });
    t.app.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/fineract-provider/*'] } }],
    });
  });

  test('port 80 default action redirects to HTTPS 443', () => {
    t.app.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: [
        Match.objectLike({
          Type: 'redirect',
          RedirectConfig: Match.objectLike({ Protocol: 'HTTPS', Port: '443', StatusCode: 'HTTP_301' }),
        }),
      ],
    });
  });

  test('albSg ingress on 443 lists exactly the context CIDRs', () => {
    const sgs = Object.values(t.data.findResources('AWS::EC2::SecurityGroup'));
    const alb = sgs.find((s: any) => String(s.Properties.GroupDescription).includes('ALB')) as any;
    const cidrs443 = alb.Properties.SecurityGroupIngress.filter((r: any) => r.FromPort === 443).map((r: any) => r.CidrIp);
    expect(cidrs443.sort()).toEqual(['198.51.100.0/24', '203.0.113.7/32']);
  });

  test('alias A record fineract.galent.ai targets the ALB', () => {
    t.app.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'fineract.galent.ai.',
      Type: 'A',
      AliasTarget: Match.objectLike({ DNSName: Match.anyValue(), HostedZoneId: Match.anyValue() }),
    });
  });
});
