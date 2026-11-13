#!/usr/bin/env bash
# Delegate fineract.galent.ai from the PRODUCTION parent zone (galent.ai) to the harness child zone.
# The ONLY write: UPSERT of one NS record set named fineract.galent.ai. (TTL 300) in the parent zone.
# Refuses to run if a non-NS record named fineract.galent.ai. already exists there.
set -euo pipefail

DEV_PROFILE=galent-new-dev-1
PROD_PROFILE=galent-prod-1
PARENT_ZONE_ID=Z04718002CM1CVT3RKJ08
NAME=fineract.galent.ai.

CHILD_ZONE_ID=$(aws route53 list-hosted-zones-by-name --dns-name "$NAME" --max-items 1 --profile "$DEV_PROFILE" \
  --query "HostedZones[?Name=='$NAME'&&Config.PrivateZone==\`false\`]|[0].Id" --output text)
[ -n "$CHILD_ZONE_ID" ] && [ "$CHILD_ZONE_ID" != "None" ] || { echo "child zone $NAME not found in $DEV_PROFILE" >&2; exit 1; }

NS=$(aws route53 list-resource-record-sets --hosted-zone-id "$CHILD_ZONE_ID" --profile "$DEV_PROFILE" \
  --query "ResourceRecordSets[?Name=='$NAME'&&Type=='NS'].ResourceRecords[].Value" --output text)
COUNT=$(echo "$NS" | wc -w | tr -d ' ')
[ "$COUNT" -eq 4 ] || { echo "expected 4 child name servers, got $COUNT" >&2; exit 1; }

# Guard (read-only): abort if any non-NS record named $NAME exists in the parent zone.
OTHER=$(aws route53 list-resource-record-sets --hosted-zone-id "$PARENT_ZONE_ID" --profile "$PROD_PROFILE" \
  --start-record-name "$NAME" --max-items 20 \
  --query "ResourceRecordSets[?Name=='$NAME'&&Type!='NS'].Type" --output text)
if [ -n "$OTHER" ] && [ "$OTHER" != "None" ]; then
  echo "ABORT: non-NS record(s) [$OTHER] named $NAME already exist in the parent zone" >&2
  exit 1
fi

BATCH=$(NS="$NS" NAME="$NAME" python3 - <<'PY'
import json, os
vals = [{"Value": v} for v in os.environ["NS"].split()]
print(json.dumps({
  "Comment": "delegate fineract.galent.ai to galent-new-dev-1 harness zone",
  "Changes": [{"Action": "UPSERT", "ResourceRecordSet": {
    "Name": os.environ["NAME"], "Type": "NS", "TTL": 300, "ResourceRecords": vals}}]}, indent=2))
PY
)
echo "Planned change against parent zone $PARENT_ZONE_ID ($PROD_PROFILE):"
echo "$BATCH"

CHANGE_ID=$(aws route53 change-resource-record-sets --hosted-zone-id "$PARENT_ZONE_ID" --profile "$PROD_PROFILE" \
  --change-batch "$BATCH" --query ChangeInfo.Id --output text)
echo "change id: $CHANGE_ID"
aws route53 wait resource-record-sets-changed --id "$CHANGE_ID" --profile "$PROD_PROFILE"
echo "INSYNC: $CHANGE_ID"
