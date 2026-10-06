# Automated releases

Pushing a `vX.Y.Z` tag runs `.github/workflows/publish-npm.yml`:

1. Require the tagged commit to be on `main` and all four version fields to match.
2. Run plugin verification, extension verification, and publisher regression tests.
3. Build and validate `send-to-paseo-extension.zip` from the shipping build.
4. Publish the plugin through npm Trusted Publishing.
5. Create the GitHub release with generated notes and attach the verified ZIP.
6. Authenticate to Google using GitHub OIDC and upload the same ZIP through Chrome Web Store API v2.
7. Submit with `DEFAULT_PUBLISH`: Google reviews it, then publishes it automatically on approval.

Store-installed extensions receive updates through Chrome. Unpacked extensions still need the new
ZIP. Google controls review timing and approval. A submission is not evidence that the version is
already available to users. Listing text, images, privacy disclosures, and distribution settings
remain in the dashboard: API v2 handles packages and publication, not those fields.

The existing visibility is preserved. Do not change Unlisted/Public settings as part of a release.
If you change visibility manually, Chrome requires a manual publication with that visibility before
API publishing resumes.

## One-time account setup

Store item: `blflbbgkckbabbkoigpocilbkkmfijfg`.
Publisher: `a35e2ff0-87d3-42e1-a181-82305b58e8a6`.

Use a personal Google Cloud project. Install the Google Cloud CLI, GitHub CLI, and ripgrep. For
Tom's publisher, run from a laptop checkout of this repository:

```sh
gh auth login
gh auth switch --user tomgrin10
bash scripts/setup-chrome-publishing.sh \
  tomgrin10@gmail.com send-to-paseo-1353553015 a35e2ff0-87d3-42e1-a181-82305b58e8a6
```

The script opens Google sign-in if needed and creates the personal project if it does not exist.
An existing project can be used by replacing `send-to-paseo-1353553015` with its project ID.
The setup script enables the required APIs, creates a service account and Workload Identity
Federation provider, grants impersonation access, and sets these GitHub environment variables
in `chrome-web-store`:

| Variable | Value |
| --- | --- |
| `CWS_PUBLISHER_ID` | Chrome publisher ID |
| `CWS_SERVICE_ACCOUNT` | `chrome-web-store@YOUR_PROJECT_ID.iam.gserviceaccount.com` |
| `CWS_WORKLOAD_IDENTITY_PROVIDER` | Full Google Workload Identity provider resource name |

No service-account key or refresh token is needed. Google trusts this repository's numeric owner
and repository IDs, the `chrome-web-store` environment, and release-tag/main workflow runs.
The service account gets `roles/iam.workloadIdentityUser` impersonation access, not project-wide
administration permissions. Each Cloud command specifies its account and project without changing
global gcloud configuration. Rerunning the setup script updates the dedicated provider and bindings.

**In the Chrome Web Store dashboard → Account, add the service account email printed by the
script.** Chrome currently allows one linked service account per publisher. This is the one dashboard
action needed to grant the pipeline publishing access; GitHub/Google Cloud setup cannot replace it.

Verify access without uploading or submitting anything:

```sh
gh workflow run publish-chrome.yml --repo tomgrin10/send-to-paseo --ref main -f operation=status
gh run list --repo tomgrin10/send-to-paseo --workflow publish-chrome.yml --limit 3
```

Initial publication must have completed the Listing and Privacy fields, account requirements, and
manual visibility publication requirement. Enable this automation before the next version tag.
Missing account configuration fails the Chrome job with setup instructions; npm and the GitHub
release will already have completed.

## Release and recovery

Follow the versioning and manual release checks in `AGENTS.md`, then push the release tag. Everything
from that tag through uploading, review submission, and publication on approval is automatic.
Release tags are immutable; never reuse or move an existing tag. CI changes alone do not require
a new extension version.

If Chrome publishing fails after the GitHub release exists, retry only Chrome:

```sh
gh workflow run publish-chrome.yml --repo tomgrin10/send-to-paseo --ref main \
  -f operation=publish -f tag=vX.Y.Z
```

The retry downloads the existing release ZIP, verifies its manifest against the tagged source,
and checks store status before mutating anything. It skips versions already pending review or
published, rejects stale versions, and refuses to cancel or replace another pending/staged
submission. Wait for the other review to finish, then retry. It polls asynchronous upload processing
before submission and fails on processing errors or timeouts. It never retries a write request blindly.

Read store status at any time using the `status` command above. API responses and warnings are in
the job logs, and the Actions summary links to the store. Google review rejections require addressing
the dashboard feedback before retrying or releasing a correction.

## References

- [Chrome Web Store service accounts](https://developer.chrome.com/docs/webstore/service-accounts)
- [Chrome Web Store API usage and visibility requirements](https://developer.chrome.com/docs/webstore/using-api)
- [Publish API and automatic publication after approval](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish)
- [GitHub OIDC authentication action](https://github.com/google-github-actions/auth)
- [Google Workload Identity Federation setup](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)
