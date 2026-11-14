import { Fn } from 'aws-cdk-lib';

/**
 * Non-secret Fineract environment. Property/env names were confirmed against
 * fineract-provider/src/main/resources/application.properties at tag 1.16.1:
 *
 *  - DB (tenant store):  spring.datasource.hikari.jdbcUrl  <- FINERACT_HIKARI_JDBC_URL
 *                        .username <- FINERACT_HIKARI_USERNAME, .password <- FINERACT_HIKARI_PASSWORD (secrets)
 *  - Default tenant DB:  FINERACT_DEFAULT_TENANTDB_{HOSTNAME,PORT,UID,PWD,NAME,IDENTIFIER,MASTER_PASSWORD}
 *  - SSL switch exists:  server.ssl.enabled <- FINERACT_SERVER_SSL_ENABLED (default true),
 *                        server.port <- FINERACT_SERVER_PORT (default 8443)
 *  - Tracing:            management.tracing.enabled <- FINERACT_MANAGEMENT_TRACIING_ENABLED
 *                        (the typo "TRACIING" IS the real name in 1.16.1; the spec value is correct)
 *  - NOTE (Task 6): 1.16.1 has NO micrometer-tracing/OTel bridge dependency, so the three tracing
 *    settings below/above emit no spans. Spans come from the ADOT Java agent attached in app-stack.ts.
 *  - OTLP traces endpoint: NO FINERACT_* env var exists. Only management.otlp.metrics.export.url
 *                        (FINERACT_MANAGEMENT_OLTP_METRICS_EXPORT_URL) is mapped, and it is the metrics exporter.
 *                        We use Spring Boot relaxed binding: MANAGEMENT_OTLP_TRACING_ENDPOINT.
 *  - Sampling probability: NO FINERACT_* env var. Spring relaxed binding: MANAGEMENT_TRACING_SAMPLING_PROBABILITY.
 *                        (fineract.sampling.* is an unrelated class-sampling feature, left off.)
 *  - JSON logs:          fineract.logging.json.enabled <- FINERACT_LOGGING_JSON_ENABLED
 *  - Correlation ID:     fineract.correlation.enabled <- FINERACT_LOGGING_HTTP_CORRELATION_ID_ENABLED,
 *                        header-name <- FINERACT_LOGGING_HTTP_CORRELATION_ID_HEADER_NAME (default X-Correlation-ID)
 *  - HTTP histograms:    management.metrics.distribution.percentiles-histogram.http.server.requests
 *                        <- FINERACT_MANAGEMENT_METRICS_DISTRIBUTION_HTTP_SERVER_REQUESTS
 *  - Prometheus:         exposure include health,info,prometheus (default) ->
 *                        /fineract-provider/actuator/prometheus (context path /fineract-provider)
 *  - Readiness group:    management.endpoint.health.probes.enabled=true ->
 *                        /fineract-provider/actuator/health/readiness
 */
export const FINERACT_PORT = 8080;
export const FINERACT_CONTEXT = '/fineract-provider';
export const TENANTS_DB = 'fineract_tenants';
export const TENANT_DEFAULT_DB = 'fineract_default';

export function fineractEnvironment(dbHost: string): Record<string, string> {
  return {
    JAVA_TOOL_OPTIONS: '-Xmx5g',
    FINERACT_SERVER_SSL_ENABLED: 'false',
    FINERACT_SERVER_PORT: String(FINERACT_PORT),
    FINERACT_HIKARI_JDBC_URL: `jdbc:postgresql://${dbHost}:5432/${TENANTS_DB}`,
    FINERACT_DEFAULT_TENANTDB_HOSTNAME: dbHost,
    FINERACT_DEFAULT_TENANTDB_PORT: '5432',
    FINERACT_DEFAULT_TENANTDB_NAME: TENANT_DEFAULT_DB,
    FINERACT_DEFAULT_TENANTDB_IDENTIFIER: 'default',
    FINERACT_DEFAULT_TENANTDB_TIMEZONE: 'UTC',
    FINERACT_MANAGEMENT_ENDPOINT_WEB_EXPOSURE_INCLUDE: 'health,info,prometheus',
    FINERACT_MANAGEMENT_PROMETHEUS_ENABLED: 'true',
    // INERT in 1.16.1 (no tracing bridge on the classpath): the next three settings emit no spans and the
    // sampling value does NOT control anything. Spans come from the ADOT Java agent (see app-stack.ts);
    // tune sampling there (OTEL_TRACES_SAMPLER*), not here.
    FINERACT_MANAGEMENT_TRACIING_ENABLED: 'true',
    MANAGEMENT_OTLP_TRACING_ENDPOINT: 'http://localhost:4318/v1/traces',
    MANAGEMENT_TRACING_SAMPLING_PROBABILITY: '1.0',
    FINERACT_LOGGING_JSON_ENABLED: 'true',
    FINERACT_LOGGING_HTTP_CORRELATION_ID_ENABLED: 'true',
    FINERACT_LOGGING_HTTP_CORRELATION_ID_HEADER_NAME: 'X-Correlation-ID',
    FINERACT_MANAGEMENT_METRICS_DISTRIBUTION_HTTP_SERVER_REQUESTS: 'true',
  };
}

/** Replace every `placeholder` in `text` with a (possibly unresolved) CloudFormation token. */
export function substituteToken(text: string, placeholder: string, token: string): string {
  const parts = text.split(placeholder);
  return Fn.join('', parts.flatMap((part, i) => (i === 0 ? [part] : [token, part])));
}
