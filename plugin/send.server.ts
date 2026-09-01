import { randomBytes } from "node:crypto";
import type {
  PaseoAgentConfig,
  PaseoApi,
  PaseoWorkspace,
  PaseoWorkspaceHandle,
} from "@getpaseo/client";
import { buildAgentDeepLink } from "@getpaseo/protocol/agent-deep-link";
import {
  BridgeError,
  LABEL_ORIGIN,
  LABEL_PR,
  MAX_PROMPT_CHARS,
  buildAgentTitle,
  composePrompt,
  prLabelValue,
  promptLength,
  type PrPayload,
  type PrRef,
  type SendRequest,
  type SendResponse,
} from "./contracts.shared";
import { requireServerId, withPaseo } from "./daemon.server";
import { lookupPr, type GhOutage } from "./gh.server";
import { readBranch, requireGit } from "./git.server";
import {
  listProjectWorkspaces,
  profileProviderId,
  resolveDefaultMode,
  resolveDefaultProvider,
  resolveProject,
  resolveSelectedProfile,
} from "./resolve.server";
import { settings } from "./settings.server";

/**
 * The one mutating endpoint: ensure a workspace, then start a brand new agent
 * in it. Never reuses or messages an existing agent.
 */

/** A freshly checked-out worktree is normally ready on return; this is a guard. */
const WORKSPACE_READY_TIMEOUT_MS = 60_000;
const WORKSPACE_POLL_MS = 750;

/** `SEND_TO_PASEO_DRY_RUN=1` validates and resolves but creates nothing. */
export function isDryRun(): boolean {
  return process.env.SEND_TO_PASEO_DRY_RUN === "1";
}

function syntheticId(prefix: string): string {
  return `${prefix}_dryrun_${randomBytes(6).toString("hex")}`;
}

/**
 * CONTRACT.md: required, 1..16000 Unicode code points after trim.
 *
 * Code points, not UTF-16 code units, so an emoji counts once. The 64 KiB byte
 * cap on the body is independent and is applied earlier in `bridge.server`, so a
 * prompt inside this limit that is too large as UTF-8 gets `payload_too_large`
 * rather than `bad_request`.
 */
function normalizePrompt(raw: string): string {
  const prompt = raw.trim();
  const length = promptLength(prompt);
  if (length === 0) {
    throw new BridgeError("bad_request", "A message is required.");
  }
  if (length > MAX_PROMPT_CHARS) {
    throw new BridgeError(
      "bad_request",
      `A message may be at most ${MAX_PROMPT_CHARS} characters; this one is ${length}.`,
    );
  }
  return prompt;
}

/**
 * The one line an agent is told about a degraded lookup. The agent is the party
 * that will otherwise wonder where the PR title went, and it can fetch the
 * details itself if it needs them.
 */
function promptNote(outage: GhOutage): string {
  return (
    `Note: the pull request title and branch names are missing from this header because ` +
    `${outage.short}. Read them from the PR URL above if you need them.`
  );
}

function labelOf(workspace: PaseoWorkspace): string {
  const slug = workspace.worktreeSlug;
  if (typeof slug === "string" && slug !== "") return slug;
  return workspace.name === "" ? workspace.id : workspace.name;
}

async function createWorktreeWorkspace(
  paseo: PaseoApi,
  projectId: string,
  ref: PrRef,
  pr: PrPayload,
  degraded: boolean,
): Promise<{ workspace: PaseoWorkspace; handle: PaseoWorkspaceHandle }> {
  // The only genuinely fatal dependency on this path, and the only place worth
  // pre-flighting it: without git there is no worktree, and the daemon's own
  // error for that is several layers away from the word "git".
  await requireGit();
  let handle;
  try {
    // Exactly the shape `paseo workspace create --isolation worktree
    // --mode checkout-pr --pr-number N --forge github --project <id>` sends.
    handle = await paseo.workspaces.create({
      // Without `gh` the title is already `PR #942`; appending it to itself
      // would read "PR #942: PR #942".
      title: (degraded ? `PR #${ref.number}` : `PR #${ref.number}: ${pr.title}`).slice(0, 120),
      source: {
        kind: "worktree",
        projectId,
        action: "checkout",
        checkoutSource: { kind: "change_request", forge: ref.forge, number: ref.number },
      },
    });
  } catch (error) {
    throw new BridgeError(
      "workspace_create_failed",
      `Paseo could not create a worktree for PR #${ref.number}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const deadline = Date.now() + WORKSPACE_READY_TIMEOUT_MS;
  let snapshot = handle.current();
  while (Date.now() < deadline) {
    if (snapshot !== null && snapshot.workspaceDirectory !== "") {
      const branch = await readBranch(snapshot.workspaceDirectory);
      if (branch !== null) return { workspace: snapshot, handle };
    }
    await new Promise((done) => {
      const timer = setTimeout(done, WORKSPACE_POLL_MS);
      // A pending poll must never hold the subprocess open during teardown.
      timer.unref?.();
    });
    snapshot = await handle.refresh().catch(() => snapshot);
  }
  if (snapshot !== null && snapshot.workspaceDirectory !== "") {
    return { workspace: snapshot, handle };
  }
  throw new BridgeError(
    "workspace_create_failed",
    `The worktree for PR #${ref.number} was created but never became ready.`,
  );
}

/** Full `POST /v1/send` behaviour. */
export async function handleSend(request: SendRequest): Promise<SendResponse> {
  const ref: PrRef = {
    forge: request.forge,
    owner: request.owner,
    repo: request.repo,
    number: request.number,
  };
  const prompt = normalizePrompt(request.prompt);
  const dryRun = isDryRun();

  return withPaseo(async (paseo) => {
    const project = await resolveProject(paseo, ref);
    // Same degradation as resolve: a missing or unauthenticated `gh` costs the
    // title, the branches and the stack note in the prompt, not the send.
    const { pr, outage } = await lookupPr(ref);
    // Followed live, so editing the profile in Paseo changes the next send.
    const profile = await resolveSelectedProfile(paseo);
    // PRECEDENCE: an explicit choice in the popover always wins over the
    // profile. The profile only supplies a provider when the request names
    // none — picking "Codex" in the popover must not be silently overridden by
    // a profile that happens to name Claude.
    const provider = request.provider ?? (await resolveDefaultProvider(paseo, profile));
    const modeId = await resolveDefaultMode(paseo, provider, {
      requested: request.modeId,
      profile,
    });
    // Thinking options are per *model*, so the profile's one is only copied
    // when the send actually landed on the profile's own model.
    const thinkingOptionId =
      profileProviderId(profile) === provider ? (profile?.thinkingOptionId ?? null) : null;
    const agentConfig: PaseoAgentConfig = {
      provider,
      ...(modeId === undefined ? {} : { modeId }),
      ...(thinkingOptionId === null ? {} : { thinkingOptionId }),
    };
    const title = buildAgentTitle(ref.number, prompt);
    const serverId = await requireServerId();

    let workspaceId: string;
    let workspaceLabel: string;
    let branch: string | null;
    let workspaceCreated = false;
    /**
     * Null only in a dry run of a `create` target, where there is no workspace
     * to attach to. Agents are always created through the workspace handle so
     * they join that workspace record rather than getting a fresh one for the
     * same directory.
     */
    let handle: PaseoWorkspaceHandle | null = null;

    if (request.target.kind === "existing") {
      const wanted = request.target.workspaceId;
      const workspaces = await listProjectWorkspaces(paseo, project.projectId);
      const workspace = workspaces.find((entry) => entry.id === wanted);
      if (workspace === undefined) {
        throw new BridgeError(
          "bad_request",
          `Workspace ${wanted} is no longer available in ${project.name}.`,
          "Reopen the popover to refresh the workspace list.",
        );
      }
      workspaceId = workspace.id;
      workspaceLabel = labelOf(workspace);
      branch =
        workspace.gitRuntime?.currentBranch ??
        workspace.project?.checkout?.currentBranch ??
        (await readBranch(workspace.workspaceDirectory));
      handle = paseo.workspaces.ref(workspace);
    } else if (dryRun) {
      // Resolution and validation ran; creating the worktree is the side effect
      // dry run exists to skip.
      workspaceId = syntheticId("wks");
      workspaceLabel = `Create worktree for PR #${ref.number}`;
      // Null, not "", when gh could not tell us the head branch: the contract
      // says this field is the branch or nothing, and "" is neither.
      branch = pr.headBranch === "" ? null : pr.headBranch;
      workspaceCreated = true;
    } else {
      const created = await createWorktreeWorkspace(
        paseo,
        project.projectId,
        ref,
        pr,
        outage !== null,
      );
      workspaceId = created.workspace.id;
      workspaceLabel = labelOf(created.workspace);
      branch = await readBranch(created.workspace.workspaceDirectory);
      workspaceCreated = true;
      handle = created.handle;
      console.log(
        `[send-to-paseo] created worktree workspace ${workspaceId} for PR #${ref.number} on ${branch ?? "unknown branch"}`,
      );
    }

    let agentId: string;
    if (dryRun) {
      agentId = syntheticId("agt");
    } else if (handle === null) {
      throw new BridgeError("internal", "No workspace was resolved for this send.");
    } else {
      try {
        const agent = await handle.agents.create({
          config: agentConfig,
          title,
          prompt: composePrompt({
            ref,
            pr,
            prompt,
            workspaceBranch: branch,
            ...(outage === null ? {} : { prMetadataNote: promptNote(outage) }),
            ...(request.pageUrl === undefined ? {} : { pageUrl: request.pageUrl }),
          }),
          labels: {
            [LABEL_PR]: prLabelValue(ref),
            [LABEL_ORIGIN]: "graphite",
          },
        });
        agentId = agent.id;
      } catch (error) {
        throw new BridgeError(
          "agent_create_failed",
          `Paseo refused to start the agent: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const deepLink = buildAgentDeepLink({ serverId, agentId });
    // Never log the prompt: it is the user's message body.
    console.log(
      `[send-to-paseo] ${dryRun ? "dry-run " : ""}sent PR #${ref.number} to ${workspaceLabel} (agent ${agentId}, provider ${provider}, mode ${modeId ?? "paseo default"})`,
    );

    await settings
      .recordSend({
        prLabel: `${ref.owner}/${ref.repo}#${ref.number}`,
        prUrl: pr.url,
        workspaceLabel,
        branch,
        agentId,
        deepLink,
        title,
        provider,
        modeId: modeId ?? null,
        workspaceCreated,
        dryRun,
        outcome: "ok",
        error: null,
      })
      .catch((error: unknown) => {
        console.error("[send-to-paseo] could not record the send", String(error));
      });

    return {
      ok: true,
      agentId,
      workspaceId,
      workspaceCreated,
      workspaceLabel,
      branch,
      deepLink,
      title,
      dryRun,
    };
  });
}

/** Records a failed send so the surface can show what went wrong. */
export async function recordFailedSend(
  request: SendRequest,
  error: BridgeError | Error,
): Promise<void> {
  await settings
    .recordSend({
      prLabel: `${request.owner}/${request.repo}#${request.number}`,
      prUrl: `https://github.com/${request.owner}/${request.repo}/pull/${request.number}`,
      workspaceLabel: request.target.kind === "create" ? "new worktree" : request.target.workspaceId,
      branch: null,
      agentId: null,
      deepLink: null,
      title: buildAgentTitle(request.number, request.prompt.trim()),
      provider: request.provider ?? "default",
      modeId: request.modeId ?? null,
      workspaceCreated: false,
      dryRun: isDryRun(),
      outcome: "failed",
      error: error.message,
    })
    .catch(() => undefined);
}
