#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:4000}"
WORKSPACE_ID="11111111-1111-1111-1111-111111111111"
AUTHOR_ID="22222222-2222-2222-2222-222222222222"
DECIDER_ID="33333333-3333-3333-3333-333333333333"

echo "[1/8] health"
curl -sS "$API_URL/v1/internal/health" >/dev/null

echo "[2/8] storage mode"
curl -sS "$API_URL/v1/internal/storage" >/dev/null

echo "[3/8] connect LinkedIn account"
ACCOUNT_JSON=$(curl -sS -X POST "$API_URL/v1/linkedin/accounts/connect" \
  -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$WORKSPACE_ID\",\"linkedinMemberId\":\"member-1\",\"displayName\":\"Founder\",\"capabilities\":{\"canPublishPosts\":true,\"canReadComments\":true,\"canWriteCommentReplies\":false,\"canReadPostAnalytics\":true,\"hasWebhookSupport\":false,\"requiresManualPublish\":true,\"requiresManualReply\":true}}")
ACCOUNT_ID=$(python3 - <<PY
import json
print(json.loads('''$ACCOUNT_JSON''')['account']['id'])
PY
)

echo "[4/8] create draft"
DRAFT_JSON=$(curl -sS -X POST "$API_URL/v1/posts/drafts" \
  -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$WORKSPACE_ID\",\"authorUserId\":\"$AUTHOR_ID\",\"title\":\"Test\",\"content\":\"hello linkedin\"}")
DRAFT_ID=$(python3 - <<PY
import json
print(json.loads('''$DRAFT_JSON''')['draft']['id'])
PY
)

echo "[5/8] schedule post due now"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
curl -sS -X POST "$API_URL/v1/posts/scheduled" \
  -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$WORKSPACE_ID\",\"draftId\":\"$DRAFT_ID\",\"linkedInAccountId\":\"$ACCOUNT_ID\",\"scheduledFor\":\"$NOW\",\"policyMode\":\"approval\"}" >/dev/null

echo "[6/8] dispatch due"
curl -sS -X POST "$API_URL/v1/internal/scheduler/dispatch-due" >/dev/null

echo "[7/8] approve first approval"
APPROVALS=$(curl -sS "$API_URL/v1/approvals?workspaceId=$WORKSPACE_ID&status=PENDING")
APPROVAL_ID=$(python3 - <<PY
import json
a=json.loads('''$APPROVALS''')['approvals']
print(a[0]['id'])
PY
)
curl -sS -X POST "$API_URL/v1/approvals/$APPROVAL_ID/approve" \
  -H 'content-type: application/json' \
  -d "{\"decidedByUserId\":\"$DECIDER_ID\"}" >/dev/null

echo "[8/8] verify published posts"
PUBLISHED=$(curl -sS "$API_URL/v1/posts/published?workspaceId=$WORKSPACE_ID")
python3 - <<PY
import json
rows=json.loads('''$PUBLISHED''')['publishedPosts']
assert len(rows) >= 1
print('published_count=', len(rows))
PY

echo "Smoke flow complete"
