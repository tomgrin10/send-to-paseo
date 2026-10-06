import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const api = "https://chromewebstore.googleapis.com";
const acceptedStates = new Set(["PENDING_REVIEW", "PUBLISHED", "PUBLISHED_TO_TESTERS"]);
const versions = (revision) => (revision?.distributionChannels ?? []).map((channel) => channel.crxVersion);
const compare = (a, b) => {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
};

// No retries for mutating requests: a lost response may still have uploaded/submitted.
// Reruns first inspect status so an existing submission is preserved.
export async function publishExtension({ publisherId, itemId, token, version, zip, operation = "publish" }, {
  fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log, pollAttempts = 60,
} = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(publisherId ?? "")) throw new Error("CWS_PUBLISHER_ID is missing or invalid");
  if (!/^[a-p]{32}$/.test(itemId ?? "")) throw new Error("CWS_EXTENSION_ID is missing or invalid");
  if (!token) throw new Error("CWS_ACCESS_TOKEN is missing");
  if (!["status", "publish"].includes(operation)) throw new Error("Unknown operation");
  if (operation === "publish" && (!/^\d+\.\d+\.\d+$/.test(version ?? "") || !zip)) {
    throw new Error("Publishing requires a release version and ZIP");
  }
  const name = `publishers/${publisherId}/items/${itemId}`;
  async function request(path, options = {}) {
    const response = await fetchImpl(`${api}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...options.headers },
      signal: AbortSignal.timeout(120_000), redirect: "error",
    });
    const raw = await response.text();
    // Mask the credential even if a remote error happens to echo it.
    const safe = raw.replaceAll(token, "[REDACTED]");
    if (!response.ok) throw new Error(`Chrome Web Store HTTP ${response.status}: ${safe.slice(0, 8000)}`);
    let data;
    try { data = JSON.parse(safe); } catch { throw new Error("Chrome Web Store returned invalid JSON"); }
    if (data.error) throw new Error(`Chrome Web Store error: ${JSON.stringify(data.error)}`);
    return data;
  }
  const status = () => request(`/v2/${name}:fetchStatus`);
  const current = await status();
  log(JSON.stringify(current, null, 2));
  if (operation === "status") return { outcome: "status", status: current };
  if (current.takenDown || current.warned) throw new Error("Resolve the store policy warning/takedown in the dashboard first");
  const revisions = [current.publishedItemRevisionStatus, current.submittedItemRevisionStatus];
  for (const revision of revisions) {
    if (versions(revision).some((v) => compare(v, version) > 0)) {
      throw new Error(`Store already has a newer version than ${version}; refusing a stale release`);
    }
  }
  for (const revision of revisions) {
    if (acceptedStates.has(revision?.state) && versions(revision).some((v) => compare(v, version) === 0)) {
      log(`Version ${version} is already ${revision.state}; no upload needed`);
      return { outcome: "already-submitted", state: revision.state };
    }
  }
  const submitted = current.submittedItemRevisionStatus;
  if (["PENDING_REVIEW", "STAGED"].includes(submitted?.state)) {
    throw new Error(`Another submission is ${submitted.state}; it will not be cancelled or replaced automatically`);
  }
  const upload = await request(`/upload/v2/${name}:upload`, {
    method: "POST", headers: { "Content-Type": "application/zip" }, body: zip,
  });
  log(`Upload: ${JSON.stringify(upload)}`);
  if (upload.crxVersion && upload.crxVersion !== version) throw new Error("Uploaded version does not match release tag");
  let uploadState = upload.uploadState;
  // The UploadState enum uses IN_PROGRESS; media.upload prose also mentions UPLOAD_IN_PROGRESS.
  for (let i = 0; ["IN_PROGRESS", "UPLOAD_IN_PROGRESS"].includes(uploadState) && i < pollAttempts; i++) {
    await sleep(10_000);
    uploadState = (await status()).lastAsyncUploadState;
    log(`Upload processing: ${uploadState}`);
  }
  if (uploadState !== "SUCCEEDED") throw new Error(`Upload did not succeed: ${uploadState ?? "unknown"}`);
  const published = await request(`/v2/${name}:publish`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publishType: "DEFAULT_PUBLISH", skipReview: false, blockOnWarnings: false }),
  });
  log(`Submission: ${JSON.stringify(published)}`);
  if (!acceptedStates.has(published.state)) throw new Error(`Unexpected submission state: ${published.state}`);
  return { outcome: "submitted", state: published.state, warnings: published.warningInfo };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const operation = process.env.CWS_OPERATION ?? "publish";
    const result = await publishExtension({
      publisherId: process.env.CWS_PUBLISHER_ID, itemId: process.env.CWS_EXTENSION_ID,
      token: process.env.CWS_ACCESS_TOKEN, version: process.env.RELEASE_TAG?.slice(1), operation,
      zip: operation === "publish" ? readFileSync("dist/send-to-paseo-extension.zip") : undefined,
    });
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## Chrome Web Store\n\n${result.outcome}: ${result.state ?? "status checked"}\n\n` +
      `The submitted release publishes automatically after Google approves it.\n\n` +
      `[Store listing](https://chromewebstore.google.com/detail/${process.env.CWS_EXTENSION_ID})\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
