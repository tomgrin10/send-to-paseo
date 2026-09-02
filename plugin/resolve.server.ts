import type { PaseoApi, PaseoWorkspace } from "@getpaseo/client";
import {
  BridgeError,
  type AgentProfileOption,
  type Candidate,
  type ExistingCandidate,
  type ModeOption,
  type PrPayload,
  type PrRef,
  type ProjectPayload,
  type ProviderOption,
  type ResolveRequest,
  type ResolveResponse,
  type StackPrState,
} from "./contracts.shared";
import { withPaseo } from "./daemon.server";
import {
  ANCESTRY_STACK_DISTANCE,
  UNKNOWN_STACK_DISTANCE,
  lookupPr,
  repoDefaultBranch,
  viewStackBranches,
  viewStackGraph,
  type GhOutage,
  type StackGraph,
  type StackMember,
} from "./gh.server";
import {
  branchesContaining,
  parseGithubRemote,
  readBranch,
  readOriginOwnerRepo,
  readTrunkBranch,
} from "./git.server";
import { settings } from "./settings.server";

/**
 * PR -> project -> workspace resolution, exactly the ladder in CONTRACT.md.
 *
 * This endpoint runs while the user is still typing, so it must be fast and it
 * must never create anything.
 */

/** OpenCode alone advertises 160+ models; a popover dropdown needs a bound. */
const PER_PROVIDER_MODEL_LIMIT = 24;

/** `owner/repo` -> the project id Paseo gives a GitHub remote. */
export function remoteProjectId(owner: string, repo: string): string {
  return `remote:github.com/${owner}/${repo}`;
}

function sameRepo(a: { owner: string; repo: string }, b: { owner: string; repo: string }): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}

/**
 * Step 1 of the ladder: find the Paseo project for a GitHub repository.
 *
 * The `remote:github.com/{owner}/{repo}` id is the fast path. The fallback
 * matches a project whose `origin` parses to the same repository, which covers
 * projects registered from a local clone with an SSH remote or a renamed repo.
 */
export async function resolveProject(
  paseo: PaseoApi,
  ref: Pick<PrRef, "owner" | "repo">,
): Promise<ProjectPayload> {
  const { projects } = await paseo.projects.list();
  const wanted = remoteProjectId(ref.owner, ref.repo).toLowerCase();

  for (const project of projects) {
    if (project.projectId.toLowerCase() === wanted) {
      return {
        projectId: project.projectId,
        name: project.projectDisplayName,
        path: project.projectRootPath,
      };
    }
  }

  for (const project of projects) {
    if (project.projectKind !== "git" || project.projectRootPath === "") continue;
    const fromId = /^remote:github\.com\/([^/]+)\/(.+)$/i.exec(project.projectId);
    const candidate =
      fromId?.[1] !== undefined && fromId[2] !== undefined
        ? { owner: fromId[1], repo: fromId[2] }
        : await readOriginOwnerRepo(project.projectRootPath);
    if (candidate !== null && sameRepo(candidate, ref)) {
      return {
        projectId: project.projectId,
        name: project.projectDisplayName,
        path: project.projectRootPath,
      };
    }
  }

  throw new BridgeError(
    "project_not_found",
    `${ref.owner}/${ref.repo} is not a project in Paseo.`,
    `Add it in Paseo, or run: paseo project add /path/to/${ref.repo}`,
  );
}

/** Branch a workspace is on, preferring what the daemon already knows. */
async function workspaceBranch(workspace: PaseoWorkspace): Promise<string | null> {
  const fromRuntime = workspace.gitRuntime?.currentBranch;
  if (typeof fromRuntime === "string" && fromRuntime !== "") return fromRuntime;
  const fromCheckout = workspace.project?.checkout?.currentBranch;
  if (typeof fromCheckout === "string" && fromCheckout !== "") return fromCheckout;
  // Descriptor had no branch (fresh worktree, or git snapshot not warm yet).
  return readBranch(workspace.workspaceDirectory);
}

function workspaceLabel(workspace: PaseoWorkspace): string {
  const slug = workspace.worktreeSlug;
  if (typeof slug === "string" && slug !== "") return slug;
  const name = workspace.name;
  return typeof name === "string" && name !== "" ? name : workspace.id;
}

/** The vocabulary `paseo workspace ls` uses, so the two agree. */
function isolationOf(workspace: PaseoWorkspace): string {
  return workspace.workspaceKind === "worktree" ? "worktree" : "local";
}

async function agentCounts(paseo: PaseoApi): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  try {
    const { entries } = await paseo.agents.list();
    for (const entry of entries) {
      const workspaceId = entry.agent?.workspaceId;
      if (typeof workspaceId !== "string" || workspaceId === "") continue;
      counts.set(workspaceId, (counts.get(workspaceId) ?? 0) + 1);
    }
  } catch (error) {
    // A count is decoration; never fail a resolve over it.
    console.error("[send-to-paseo] could not count agents", String(error));
  }
  return counts;
}

/** Workspaces of one project, freshest first, excluding ones being archived. */
export async function listProjectWorkspaces(
  paseo: PaseoApi,
  projectId: string,
): Promise<PaseoWorkspace[]> {
  const { entries } = await paseo.workspaces.list();
  return entries.filter(
    (workspace) => workspace.projectId === projectId && workspace.archivingAt === null,
  );
}

/**
 * A workspace with the branch it is on, read once.
 *
 * Stack discovery needs the branch list *before* it can decide whether the
 * cheap open-PR graph was enough, and candidate building needs it again, so the
 * read happens once and is passed around rather than repeated.
 */
export interface WorkspaceBranch {
  workspace: PaseoWorkspace;
  branch: string | null;
}

export async function readWorkspaceBranches(
  workspaces: readonly PaseoWorkspace[],
): Promise<WorkspaceBranch[]> {
  const result: WorkspaceBranch[] = [];
  for (const workspace of workspaces) {
    result.push({ workspace, branch: await workspaceBranch(workspace) });
  }
  return result;
}

/**
 * Ordering weight for a rank-2 candidate's PR state.
 *
 * An open sibling outranks a merged or closed one *before* hop count is even
 * considered: a workspace on a live sibling branch of the stack is somewhere
 * work is still happening, while a merged branch is history the stack has
 * already moved past. `null` — a stack branch with no PR at all, which only
 * local ancestry can find — is the weakest claim of the four.
 */
function stateWeight(state: StackPrState | null | undefined): number {
  switch (state) {
    case undefined:
    case "open":
      return 0;
    case "merged":
      return 1;
    case "closed":
      return 2;
    default:
      return 3;
  }
}

/**
 * Step 5 of the ladder. `candidates` is sorted ascending by rank and always
 * ends with the synthetic `create` entry, so the extension can offer creating a
 * worktree even when nothing matched.
 */
export async function buildCandidates(input: {
  paseo: PaseoApi;
  ref: PrRef;
  pr: PrPayload;
  workspaces: readonly WorkspaceBranch[];
  stackBranches: Map<string, StackMember>;
  /** Non-null when `gh` could not be consulted; carried into the create label. */
  outage?: GhOutage | null;
}): Promise<{ candidates: Candidate[]; defaultCandidateIndex: number }> {
  const counts = await agentCounts(input.paseo);

  const existing: ExistingCandidate[] = [];
  /** Stack distance per candidate, used only for ordering. Not on the wire. */
  const distanceOf = new Map<string, number>();
  /**
   * Stack PR state per candidate, for ordering. Read from here rather than from
   * the candidate's `stackPrState`, because that field is omitted both for
   * "open" and for a branch with no PR — two very different claims that must
   * not sort as one.
   */
  const stateOf = new Map<string, StackPrState | null>();
  for (const { workspace, branch } of input.workspaces) {
    const member = branch === null ? undefined : input.stackBranches.get(branch);
    if (member !== undefined) {
      distanceOf.set(workspace.id, member.distance);
      stateOf.set(workspace.id, member.state);
    }
    const base = {
      kind: "existing" as const,
      workspaceId: workspace.id,
      label: workspaceLabel(workspace),
      branch,
      cwd: workspace.workspaceDirectory,
      isolation: isolationOf(workspace),
      agentCount: counts.get(workspace.id) ?? 0,
    };
    if (branch !== null && branch === input.pr.headBranch) {
      existing.push({ ...base, rank: 1, reason: "exact" });
    } else if (member !== undefined) {
      existing.push({
        ...base,
        rank: 2,
        reason: "stack",
        // A member found by ancestry alone may have no PR of its own, so both
        // wire fields are omitted rather than invented. `stackPrState` is
        // additionally omitted for "open", which is the value an extension
        // that predates this field already assumes.
        ...(member.number === null ? {} : { stackPrNumber: member.number }),
        ...(member.state === null || member.state === "open" ? {} : { stackPrState: member.state }),
      });
    } else {
      existing.push({ ...base, rank: 3, reason: "project" });
    }
  }

  existing.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.rank === 2 && b.rank === 2) {
      // Live siblings before history. See `stateWeight`.
      const leftState = stateWeight(stateOf.get(a.workspaceId));
      const rightState = stateWeight(stateOf.get(b.workspaceId));
      if (leftState !== rightState) return leftState - rightState;
      // Nearest in the stack first: the branch one hop from this PR is a far
      // better guess than one at the other end of a nine-PR stack.
      const leftHops = distanceOf.get(a.workspaceId) ?? UNKNOWN_STACK_DISTANCE;
      const rightHops = distanceOf.get(b.workspaceId) ?? UNKNOWN_STACK_DISTANCE;
      if (leftHops !== rightHops) return leftHops - rightHops;
      const left = a.stackPrNumber ?? 0;
      const right = b.stackPrNumber ?? 0;
      if (left !== right) return left - right;
    }
    return a.label.localeCompare(b.label);
  });

  // The create candidate's label is the only user-visible string in the resolve
  // response that the popover renders and that the bridge is free to word, so a
  // degraded resolve says so there. CONTRACT.md has no notice/warning field and
  // is frozen, so this and the agent's prompt are where the notice lives; see
  // README "Requirements".
  const outage = input.outage ?? null;
  const createLabel =
    outage === null
      ? `Create worktree for PR #${input.ref.number}`
      : `Create worktree for PR #${input.ref.number} (${outage.short})`;

  const candidates: Candidate[] = [
    ...existing,
    {
      kind: "create",
      label: createLabel,
      branch: input.pr.headBranch,
      rank: 4,
      reason: "create",
    },
  ];

  // The default is the exact branch match, then the nearest workspace in the
  // same stack, then creating a worktree.
  //
  // Preferring the stack match matters because one workspace per *stack* is a
  // normal way to work: you open PR #4 of a stack while the worktree sits on
  // PR #7's branch. Before this, that resolved to "create a worktree", which
  // silently proposed a second checkout of a stack the user already had open.
  // Rank 3 ("some other workspace in this project") is deliberately NOT a
  // default — an unrelated workspace is a worse guess than a fresh worktree.
  //
  // `candidates` always ends with the synthetic create entry, so the fallback
  // is always a valid index; CONTRACT.md requires it never point out of range.
  const exactIndex = candidates.findIndex((candidate) => candidate.rank === 1);
  const stackIndex = candidates.findIndex((candidate) => candidate.rank === 2);
  const fallbackIndex = Math.max(candidates.length - 1, 0);
  const preferred = exactIndex >= 0 ? exactIndex : stackIndex >= 0 ? stackIndex : fallbackIndex;
  const defaultCandidateIndex =
    preferred >= 0 && preferred < candidates.length ? preferred : fallbackIndex;
  return { candidates, defaultCandidateIndex };
}

/**
 * Selectable `provider/model` ids, with the plugin's configured default flagged.
 */
export async function listProviders(
  paseo: PaseoApi,
  configuredDefault: string | null,
): Promise<{ providers: ProviderOption[]; error: string | null }> {
  let snapshot;
  try {
    snapshot = await paseo.providers.snapshot();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { providers: [], error: message };
  }

  interface Draft {
    id: string;
    modelLabel: string;
    providerLabel: string;
    isProviderDefault: boolean;
  }
  const drafts: Draft[] = [];
  for (const entry of snapshot.entries) {
    if (entry.enabled === false || entry.status !== "ready") continue;
    const models = (entry.models ?? []).filter((model) => model.isSelectable !== false);
    for (const model of models.slice(0, PER_PROVIDER_MODEL_LIMIT)) {
      drafts.push({
        id: `${entry.provider}/${model.id}`,
        modelLabel: model.label === "" ? model.id : model.label,
        providerLabel:
          entry.label === undefined || entry.label === "" ? entry.provider : entry.label,
        isProviderDefault: model.isDefault === true,
      });
    }
  }

  // "Fable 5" appears under more than one provider, so only disambiguate the
  // labels that actually collide and leave the rest reading cleanly.
  const labelCounts = new Map<string, number>();
  for (const draft of drafts) {
    labelCounts.set(draft.modelLabel, (labelCounts.get(draft.modelLabel) ?? 0) + 1);
  }

  const effectiveDefault =
    configuredDefault !== null && drafts.some((draft) => draft.id === configuredDefault)
      ? configuredDefault
      : (drafts.find((draft) => draft.isProviderDefault)?.id ?? drafts[0]?.id ?? null);

  const providers: ProviderOption[] = drafts.map((draft) => ({
    id: draft.id,
    label:
      (labelCounts.get(draft.modelLabel) ?? 0) > 1
        ? `${draft.providerLabel} · ${draft.modelLabel}`
        : draft.modelLabel,
    isDefault: draft.id === effectiveDefault,
  }));

  // A configured default the daemon no longer offers still has to be visible,
  // or the surface would silently show no selection at all.
  if (
    configuredDefault !== null &&
    !providers.some((provider) => provider.id === configuredDefault)
  ) {
    providers.unshift({ id: configuredDefault, label: configuredDefault, isDefault: true });
    for (const provider of providers.slice(1)) provider.isDefault = false;
  }

  return { providers, error: null };
}

/**
 * The bare provider id inside a `provider/model` pair.
 *
 * Everything on the wire that names a provider names a `provider/model` pair
 * (`claude/claude-opus-5`), but modes are advertised per *provider*, so the two
 * are joined here and nowhere else.
 */
export function providerIdOf(providerModel: string): string {
  const slash = providerModel.indexOf("/");
  return slash === -1 ? providerModel : providerModel.slice(0, slash);
}

export interface ModeCatalog {
  /** Flat, provider-tagged, exactly like `providers[]`. */
  modes: ModeOption[];
  /** Bare provider id -> the mode id that provider calls its default. */
  defaultModeOf: Map<string, string>;
  error: string | null;
}

/**
 * Every permission mode Paseo advertises, flattened and tagged with its
 * provider.
 *
 * `isUnattended` is derived from `colorTier === "dangerous"` rather than read
 * from a field: `AgentMode` on the snapshot carries `colorTier` but not
 * `isUnattended` — only the static provider manifest has that flag. Measured
 * against `getUnattendedModeId()` from `@getpaseo/protocol/provider-manifest` on
 * 2026-09-01, the two agree exactly for every ready provider
 * (claude -> `bypassPermissions`, codex -> `full-access`, opencode -> none), so
 * this reads the daemon's own answer instead of importing a second source of
 * truth that could drift from it.
 */
export async function listModes(paseo: PaseoApi): Promise<ModeCatalog> {
  let snapshot;
  try {
    snapshot = await paseo.providers.snapshot();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { modes: [], defaultModeOf: new Map(), error: message };
  }

  const modes: ModeOption[] = [];
  const defaultModeOf = new Map<string, string>();
  for (const entry of snapshot.entries) {
    if (entry.enabled === false || entry.status !== "ready") continue;
    const advertised = entry.modes ?? [];
    const fallback = entry.defaultModeId ?? null;
    if (fallback !== null && advertised.some((mode) => mode.id === fallback)) {
      defaultModeOf.set(entry.provider, fallback);
    }
    for (const mode of advertised) {
      const dangerous = mode.colorTier === "dangerous";
      modes.push({
        provider: entry.provider,
        id: mode.id,
        label: mode.label === "" ? mode.id : mode.label,
        isDefault: mode.id === fallback,
        ...(dangerous ? { isUnattended: true } : {}),
        ...(mode.colorTier === undefined ? {} : { colorTier: mode.colorTier }),
      });
    }
  }
  return { modes, defaultModeOf, error: null };
}

/** True when `provider` actually advertises `modeId`. */
function modeIsValid(catalog: ModeCatalog, provider: string, modeId: string): boolean {
  return catalog.modes.some((mode) => mode.provider === provider && mode.id === modeId);
}

/**
 * The user's saved Paseo agent profiles, read live from daemon config.
 *
 * There is no `profile` parameter on agent creation: applying a profile is a
 * field-by-field copy of `provider`, `model`, `modeId` and `thinkingOptionId`.
 * So the plugin stores only the id and re-reads the fields on every send —
 * change the profile in Paseo and the next send follows it.
 */
export async function listAgentProfiles(
  paseo: PaseoApi,
): Promise<{ profiles: AgentProfileOption[]; error: string | null }> {
  try {
    const { config } = await paseo.config.get();
    const profiles = (config.agentProfiles ?? []).map((profile) => ({
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      model: profile.model ?? null,
      modeId: profile.modeId ?? null,
      thinkingOptionId: profile.thinkingOptionId ?? null,
    }));
    return { profiles, error: null };
  } catch (error) {
    return { profiles: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The profile the plugin is configured to follow, or null.
 *
 * Null is also the answer when the configured id no longer exists: a profile
 * deleted in Paseo must cost the send its defaults, not the send itself.
 */
export async function resolveSelectedProfile(
  paseo: PaseoApi,
): Promise<AgentProfileOption | null> {
  const wanted = (await settings.read()).defaultProfileId;
  if (wanted === null) return null;
  const { profiles, error } = await listAgentProfiles(paseo);
  if (error !== null) {
    console.error("[send-to-paseo] could not read agent profiles", error);
    return null;
  }
  const found = profiles.find((profile) => profile.id === wanted) ?? null;
  if (found === null) {
    console.log(
      `[send-to-paseo] agent profile ${wanted} no longer exists in Paseo; ignoring it`,
    );
  }
  return found;
}

/** `provider/model` for a profile, or null when it names no model. */
export function profileProviderId(profile: AgentProfileOption | null): string | null {
  if (profile === null || profile.model === null || profile.model === "") return null;
  return `${profile.provider}/${profile.model}`;
}

/**
 * The `provider/model` a send uses when the request does not name one: the
 * selected profile's model, else the configured default, else whatever the
 * daemon calls default.
 *
 * A profile naming a model Paseo no longer offers is skipped rather than
 * pinned, for the same reason a deleted profile is: stale configuration must
 * not turn every send into `agent_create_failed`.
 */
export async function resolveDefaultProvider(
  paseo: PaseoApi,
  profile: AgentProfileOption | null = null,
): Promise<string> {
  const configured = (await settings.read()).defaultProvider;
  const { providers } = await listProviders(paseo, configured);
  const fromProfile = profileProviderId(profile);
  if (fromProfile !== null) {
    if (providers.some((provider) => provider.id === fromProfile)) return fromProfile;
    console.log(
      `[send-to-paseo] profile "${profile?.name}" names ${fromProfile}, which Paseo does not offer; falling back`,
    );
  }
  const chosen = providers.find((provider) => provider.isDefault)?.id ?? providers[0]?.id;
  if (chosen === undefined) {
    throw new BridgeError(
      "agent_create_failed",
      "No provider is available in Paseo, so an agent cannot be started.",
      "Check Settings -> Providers in Paseo.",
    );
  }
  return chosen;
}

/**
 * The permission mode a send uses, in order. Mirrors `resolveDefaultProvider`:
 * ordered candidates, every one validated before it is accepted, and a
 * fall-through instead of a throw.
 *
 *   1. `modeId` on the request — the popover's explicit choice
 *   2. the selected profile's `modeId`
 *   3. the plugin's own configured `defaultModeId`
 *   4. the chosen provider's `defaultModeId` from `providers.snapshot()`
 *   5. `undefined` — the field is omitted and Paseo applies its own default
 *
 * Step 3 sits *below* the profile deliberately: decision 1 was "follow a saved
 * profile, resolved live at send time", so a profile that carries a mode is
 * what following it means. The plugin's own setting is the answer for people
 * who follow no profile, or a profile that leaves the mode unset.
 *
 * Every candidate is checked against the provider's advertised `modes[]` before
 * it is used, because mode ids are per-provider: `bypassPermissions` is a
 * Claude id and means nothing to Codex. An id the provider does not advertise
 * logs one line and falls through to the next step — before this, it would have
 * turned every send into `agent_create_failed`.
 */
export async function resolveDefaultMode(
  paseo: PaseoApi,
  providerModel: string,
  input: {
    /** `modeId` from the request body, when the caller sent one. */
    requested?: string | undefined;
    profile?: AgentProfileOption | null;
    /** Pre-fetched, so one resolve does not hit `snapshot()` twice. */
    catalog?: ModeCatalog;
  } = {},
): Promise<string | undefined> {
  const provider = providerIdOf(providerModel);
  const catalog = input.catalog ?? (await listModes(paseo));
  if (catalog.error !== null) {
    console.error("[send-to-paseo] could not list provider modes", catalog.error);
    return undefined;
  }

  const candidates: { id: string; source: string }[] = [];
  if (input.requested !== undefined && input.requested !== "") {
    candidates.push({ id: input.requested, source: "the request" });
  }
  const fromProfile = input.profile?.modeId ?? null;
  if (fromProfile !== null) {
    candidates.push({ id: fromProfile, source: `profile "${input.profile?.name}"` });
  }
  const configured = (await settings.read()).defaultModeId;
  if (configured !== null) {
    candidates.push({ id: configured, source: "the plugin's default mode setting" });
  }
  const providerDefault = catalog.defaultModeOf.get(provider);
  if (providerDefault !== undefined) {
    candidates.push({ id: providerDefault, source: `${provider}'s own default` });
  }

  for (const candidate of candidates) {
    if (modeIsValid(catalog, provider, candidate.id)) return candidate.id;
    console.log(
      `[send-to-paseo] mode "${candidate.id}" from ${candidate.source} is not offered by ${provider}; trying the next option`,
    );
  }
  return undefined;
}

/**
 * Providers with the plugin's *effective* default flagged, which is what the
 * popover preselects: the followed profile's model when Paseo still offers it,
 * else the `defaultProvider` setting, else the daemon's own default.
 */
export async function listEffectiveProviders(
  paseo: PaseoApi,
  profile: AgentProfileOption | null,
): Promise<{ providers: ProviderOption[]; error: string | null }> {
  const configured = (await settings.read()).defaultProvider;
  const result = await listProviders(paseo, configured);
  const fromProfile = profileProviderId(profile);
  if (fromProfile !== null && result.providers.some((provider) => provider.id === fromProfile)) {
    for (const provider of result.providers) provider.isDefault = provider.id === fromProfile;
  }
  return result;
}

/**
 * How many unplaced workspace branches the ancestry mechanism will test.
 *
 * `git branch -a --contains X` walks every ref in the repository, so it is the
 * one read in this endpoint that is not O(1). Measured on a real 4,692-ref
 * clone it costs 14-26ms per branch, so eight of them is ~0.15s worst case —
 * cheap, but not free, and projects with dozens of workspaces exist. Unplaced
 * workspaces beyond the cap stay rank 3, which is exactly the behaviour that
 * existed before this mechanism, and the cap is logged rather than silent.
 */
const ANCESTRY_WORKSPACE_LIMIT = 8;

/**
 * Trunk's branch name: local refs first, GitHub second, null if neither knows.
 *
 * Local is free and offline (`refs/remotes/origin/HEAD`, written by
 * `git clone`), but measurably not always present — 2 of 3 git projects on the
 * development machine had it. So `gh repo view` is the fallback, cached for
 * half an hour, and only ever reached on the slow path that already decided to
 * spend a `gh` round trip.
 */
async function resolveTrunk(
  ref: Pick<PrRef, "owner" | "repo">,
  projectRoot: string,
): Promise<string | null> {
  const local = projectRoot === "" ? null : await readTrunkBranch(projectRoot);
  if (local !== null) return local;
  return repoDefaultBranch(ref);
}

/**
 * Stack membership for a branch proved by local git ancestry alone.
 *
 * WHY THIS EXISTS. When the bottom PR of a stack merges and its head branch is
 * deleted, GitHub *retargets* the child PR's base to trunk. The base->head edge
 * that used to join them is then gone from GitHub's data entirely, so no
 * widening of `gh pr list` can rebuild the chain — the evidence has been
 * destroyed, not hidden. The commits, however, have not: a stack branch below
 * this PR is by definition an ancestor of it, so `git branch --contains` still
 * answers the question, with no network call and no `gh`.
 *
 * WHY THE TRUNK GUARD IS NOT OPTIONAL. "B is an ancestor of a stack branch" is
 * true of every branch that was merged into trunk at any point in the
 * repository's history, because trunk is an ancestor of every branch cut from
 * it. Without a guard, a workspace parked on trunk — or on a stale branch
 * merged a year ago — would become a rank-2 stack candidate for *every* PR in
 * the repository, and rank 2 can be the default. So a branch already contained
 * in trunk is rejected, which leaves exactly the branches that carry commits
 * trunk does not have yet:
 *
 *   - a squash- or rebase-merged stack branch (the tip is not an ancestor of
 *     trunk, because the merge created new commits) whose child has not been
 *     restacked yet — the reported bug;
 *   - a stack branch with no PR at all, which `gh` cannot see.
 *
 * The cost of the guard is the true-merge-commit case: a branch merged with a
 * real merge commit *is* an ancestor of trunk and is therefore rejected here.
 * Mechanism 1 (the merged/closed `gh pr list`) is what covers that case, and it
 * covers it whenever the head branch still exists so the base->head edge
 * survives. Neither mechanism covers "true merge commit AND branch deleted AND
 * child retargeted"; see plugin/README.md.
 */
async function ancestryStackMembers(input: {
  projectRoot: string;
  trunk: string;
  /** The PR's own head branch, plus every branch already known to be in the stack. */
  stackRefNames: ReadonlySet<string>;
  branches: readonly string[];
  /** Head branch -> the PR that owns it, for attributing a number and a state. */
  byHead: StackGraph["byHead"];
}): Promise<Map<string, StackMember>> {
  const found = new Map<string, StackMember>();
  const { trunk } = input;
  const trunkRefs = new Set([trunk, `origin/${trunk}`]);

  for (const branch of input.branches.slice(0, ANCESTRY_WORKSPACE_LIMIT)) {
    if (trunkRefs.has(branch)) continue;
    const containing = await branchesContaining(input.projectRoot, branch);
    // Silent by design: git missing, an unknown ref, a directory that is not a
    // repository and a timed-out walk are all "no answer", and a resolve is
    // still correct without one.
    if (containing === null) continue;
    let inTrunk = false;
    for (const ref of trunkRefs) if (containing.has(ref)) inTrunk = true;
    if (inTrunk) continue;
    let hit: string | null = null;
    for (const name of input.stackRefNames) {
      if (containing.has(name)) {
        hit = name;
        break;
      }
    }
    if (hit === null) continue;
    const pr = input.byHead.get(branch);
    found.set(branch, {
      number: pr?.number ?? null,
      branch,
      distance: ANCESTRY_STACK_DISTANCE,
      state: pr?.state ?? null,
    });
    console.log(
      `[send-to-paseo] ${branch} is an ancestor of ${hit} and not of ${trunk}, so it is in this stack` +
        `${pr === undefined ? " (no pull request of its own)" : ` (${pr.state} PR #${pr.number})`}`,
    );
  }
  return found;
}

/**
 * Branches in this PR's stack, keyed by branch name.
 *
 * GitHub is the source of truth: one `gh pr list` rebuilds the whole stack, so
 * this no longer depends on what Graphite's stack panel happened to render.
 * That matters — the panel collapses long stacks ("3 of 9, 2 hidden"), and a
 * hidden sibling used to mean the workspace sitting on it was never recognised
 * as a stack match at all.
 *
 * `hints` are the PR numbers the extension scraped from the page. They are
 * still honoured, but only for members the graph did not already find, which in
 * practice means a stack PR that is closed or merged. Usually that is an empty
 * set and costs nothing. On github.com the adapter deliberately sends `[]`, so
 * there are no hints at all there and the mechanisms below are the only cover.
 *
 * THREE PASSES, IN INCREASING COST, EACH ONLY REACHED IF THE LAST LEFT A
 * WORKSPACE UNEXPLAINED. `/v1/resolve` runs on every popover open while the
 * user types, so the first pass — one cached `gh pr list --state open` — is
 * what the common cases pay:
 *
 *   1. the open-PR graph, always;
 *   2. merged and closed PRs (one more `gh pr list`, five-minute cache), only
 *      if a project workspace sits on a branch pass 1 could not place. This is
 *      what recognises a workspace parked directly on a merged stack branch,
 *      and it reconnects a chain whose merged head branch was not deleted;
 *   3. local git ancestry (no network at all), only if a workspace is still
 *      unplaced. See `ancestryStackMembers` for what only this can answer.
 *
 * `workspaceBranches` is what makes 2 and 3 conditional. Passing an empty list
 * pins the behaviour to pass 1, which is what a caller wanting the cheap answer
 * should do.
 */
export async function resolveStackBranches(input: {
  ref: PrRef;
  headBranch: string;
  hints: readonly number[];
  outage: GhOutage | null;
  /** Absolute path of the project's main clone; "" disables the local reads. */
  projectRoot: string;
  /** Branches the project's workspaces are on. Drives passes 2 and 3. */
  workspaceBranches: readonly string[];
}): Promise<Map<string, StackMember>> {
  const { ref, headBranch, outage } = input;
  const stack = new Map<string, StackMember>();

  // Passes 1 and 2 need `gh`. When the PR lookup already established that `gh`
  // cannot answer, skip them: retrying would add two more spawn attempts and
  // two more log lines per resolve for a guaranteed failure.
  //
  // Pass 3 needs no `gh` — but it has nothing to work with either. It proves
  // "this branch is an ancestor of a branch in the stack", and without `gh`
  // there is no stack and no `pr.headBranch` to compare against. So a `gh`
  // outage still means no rank-2 candidates at all; the ancestry mechanism
  // narrows the gap when `gh` works, it does not close it when `gh` is down.
  if (outage !== null) return stack;

  let graph: StackGraph | null = null;
  try {
    graph = await viewStackGraph(ref, headBranch);
    for (const [branch, member] of graph.members) stack.set(branch, member);
  } catch (error) {
    // Never fail a resolve over stack discovery: the exact match and the create
    // option are both still correct without it.
    console.error("[send-to-paseo] stack graph lookup failed", String(error));
  }

  const known = new Set([...stack.values()].map((member) => member.number));
  const missing = [...new Set(input.hints)].filter(
    (number) => number !== ref.number && !known.has(number),
  );
  if (missing.length > 0) {
    for (const [branch, hint] of await viewStackBranches(ref, missing)) {
      if (stack.has(branch)) continue;
      stack.set(branch, {
        number: hint.number,
        branch,
        distance: UNKNOWN_STACK_DISTANCE,
        state: hint.state,
      });
    }
  }

  /** Workspace branches this PR's stack does not (yet) explain. */
  const unplaced = (): string[] => [
    ...new Set(
      input.workspaceBranches.filter(
        (branch) => branch !== "" && branch !== headBranch && !stack.has(branch),
      ),
    ),
  ];

  let outstanding = unplaced();
  if (outstanding.length === 0) return withoutSelf(stack, headBranch);

  // MEASURED SHORT-CIRCUIT. "Some workspace is unplaced" is nearly always true
  // — the development machine's own project has 38 workspaces, 37 of them on
  // branches unrelated to any given PR — so on its own it is too weak a
  // trigger for a 1.5s pair of lookups. What actually matters is whether the
  // *answer* can still change: a merged or closed member can never outrank an
  // exact branch match or an open sibling (see `stateWeight`), so when one of
  // those already exists, the default is settled and passes 2 and 3 would only
  // relabel a candidate nobody is going to pick. Measured against the live
  // bridge on that project: 2.07s -> 0.94s cold for a PR whose stack already
  // had an open sibling workspace, 1.62s for one that matched nothing at all
  // and still pays for the wider lookups, 0.01s once the lists are cached. The
  // cost, recorded in VERIFICATION.md §19.6: a merged stack workspace reads
  // rank 3 rather than rank 2 when an open sibling is also open in Paseo.
  const settled =
    input.workspaceBranches.includes(headBranch) ||
    input.workspaceBranches.some((branch) => stack.get(branch)?.state === "open");
  if (settled) return withoutSelf(stack, headBranch);

  const trunk = await resolveTrunk(ref, input.projectRoot);

  // Pass 2. Merged and closed PRs join the graph, so a chain whose merged head
  // branch still exists reconnects, and a workspace sitting on a merged stack
  // branch is recognised directly. An open PR still wins over a merged one for
  // the same head branch — `viewStackGraph` orders the entries that way.
  try {
    const wide = await viewStackGraph(ref, headBranch, { includeNonOpen: true, trunk });
    graph = wide;
    for (const [branch, member] of wide.members) {
      // The open-PR walk's answer is never overwritten: same hops, and its
      // state is authoritative.
      if (!stack.has(branch)) stack.set(branch, member);
    }
  } catch (error) {
    console.error("[send-to-paseo] merged/closed stack lookup failed", String(error));
  }

  outstanding = unplaced();
  if (outstanding.length === 0) return withoutSelf(stack, headBranch);

  // Pass 3. Local, read-only, no network. Needs trunk to be nameable at all;
  // without it every long-merged branch in the repository would qualify.
  if (trunk === null) {
    console.log(
      "[send-to-paseo] no trunk branch could be determined, so the local ancestry " +
        "check for merged stack branches was skipped",
    );
    return withoutSelf(stack, headBranch);
  }
  if (input.projectRoot === "") return withoutSelf(stack, headBranch);
  if (outstanding.length > ANCESTRY_WORKSPACE_LIMIT) {
    console.log(
      `[send-to-paseo] ${outstanding.length} workspaces are on branches this stack does not ` +
        `explain; only the first ${ANCESTRY_WORKSPACE_LIMIT} were checked for stack ancestry`,
    );
  }
  // The PR's own head branch is in the target set deliberately, and is in fact
  // the likeliest hit: a merged branch *below* this PR is an ancestor of this
  // PR's branch, and `stack` never contains the PR's own branch.
  const stackRefNames = new Set<string>();
  for (const branch of [headBranch, ...stack.keys()]) {
    if (branch === "") continue;
    stackRefNames.add(branch);
    // The stack branches were pushed from this clone, so their remote-tracking
    // refs are normally present even when the local branch is not.
    stackRefNames.add(`origin/${branch}`);
  }
  const byAncestry = await ancestryStackMembers({
    projectRoot: input.projectRoot,
    trunk,
    stackRefNames,
    branches: outstanding,
    byHead: graph?.byHead ?? new Map(),
  });
  for (const [branch, member] of byAncestry) {
    if (!stack.has(branch)) stack.set(branch, member);
  }
  return withoutSelf(stack, headBranch);
}

/** The PR's own branch is the exact match, not a sibling. */
function withoutSelf(
  stack: Map<string, StackMember>,
  headBranch: string,
): Map<string, StackMember> {
  stack.delete(headBranch);
  return stack;
}

/** Full `POST /v1/resolve` behaviour. */
export async function handleResolve(request: ResolveRequest): Promise<ResolveResponse> {
  const ref: PrRef = {
    forge: request.forge,
    owner: request.owner,
    repo: request.repo,
    number: request.number,
  };
  return withPaseo(async (paseo) => {
    // Project first: a repo that Paseo does not know is the more specific and
    // more actionable failure, and it costs no GitHub round trip.
    const project = await resolveProject(paseo, ref);
    // Degrades instead of failing when `gh` is missing, unauthenticated or
    // offline: the create path uses Paseo's own forge checkout, so the only
    // casualties are the title, the branch names and stack detection.
    const { pr, outage } = await lookupPr(ref);
    // The workspace branches are read before stack discovery, not after,
    // because they are what decides whether the cheap open-PR graph was enough:
    // a branch it could not place is the signal that this may be a merged stack
    // branch and worth paying for the wider lookups. Read once, used twice.
    const workspaces = await readWorkspaceBranches(
      await listProjectWorkspaces(paseo, project.projectId),
    );
    const stackBranches = await resolveStackBranches({
      ref,
      headBranch: pr.headBranch,
      hints: request.stackPrNumbers ?? [],
      outage,
      projectRoot: project.path,
      workspaceBranches: workspaces
        .map((entry) => entry.branch)
        .filter((branch): branch is string => branch !== null),
    });
    const { candidates, defaultCandidateIndex } = await buildCandidates({
      paseo,
      ref,
      pr,
      workspaces,
      stackBranches,
      outage,
    });
    // One profile read and one mode snapshot, shared by the provider list and
    // the resolved mode, so a resolve stays a two-round-trip operation.
    const profile = await resolveSelectedProfile(paseo);
    const { providers } = await listEffectiveProviders(paseo, profile);
    const catalog = await listModes(paseo);
    const effectiveProvider = providers.find((entry) => entry.isDefault)?.id ?? providers[0]?.id;
    const resolvedModeId =
      effectiveProvider === undefined
        ? undefined
        : await resolveDefaultMode(paseo, effectiveProvider, { profile, catalog });
    return {
      pr,
      project,
      candidates,
      defaultCandidateIndex,
      providers,
      modes: catalog.modes,
      resolvedModeId: resolvedModeId ?? null,
    };
  });
}
