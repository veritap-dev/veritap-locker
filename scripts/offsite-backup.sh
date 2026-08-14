#!/usr/bin/env bash
# #773-B3: weekly off-site encrypted backup to operator hardware.
# Encrypt-at-rest key lives ONLY on this machine (~/.veritap/backup.key).
set -euo pipefail
cd "$(dirname "$0")/.."

DATE=$(date +%F)
DEST="$HOME/VeritapBackups/$DATE"
KEY="$HOME/.veritap/backup.key"
mkdir -p "$DEST" "$HOME/.veritap"

if [ ! -f "$KEY" ]; then
  openssl rand -hex 32 > "$KEY"
  chmod 600 "$KEY"
  echo "Created NEW backup key at $KEY — copy it somewhere safe OFF this machine (paper counts)."
fi

echo "1/3 D1 export…"
npx wrangler d1 export veritap_locker --remote --output="$DEST/d1-full.sql" >/dev/null

echo "2/3 latest nightly JSON from backup bucket…"
npx wrangler r2 object get "veritap-locker-backup/d1/$DATE.json" --file="$DEST/d1-nightly.json" --remote 2>/dev/null \
  || echo "  (no nightly for $DATE yet — cron runs 05:10 UTC; SQL export above covers it)"

echo "3/3 encrypting…"
for f in "$DEST"/d1-*; do
  [ -f "$f" ] || continue
  openssl enc -aes-256-cbc -pbkdf2 -salt -in "$f" -out "$f.enc" -pass "file:$KEY"
  rm "$f"
done

# Keep 8 weekly snapshots.
ls -dt "$HOME/VeritapBackups"/*/ 2>/dev/null | tail -n +9 | xargs rm -rf 2>/dev/null || true
echo "Done: $DEST ($(du -sh "$DEST" | cut -f1))"
