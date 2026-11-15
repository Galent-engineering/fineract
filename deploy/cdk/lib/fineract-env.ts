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
 *  - Fail-fast DB access (db-outage demo): a blackholed database makes JDBC wait on the socket forever, so Fineract hangs
 *                        instead of answering 5xx. Both pools get pgjdbc connectTimeout/socketTimeout (seconds) in their URL
 *                        parameters; the tenant store pool also gets a 5 s Hikari connectionTimeout.
 *                        The tenant DB pool takes its parameters from tenant_server_connections.schema_connection_parameters,
 *                        which Liquibase fills from FINERACT_DEFAULT_TENANTDB_CONN_PARAMS ONLY when the row is first created;
 *                        an existing row is updated by the harness-dbinit one-off task (app-stack.ts). Its Hikari
 *                        connectionTimeout is not configurable by property, so a file named by -Dhikaricp.configurationFile
 *                        sets it (HikariConfig reads that file in its constructor).
 */
export const FINERACT_PORT = 8080;
export const FINERACT_CONTEXT = '/fineract-provider';
export const TENANTS_DB = 'fineract_tenants';
export const TENANT_DEFAULT_DB = 'fineract_default';
/**
 * pgjdbc seconds. socketTimeout bounds every statement, so it must exceed the longest legitimate one: this harness has
 * small tables, single COB statements are millisecond-scale, and migrations only run on a version change.
 */
export const DB_CONNECT_TIMEOUT_S = 5;
export const DB_SOCKET_TIMEOUT_S = 10;
/** Tenant store lookups are trivial and cached, so its ceiling is looser. */
export const STORE_SOCKET_TIMEOUT_S = 30;
export const DB_CONN_PARAMS = `connectTimeout=${DB_CONNECT_TIMEOUT_S}&socketTimeout=${DB_SOCKET_TIMEOUT_S}`;
/** Hikari borrow/validation timeouts (ms); the tenant-pool validation interval is a tenants-store column set by dbinit. */
export const HIKARI_CONNECTION_TIMEOUT_MS = 5000;
export const TENANT_POOL_VALIDATION_MS = 2000;
export const HIKARI_PROPERTIES_FILE = '/fbcfg/hikari.properties';

export function fineractEnvironment(dbHost: string): Record<string, string> {
  return {
    JAVA_TOOL_OPTIONS: '-Xmx5g',
    FINERACT_SERVER_SSL_ENABLED: 'false',
    FINERACT_SERVER_PORT: String(FINERACT_PORT),
    FINERACT_HIKARI_JDBC_URL: `jdbc:postgresql://${dbHost}:5432/${TENANTS_DB}?connectTimeout=${DB_CONNECT_TIMEOUT_S}&socketTimeout=${STORE_SOCKET_TIMEOUT_S}`,
    FINERACT_HIKARI_CONNECTION_TIMEOUT: String(HIKARI_CONNECTION_TIMEOUT_MS),
    FINERACT_DEFAULT_TENANTDB_CONN_PARAMS: DB_CONN_PARAMS,
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
