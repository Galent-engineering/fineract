#!/usr/bin/env bash
# Remove the fineract.galent.ai NS delegation from the PRODUCTION parent zone (galent.ai).
# Run this BEFORE `cdk destroy HarnessDns`, otherwise the parent keeps delegating to name servers that no
# longer host the zone (dangling delegation = subdomain takeover risk).
#
# Required environment (no production identifiers are committed to this repo):
#   PARENT_ZONE_ID  hosted zone id of the parent galent.ai zone
#   PARENT_PROFILE  AWS CLI profile with access to that zone
# Without --yes this only PRINTS the DELETE change batch; it writes nothing.
# With --yes it submits the DELETE. The batch uses the NS values currently in the parent zone, so it matches.
set -euo pipefail

: "${PARENT_ZONE_ID:?set PARENT_ZONE_ID to the parent galent.ai hosted zone id}"
: "${PARENT_PROFILE:?set PARENT_PROFILE to the AWS profile for the parent zone}"
NAME=fineract.galent.ai.
YES=0
case "${1:-}" in
  --yes) YES=1 ;;
  "") ;;
  *) echo "usage: $0 [--yes]" >&2; exit 2 ;;
esac

# Read-only: the current NS record set (exact TTL and values are required for a DELETE to match).
CURRENT=$(aws route53 list-resource-record-sets --hosted-zone-id "$PARENT_ZONE_ID" --profile "$PARENT_PROFILE" \
  --start-record-name "$NAME" --start-record-type NS --max-items 1 \
  --query "ResourceRecordSets[?Name=='$NAME'&&Type=='NS']|[0]" --output json)
if [ -z "$CURRENT" ] || [ "$CURRENT" = "null" ]; then
  echo "no NS record named $NAME in the parent zone; nothing to remove"
  exit 0
fi

BATCH=$(CURRENT="$CURRENT" python3 - <<'PY'
import json, os
rrset = json.loads(os.environ["CURRENT"])
print(json.dumps({
  "Comment": "remove fineract.galent.ai delegation before destroying the harness zone",
  "Changes": [{"Action": "DELETE", "ResourceRecordSet": rrset}]}, indent=2))
PY
)
echo "DELETE change batch for parent zone $PARENT_ZONE_ID (profile $PARENT_PROFILE):"
echo "$BATCH"

if [ "$YES" -ne 1 ]; then
  echo "dry run: nothing written. Re-run with --yes to submit." >&2
  exit 0
fi

CHANGE_ID=$(aws route53 change-resource-record-sets --hosted-zone-id "$PARENT_ZONE_ID" --profile "$PARENT_PROFILE" \
  --change-batch "$BATCH" --query ChangeInfo.Id --output text)
echo "change id: $CHANGE_ID"
aws route53 wait resource-record-sets-changed --id "$CHANGE_ID" --profile "$PARENT_PROFILE"
echo "INSYNC: $CHANGE_ID"
