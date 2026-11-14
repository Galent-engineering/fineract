#!/usr/bin/env bash
# Resume the harness: start RDS, wait until available, restore ECS desired counts, clear the paused flag,
# then verify Fineract through the ALB. Idempotent.
# Usage: resume.sh [--profile <aws profile>]   (default galent-new-dev-1, region us-east-1)
set -euo pipefail

PROFILE=galent-new-dev-1
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    *) echo "usage: $0 [--profile <name>]" >&2; exit 2 ;;
  esac
done
export AWS_PROFILE="$PROFILE" AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1 AWS_PAGER=""

DB=$(aws cloudformation describe-stacks --stack-name HarnessPause \
  --query "Stacks[0].Outputs[?OutputKey=='DbInstanceIdentifier'].OutputValue" --output text)
[ -n "$DB" ] && [ "$DB" != "None" ] || { echo "HarnessPause stack not deployed" >&2; exit 1; }
db_status() { aws rds describe-db-instances --db-instance-identifier "$DB" --query 'DBInstances[0].DBInstanceStatus' --output text; }

# 1. Start the database and wait for it. (Flag stays "true" until the DB is up, so the re-stop Lambda
#    cannot be fooled; RDS-EVENT-0154 is only raised for the 7-day auto-start, not for a manual start.)
while :; do
  st=$(db_status)
  case "$st" in
    stopped) aws rds start-db-instance --db-instance-identifier "$DB" >/dev/null; echo "starting $DB" ;;
    available) break ;;
    *) echo "  rds: $st (waiting)" ;;
  esac
  sleep 30
done
aws rds wait db-instance-available --db-instance-identifier "$DB"
echo "rds available"

# 2. Restore the counts saved by pause.sh (fallback: 1 each).
saved=$(aws ssm get-parameter --name /harness/desired-counts --query Parameter.Value --output text 2>/dev/null || echo '{}')
SERVICES="harness:fineract harness:webapp harness:traffic harness-obs:obs"
for cs in $SERVICES; do
  c=${cs%%:*}; s=${cs##*:}
  n=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get(sys.argv[2], 1))' "$saved" "$cs")
  aws ecs update-service --cluster "$c" --service "$s" --desired-count "$n" >/dev/null
  echo "$s -> $n"
done
aws ssm put-parameter --name /harness/paused --type String --overwrite --value false >/dev/null

# 3. Wait for steady state (Fineract boots slowly; the waiter polls up to ~10 min, so loop).
for cs in $SERVICES; do
  c=${cs%%:*}; s=${cs##*:}
  until aws ecs wait services-stable --cluster "$c" --services "$s" 2>/dev/null; do echo "  $s not steady yet"; done
  echo "$s steady"
done

# 4. Verify through the ALB. /actuator is 404 at the ALB, so call an authenticated API with the read-only
#    API user; credentials are read into variables here and never printed.
SECRET=$(aws secretsmanager get-secret-value --secret-id harness/fineract/reliability-api --query SecretString --output text)
FUSER=$(printf '%s' "$SECRET" | python3 -c 'import sys,json; print(json.load(sys.stdin)["username"])')
FPASS=$(printf '%s' "$SECRET" | python3 -c 'import sys,json; print(json.load(sys.stdin)["password"])')
unset SECRET
URL=https://fineract.galent.ai/fineract-provider/api/v1/offices
code=000
for _ in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -u "$FUSER:$FPASS" \
    -H 'Fineract-Platform-TenantId: default' "$URL" || true)
  [ "$code" = 200 ] && break
  echo "  offices -> $code"; sleep 15
done
[ "$code" = 200 ] || { echo "FAILED: offices returned $code" >&2; exit 1; }
echo "resumed: GET /api/v1/offices -> 200"
