#!/bin/sh
set -eu

for name in DATABASE_URL BACKUP_S3_URI BACKUP_AGE_RECIPIENT; do
  eval "value=\${$name:-}"
  [ -n "$value" ] || { echo "$name is required" >&2; exit 1; }
done

stamp="$(date -u +%Y%m%d-%H%M%S)"
plain="/tmp/pdv-jcs-${stamp}.dump"
encrypted="${plain}.age"
checksum="${encrypted}.sha256"
trap 'rm -f "$plain" "$encrypted" "$checksum"' EXIT

pg_dump "$DATABASE_URL" --format=custom --no-owner --file="$plain"
pg_restore --list "$plain" >/dev/null
age --recipient "$BACKUP_AGE_RECIPIENT" --output "$encrypted" "$plain"
(cd /tmp && sha256sum "$(basename "$encrypted")" >"$(basename "$checksum")")

destination="${BACKUP_S3_URI%/}/$(basename "$encrypted")"
aws s3 cp "$encrypted" "$destination" --only-show-errors
aws s3 cp "$checksum" "${destination}.sha256" --only-show-errors
echo "Encrypted backup uploaded: $(basename "$encrypted")"
