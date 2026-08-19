#!/usr/bin/env bash
# =============================================================================
# AIToolsNova — Cloudflare Domain & Traffic Diagnostic/Fix Script
#
# Runs inside GitHub Actions (ubuntu-latest) so it has internet access to
# api.cloudflare.com. The sandbox where this repo is edited cannot reach
# api.cloudflare.com, so this script is the "hands" for Cloudflare changes.
#
# Env:
#   CF_TOKEN  (required)  Cloudflare API token (repo secret CLOUDFLARE_API_TOKEN)
#   FIX       "true" to APPLY fixes; anything else = diagnose only (default)
#   REPORT    path to write the markdown report (default ./cf-report.md)
#
# Safety: every change is logged. With FIX != "true" nothing is modified.
# =============================================================================
set -euo pipefail

CF_TOKEN="${CF_TOKEN:-}"
FIX="${FIX:-false}"
REPORT="${REPORT:-cf-report.md}"
API="https://api.cloudflare.com/client/v4"

TARGET_DOMAIN="aitoolsnova.com"
WWW_DOMAIN="www.aitoolsnova.com"
PAGES_SUBDOMAIN="aitoolsnova.pages.dev"

LOG=""
log()  { printf '%s\n' "$*" >> "$REPORT"; }
log2() { printf '  %s\n' "$*" >> "$REPORT"; }
err()  { printf '  [WARN] %s\n' "$*" >> "$REPORT"; }

cf() { # cf METHOD PATH [DATA_FILE] -> prints response JSON to stdout
  local method="$1" path="$2" data="${3:-}"
  if [ -n "$data" ]; then
    curl -sS -X "$method" -H "Authorization: Bearer $CF_TOKEN" \
      -H "Content-Type: application/json" \
      --data-binary "@$data" "$API$path"
  else
    curl -sS -X "$method" -H "Authorization: Bearer $CF_TOKEN" "$API$path"
  fi
}

ok() { # ok <json> -> returns 0 if json.success == true
  printf '%s' "$1" | jq -e '.success == true' >/dev/null 2>&1
}

: > "$REPORT"
log "# Cloudflare Fix Report — $(date -u '+%Y-%m-%d %H:%M UTC')"
log ""
log "Mode: **$([ "$FIX" = "true" ] && echo 'FIX (changes applied)' || echo 'DIAGNOSE ONLY (no changes)')**"
log ""

# ----------------------------------------------------------------------------
log "## 1. Token check"
# ----------------------------------------------------------------------------
V=$(cf GET /user/tokens/verify || echo '{"success":false}')
if ! ok "$V"; then
  log "**FAILED**: token invalid or expired. $(printf '%s' "$V" | jq -c '.errors // .')"
  log ""
  cat "$REPORT"
  exit 1
fi
log "Token OK (status: $(printf '%s' "$V" | jq -r '.result.status // "?"'))"
log ""

# ----------------------------------------------------------------------------
log "## 2. Accounts"
# ----------------------------------------------------------------------------
ACCS=$(cf GET "/accounts?per_page=50")
if ! ok "$ACCS"; then
  log "**FAILED**: cannot list accounts. $(printf '%s' "$ACCS" | jq -c '.errors // .')"
  cat "$REPORT"
  exit 1
fi
ACCOUNT_IDS=($(printf '%s' "$ACCS" | jq -r '.result[].id'))
ACCOUNT_NAMES=($(printf '%s' "$ACCS" | jq -r '.result[].name'))
log "Accounts found: ${#ACCOUNT_IDS[@]}"
for i in "${!ACCOUNT_IDS[@]}"; do
  log2 "- ${ACCOUNT_NAMES[$i]} (${ACCOUNT_IDS[$i]})"
done
log ""

# ----------------------------------------------------------------------------
log "## 3. Pages projects + custom domains"
# ----------------------------------------------------------------------------
PAGES_PROJECT=""
PAGES_ACCOUNT=""
for acc in "${ACCOUNT_IDS[@]}"; do
  PROJS=$(cf GET "/accounts/$acc/pages/projects?per_page=100")
  if ! ok "$PROJS"; then continue; fi
  PROJ_NAMES=($(printf '%s' "$PROJS" | jq -r '.result[].name'))
  for pn in "${PROJ_NAMES[@]}"; do
    SUB=$(printf '%s' "$PROJS" | jq -r --arg p "$pn" '.result[] | select(.name==$p) | .subdomain')
    DOMS=$(printf '%s' "$PROJS" | jq -r --arg p "$pn" '.result[] | select(.name==$p) | .domains[]?' 2>/dev/null || true)
    DEP=$(printf '%s' "$PROJS" | jq -r --arg p "$pn" '.result[] | select(.name==$p) | (.latest_deployment.created_on // "none")' 2>/dev/null || true)
    log "### Project: $pn"
    log2 "- subdomain: $SUB"
    log2 "- custom domains: $(echo "${DOMS:-none}" | tr '\n' ' ')"
    log2 "- latest deployment: $DEP"
    if [ "$SUB" = "$PAGES_SUBDOMAIN" ]; then
      PAGES_PROJECT="$pn"
      PAGES_ACCOUNT="$acc"
      log2 "- **THIS is the aitoolsnova project (account $acc)**"
      D=$(cf GET "/accounts/$acc/pages/projects/$pn/domains?per_page=100")
      log2 "- domain bindings (API):"
      if ok "$D"; then
        printf '%s' "$D" | jq -r '.result[] | "    - " + .name + "  status=" + (.status // "?")' >> "$REPORT"
      fi
    fi
    log ""
  done
done

if [ -z "$PAGES_PROJECT" ]; then
  log "**WARNING**: no Pages project found with subdomain $PAGES_SUBDOMAIN"
fi
log ""

# ----------------------------------------------------------------------------
log "## 4. Zones + DNS"
# ----------------------------------------------------------------------------
ZONE_ID=""
for acc in "${ACCOUNT_IDS[@]}"; do
  ZS=$(cf GET "/zones?per_page=100&account.id=$acc")
  if ! ok "$ZS"; then continue; fi
  Z_NAMES=($(printf '%s' "$ZS" | jq -r '.result[].name'))
  Z_IDS=($(printf '%s' "$ZS" | jq -r '.result[].id'))
  for i in "${!Z_NAMES[@]}"; do
    zname="${Z_NAMES[$i]}"
    zid="${Z_IDS[$i]}"
    zstatus=$(printf '%s' "$ZS" | jq -r --arg n "$zname" '.result[] | select(.name==$n) | .status')
    zplan=$(printf '%s' "$ZS" | jq -r --arg n "$zname" '.result[] | select(.name==$n) | .plan.name // "?"' 2>/dev/null || echo "?")
    log "### Zone: $zname (status=$zstatus, plan=$zplan, id=$zid)"
    if [ "$zname" = "$TARGET_DOMAIN" ]; then ZONE_ID="$zid"; fi

    DNS=$(cf GET "/zones/$zid/dns_records?per_page=100&page=1")
    if ok "$DNS"; then
      log2 "DNS records:"
      printf '%s' "$DNS" | jq -r '.result[] | "    - \(.type) \(.name)  -> \(.content)  proxied=\(.proxied)  id=\(.id)"' >> "$REPORT"
    else
      err "cannot list DNS records"
    fi
    log ""
  done
done

if [ -n "$ZONE_ID" ]; then
  Z="$ZONE_ID"

  log "## 5. Zone security settings ($TARGET_DOMAIN)"
  SL=$(cf GET "/zones/$Z/settings/security_level")
  log "- security_level: $(printf '%s' "$SL" | jq -r '.result.value // "?"')"
  BC=$(cf GET "/zones/$Z/settings/browser_check")
  log "- browser_check: $(printf '%s' "$BC" | jq -r '.result.value // "?"')"
  SS=$(cf GET "/zones/$Z/settings/ssl")
  log "- ssl mode: $(printf '%s' "$SS" | jq -r '.result.value // "?"')"
  BM=$(cf GET "/zones/$Z/bot_management")
  if ok "$BM"; then
    log "- bot_management: fight_mode=$(printf '%s' "$BM" | jq -r '.result.fight_mode // "?"') verified_bots=$(printf '%s' "$BM" | jq -r '.result.verified_bots // "?"') enable_js=$(printf '%s' "$BM" | jq -r '.result.enable_js // "?"')"
  else
    err "bot_management not readable (plan limit?)"
  fi

  log ""
  log "## 6. WAF / firewall / IP rules"
  FR=$(cf GET "/zones/$Z/firewall/rules?per_page=100")
  if ok "$FR"; then
    log "Firewall rules:"
    printf '%s' "$FR" | jq -r '.result[] | "    - id=\(.id) action=\(.action) filter=\(.filter.expression // .filter.paused // "?")"' >> "$REPORT"
  else
    err "firewall rules not readable"
  fi
  IR=$(cf GET "/zones/$Z/firewall/access_rules/rules?per_page=100")
  if ok "$IR"; then
    log "IP access rules:"
    printf '%s' "$IR" | jq -r '.result[] | "    - id=\(.id) action=\(.mode) target=\(.configuration.target):\(.configuration.value) note=\(.notes // "")"' >> "$REPORT"
  else
    err "ip access rules not readable"
  fi
  RS=$(cf GET "/zones/$Z/rulesets")
  if ok "$RS"; then
    log "Rulesets:"
    printf '%s' "$RS" | jq -r '.result[] | "    - phase=\(.phase) kind=\(.kind) id=\(.id)"' >> "$REPORT"
    # rules inside each ruleset
    for rid in $(printf '%s' "$RS" | jq -r '.result[].id'); do
      RLD=$(cf GET "/zones/$Z/rulesets/$rid")
      if ok "$RLD"; then
        printf '%s' "$RLD" | jq -r '.result.rules[]? | "        rule id=\(.id) action=\(.action) expression=\(.expression // .action_parameters.to.url // "")"' >> "$REPORT"
      fi
    done
  else
    err "rulesets not readable"
  fi
  BR=$(cf GET "/zones/$Z/bulk_redirects")
  if ok "$BR"; then
    log "Bulk redirects:"
    printf '%s' "$BR" | jq -r '.result[] | "    - id=\(.id) name=\(.name) rules=\(.rules|length)"' >> "$REPORT"
    printf '%s' "$BR" | jq -r '.result[] | .rules[] | "        \(.expression // "?")  ->  \(.action.from_value.status_code // "?") \(.action.from_value.target_url.url // "?")"' >> "$REPORT"
  else
    err "bulk_redirects not readable"
  fi
  log ""

  log "## 6b. Account-level IP access rules (all zones)"
  for acc in "${ACCOUNT_IDS[@]}"; do
    AIR=$(cf GET "/accounts/$acc/firewall/access_rules/rules?per_page=100")
    if ok "$AIR"; then
      N=$(printf '%s' "$AIR" | jq '.result | length')
      log2 "account $acc: $N rule(s)"
      printf '%s' "$AIR" | jq -r '.result[] | "    - id=\(.id) action=\(.mode) target=\(.configuration.target):\(.configuration.value) note=\(.notes // "")"' >> "$REPORT"
    fi
  done
fi
log ""

# ----------------------------------------------------------------------------
# 7. APPLY FIXES (only when FIX=true)
# ----------------------------------------------------------------------------
if [ "$FIX" = "true" ] && [ -n "$PAGES_PROJECT" ] && [ -n "$PAGES_ACCOUNT" ]; then
  log "## 7. Fixes applied"
  PA="$PAGES_ACCOUNT"
  PP="$PAGES_PROJECT"

  # 7.1 Pages custom domains: keep only apex + www + the default pages.dev
  # subdomain; remove anything else (e.g. a wrongly-bound domain)
  D=$(cf GET "/accounts/$PA/pages/projects/$PP/domains?per_page=100")
  if ok "$D"; then
    for dom in $(printf '%s' "$D" | jq -r '.result[].name'); do
      if [ "$dom" = "$TARGET_DOMAIN" ] || [ "$dom" = "$WWW_DOMAIN" ] || [ "$dom" = "$PAGES_SUBDOMAIN" ]; then
        log2 "- keep custom domain: $dom"
      else
        log2 "- REMOVE wrong custom domain: $dom"
        R=$(cf DELETE "/accounts/$PA/pages/projects/$PP/domains/$dom")
        ok "$R" && log2 "    -> removed OK" || log2 "    -> remove FAILED: $(printf '%s' "$R" | jq -c '.errors // .')"
      fi
    done
    # add missing apex
    if ! printf '%s' "$D" | jq -e --arg d "$TARGET_DOMAIN" '.result[] | select(.name==$d)' >/dev/null 2>&1; then
      log2 "- ADD custom domain: $TARGET_DOMAIN"
      TMP=$(mktemp)
      printf '{"name":"%s"}' "$TARGET_DOMAIN" > "$TMP"
      R=$(cf POST "/accounts/$PA/pages/projects/$PP/domains" "$TMP")
      ok "$R" && log2 "    -> add OK: $(printf '%s' "$R" | jq -r '.result.status // "?"')" || log2 "    -> add FAILED: $(printf '%s' "$R" | jq -c '.errors // .')"
      rm -f "$TMP"
    fi
    # add missing www
    if ! printf '%s' "$D" | jq -e --arg d "$WWW_DOMAIN" '.result[] | select(.name==$d)' >/dev/null 2>&1; then
      log2 "- ADD custom domain: $WWW_DOMAIN"
      TMP=$(mktemp)
      printf '{"name":"%s"}' "$WWW_DOMAIN" > "$TMP"
      R=$(cf POST "/accounts/$PA/pages/projects/$PP/domains" "$TMP")
      ok "$R" && log2 "    -> add OK: $(printf '%s' "$R" | jq -r '.result.status // "?"')" || log2 "    -> add FAILED: $(printf '%s' "$R" | jq -c '.errors // .')"
      rm -f "$TMP"
    fi
  fi

  # 7.2 Zone security: unblock traffic
  if [ -n "$ZONE_ID" ]; then
    Z="$ZONE_ID"
    SL=$(cf GET "/zones/$Z/settings/security_level")
    if ok "$SL"; then
      LV=$(printf '%s' "$SL" | jq -r '.result.value')
      if [ "$LV" = "under_attack" ]; then
        log2 "- security_level was under_attack -> setting to medium"
        TMP=$(mktemp); printf '{"value":"medium"}' > "$TMP"
        R=$(cf PATCH "/zones/$Z/settings/security_level" "$TMP"); rm -f "$TMP"
        ok "$R" && log2 "    -> set medium OK" || log2 "    -> FAILED: $(printf '%s' "$R" | jq -c '.errors // .')"
      else
        log2 "- security_level = $LV (no change)"
      fi
    fi
    # Bot Fight Mode off (blocks crawlers => GSC/Bing data stops)
    BM=$(cf GET "/zones/$Z/bot_management")
    if ok "$BM" && [ "$(printf '%s' "$BM" | jq -r '.result.fight_mode // false')" = "true" ]; then
      log2 "- bot_management fight_mode was ON -> turning OFF (so Google/Bing can crawl)"
      TMP=$(mktemp); printf '{"fight_mode":false}' > "$TMP"
      R=$(cf PUT "/zones/$Z/bot_management" "$TMP"); rm -f "$TMP"
      ok "$R" && log2 "    -> fight_mode off OK" || log2 "    -> FAILED: $(printf '%s' "$R" | jq -c '.errors // .')"
    else
      log2 "- bot_management: no fight_mode change needed"
    fi
    # Remove IP access rules that block everything (keep country/IP-specific blocks intact)
    IR=$(cf GET "/zones/$Z/firewall/access_rules/rules?per_page=100")
    if ok "$IR"; then
      for rid in $(printf '%s' "$IR" | jq -r '.result[] | select(.mode=="block") | select((.configuration.target=="any") or (.configuration.value=="*") or (.configuration.value=="0.0.0.0/0") or (.configuration.value=="::/0")) | .id' 2>/dev/null || true); do
        NOTE=$(printf '%s' "$IR" | jq -r --arg id "$rid" '.result[] | select(.id==$id) | .notes // ""')
        log2 "- REMOVE blocking IP rule: $rid (note: $NOTE)"
        R=$(cf DELETE "/zones/$Z/firewall/access_rules/rules/$rid")
        ok "$R" && log2 "    -> removed OK" || log2 "    -> FAILED: $(printf '%s' "$R" | jq -c '.errors // .')"
      done
    fi
    # Firewall rules whose filter expression blocks everything
    FR=$(cf GET "/zones/$Z/firewall/rules?per_page=100")
    if ok "$FR"; then
      # remove only rules that block ALL traffic (expression == true) — the classic
      # "traffic blocked on whole website" culprit. Everything else is left alone.
      for rid in $(printf '%s' "$FR" | jq -r '.result[] | select(.action=="block") | select(.filter.expression=="true") | .id' 2>/dev/null || true); do
        log2 "- REMOVE blocking firewall rule (blocks all traffic): $rid"
        R=$(cf DELETE "/zones/$Z/firewall/rules/$rid")
        ok "$R" && log2 "    -> removed OK" || log2 "    -> FAILED: $(printf '%s' "$R" | jq -c '.errors // .')"
      done
    fi
    # 7.3 Account-level IP access rules that block everything
    for acc in "${ACCOUNT_IDS[@]}"; do
      AIR=$(cf GET "/accounts/$acc/firewall/access_rules/rules?per_page=100")
      if ok "$AIR"; then
        for rid in $(printf '%s' "$AIR" | jq -r '.result[] | select(.mode=="block") | select((.configuration.target=="any") or (.configuration.value=="*") or (.configuration.value=="0.0.0.0/0") or (.configuration.value=="::/0")) | .id' 2>/dev/null || true); do
          log2 "- REMOVE account-level blocking rule: $rid"
          R=$(cf DELETE "/accounts/$acc/firewall/access_rules/rules/$rid")
          ok "$R" && log2 "    -> removed OK" || log2 "    -> FAILED: $(printf '%s' "$R" | jq -c '.errors // .')"
        done
      fi
    done
    # 7.4 Purge cache
    log2 "- purge cache (everything)"
    TMP=$(mktemp); printf '{"purge_everything":true}' > "$TMP"
    R=$(cf POST "/zones/$Z/purge_cache" "$TMP"); rm -f "$TMP"
    ok "$R" && log2 "    -> cache purged OK" || log2 "    -> purge FAILED: $(printf '%s' "$R" | jq -c '.errors // .')"
  fi
fi
log ""

# ----------------------------------------------------------------------------
log "## 8. Live verification (from runner)"
# ----------------------------------------------------------------------------
for url in "https://$TARGET_DOMAIN/" "https://$WWW_DOMAIN/" "https://$PAGES_SUBDOMAIN/" "https://$TARGET_DOMAIN/robots.txt" "https://$TARGET_DOMAIN/sitemap.xml"; do
  OUT=$(curl -sS -o /dev/null -w '%{http_code} final=%{url_effective}' -L -A "Mozilla/5.0" --max-time 20 "$url" || echo "curl-error")
  log2 "- $url  ->  $OUT"
done
log ""

cat "$REPORT"
