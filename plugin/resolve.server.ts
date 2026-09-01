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
} from "./contracts.shared";
import { withPaseo } from "./daemon.server";
import {
  UNKNOWN_STACK_DISTANCE,
  lookupPr,
  viewStackBranches,
  viewStackGraph,
  type GhOutage,
  type StackMember,
} from "./gh.server";
import { parseGithubRemote, readBranch, readOriginOwnerRepo } from "./git.server";
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
 * Step 5 of the ladder. `candidates` is sorted ascending by rank and always
 * ends with the synthetic `create` entry, so the extension can offer creating a
 * worktree even when nothing matched.
 */
export async function buildCandidates(input: {
  paseo: PaseoApi;
  ref: PrRef;
  pr: PrPayload;
  projectId: string;
  stackBranches: Map<string, StackMember>;
  /** Non-null when `gh` could not be consulted; carried into the create label. */
  outage?: GhOutage | null;
}): Promise<{ candidates: Candidate[]; defaultCandidateIndex: number }> {
  const workspaces = await listProjectWorkspaces(input.paseo, input.projectId);
  const counts = await agentCounts(input.paseo);

  const existing: ExistingCandidate[] = [];
  /** Stack distance per candidate, used only for ordering. Not on the wire. */
  const distanceOf = new Map<string, number>();
  for (const workspace of workspaces) {
    const branch = await workspaceBranch(workspace);
    const member = branch === null ? undefined : input.stackBranches.get(branch);
    const stackPrNumber = member?.number;
    if (member !== undefined) distanceOf.set(workspace.id, member.distance);
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
    } else if (stackPrNumber !== undefined) {
      existing.push({ ...base, rank: 2, reason: "stack", stackPrNumber });
    } else {
      existing.push({ ...base, rank: 3, reason: "project" });
    }
  }

  existing.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.rank === 2 && b.rank === 2) {
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
 * set and costs nothing.
 */
async function resolveStackBranches(
  ref: PrRef,
  headBranch: string,
  hints: readonly number[],
  outage: GhOutage | null,
): Promise<Map<string, StackMember>> {
  const stack = new Map<string, StackMember>();

  // Every path below needs `gh`. When the PR lookup already established that
  // `gh` cannot answer, skip it: retrying would add two more spawn attempts and
  // two more log lines per resolve for a guaranteed failure.
  if (outage !== null) return stack;

  try {
    for (const [branch, member] of await viewStackGraph(ref, headBranch)) {
      stack.set(branch, member);
    }
  } catch (error) {
    // Never fail a resolve over stack discovery: the exact match and the create
    // option are both still correct without it.
    console.error("[send-to-paseo] stack graph lookup failed", String(error));
  }

  const known = new Set([...stack.values()].map((member) => member.number));
  const missing = [...new Set(hints)].filter(
    (number) => number !== ref.number && !known.has(number),
  );
  if (missing.length > 0) {
    for (const [branch, number] of await viewStackBranches(ref, missing)) {
      if (stack.has(branch)) continue;
      stack.set(branch, { number, branch, distance: UNKNOWN_STACK_DISTANCE });
    }
  }

  stack.delete(headBranch); // the PR's own branch is the exact match, not a sibling
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
    const stackBranches = await resolveStackBranches(
      ref,
      pr.headBranch,
      request.stackPrNumbers ?? [],
      outage,
    );
    const { candidates, defaultCandidateIndex } = await buildCandidates({
      paseo,
      ref,
      pr,
      projectId: project.projectId,
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
