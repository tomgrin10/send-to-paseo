#!/usr/bin/env bash
# Run once with a personal Google account that owns the selected Cloud project.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: bash scripts/setup-chrome-publishing.sh GOOGLE_ACCOUNT CLOUD_PROJECT_ID CWS_PUBLISHER_ID" >&2
  exit 1
fi
publishing_account="$1"
publishing_project="$2"
publisher_id="$3"
publishing_repo="tomgrin10/send-to-paseo"
pool_id="send-to-paseo-github"
provider_id="github"
service_id="chrome-web-store"
service_email="$service_id@$publishing_project.iam.gserviceaccount.com"

[[ "$publishing_project" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]
[[ "$publisher_id" =~ ^[A-Za-z0-9_-]+$ ]]
command -v gcloud >/dev/null
command -v gh >/dev/null
if [ "$(gh api "repos/$publishing_repo" --jq '.permissions.admin')" != "true" ]; then
  echo "GitHub admin access is required. Sign into gh as tomgrin10 before running setup." >&2
  exit 1
fi
if ! gcloud auth list --filter="account=$publishing_account" --format='value(account)' | rg -Fx "$publishing_account" >/dev/null; then
  gcloud auth login "$publishing_account"
fi
# Every Cloud command explicitly selects the account and project; no global config changes.
cloud() { gcloud --account="$publishing_account" --project="$publishing_project" "$@"; }
if ! cloud projects describe "$publishing_project" >/dev/null 2>&1; then
  cloud projects create "$publishing_project" --name="Send to Paseo publishing"
fi
project_number="$(cloud projects describe "$publishing_project" --format='value(projectNumber)')"
repo_id="$(gh api "repos/$publishing_repo" --jq '.id')"
owner_id="$(gh api "repos/$publishing_repo" --jq '.owner.id')"
cloud services enable chromewebstore.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com

if ! cloud iam service-accounts describe "$service_email" >/dev/null 2>&1; then
  cloud iam service-accounts create "$service_id" --display-name="Send to Paseo Chrome publishing"
fi
if ! cloud iam workload-identity-pools describe "$pool_id" --location=global >/dev/null 2>&1; then
  cloud iam workload-identity-pools create "$pool_id" --location=global --display-name="Send to Paseo GitHub"
fi
mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id"
condition="assertion.repository_id == '$repo_id' && assertion.repository_owner_id == '$owner_id' && assertion.sub == 'repo:$publishing_repo:environment:chrome-web-store' && (assertion.ref == 'refs/heads/main' || assertion.ref.startsWith('refs/tags/v')) && (assertion.event_name == 'push' || assertion.event_name == 'workflow_dispatch')"
if cloud iam workload-identity-pools providers describe "$provider_id" --workload-identity-pool="$pool_id" --location=global >/dev/null 2>&1; then
  cloud iam workload-identity-pools providers update-oidc "$provider_id" \
    --workload-identity-pool="$pool_id" --location=global \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="$mapping" --attribute-condition="$condition"
else
  cloud iam workload-identity-pools providers create-oidc "$provider_id" \
    --workload-identity-pool="$pool_id" --location=global \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="$mapping" --attribute-condition="$condition"
fi
cloud iam service-accounts add-iam-policy-binding "$service_email" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$project_number/locations/global/workloadIdentityPools/$pool_id/attribute.repository_id/$repo_id"

# These values are identifiers, not secrets. No service-account key is created.
gh api --method PUT "repos/$publishing_repo/environments/chrome-web-store" >/dev/null
gh variable set CWS_PUBLISHER_ID --repo "$publishing_repo" --env chrome-web-store --body "$publisher_id"
gh variable set CWS_SERVICE_ACCOUNT --repo "$publishing_repo" --env chrome-web-store --body "$service_email"
gh variable set CWS_WORKLOAD_IDENTITY_PROVIDER --repo "$publishing_repo" --env chrome-web-store \
  --body "projects/$project_number/locations/global/workloadIdentityPools/$pool_id/providers/$provider_id"

printf '\nAdd this service account under Account in the Chrome Web Store developer dashboard:\n%s\n' "$service_email"
echo "Then verify access: gh workflow run publish-chrome.yml --repo $publishing_repo --ref main -f operation=status"
