import * as cdk from 'aws-cdk-lib';
import { loadHarnessConfig } from '../lib/config';

const appWith = (context: Record<string, string>) => new cdk.App({ context });

describe('loadHarnessConfig', () => {
  test('rejects empty allowedCidrs', () => {
    expect(() => loadHarnessConfig(appWith({}))).toThrow(/allowedCidrs must list at least one CIDR/);
    expect(() => loadHarnessConfig(appWith({ allowedCidrs: ' , ' }))).toThrow(
      /allowedCidrs must list at least one CIDR/,
    );
  });

  test('rejects 0.0.0.0/0', () => {
    expect(() => loadHarnessConfig(appWith({ allowedCidrs: '1.2.3.4/32,0.0.0.0/0' }))).toThrow(
      /open CIDR not allowed/,
    );
  });

  test('rejects ::/0', () => {
    expect(() => loadHarnessConfig(appWith({ allowedCidrs: '::/0' }))).toThrow(/open CIDR not allowed/);
  });

  test('accepts a /32 list', () => {
    const cfg = loadHarnessConfig(appWith({ allowedCidrs: '1.2.3.4/32, 5.6.7.8/32' }));
    expect(cfg.allowedCidrs).toEqual(['1.2.3.4/32', '5.6.7.8/32']);
    expect(cfg.region).toBe('us-east-1');
    expect(cfg.githubRepo).toBe('Galent-engineering/fineract');
    expect(cfg.githubBranch).toBe('galent/reliability-harness');
    expect(cfg.fineractImageTag).toBe('latest');
  });

  test('honours fineractImageTag', () => {
    const cfg = loadHarnessConfig(appWith({ allowedCidrs: '1.2.3.4/32', fineractImageTag: 'abc123' }));
    expect(cfg.fineractImageTag).toBe('abc123');
  });
});
