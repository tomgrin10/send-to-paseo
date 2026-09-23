import type { PluginHandlerContext } from "@getpaseo/plugin/server";

type PaseoApi = PluginHandlerContext["paseo"];
export type ListedAgent = Awaited<ReturnType<PaseoApi["agents"]["list"]>>["entries"][number]["agent"];

const PARENT_AGENT_LABEL = "paseo.parent-agent-id";
const OPEN_TAB_PREFIX = "paseo.open-agent-tab.";
const PAGE_SIZE = 200;
const MAX_PAGES = 10;

function timestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function isRoot(agent: ListedAgent): boolean {
  return !(agent.labels[PARENT_AGENT_LABEL] ?? "").trim();
}

function hasOpenTab(agent: ListedAgent): boolean {
  return Object.entries(agent.labels).some(
    ([key, value]) => key.startsWith(OPEN_TAB_PREFIX) && value === "true",
  );
}

function titleIsMain(agent: ListedAgent): boolean {
  return /^(main|main agent)$/i.test(agent.title?.trim() ?? "");
}

function liveRank(agent: ListedAgent): number {
  switch (agent.status) {
    case "running":
      return 4;
    case "idle":
      return 3;
    case "initializing":
      return 2;
    case "closed":
      return 1;
    default:
      return 0;
  }
}

/**
 * Pick the workspace's main agent from durable Paseo metadata.
 *
 * "Main" means a root agent, not merely the newest record: delegated agents
 * carry `paseo.parent-agent-id` and are never eligible. An explicit Main title
 * is the strongest user signal, followed by an agent open in a Paseo tab, then
 * a live runtime and recent user activity. The final id comparison makes the
 * result deterministic when old records have identical timestamps.
 */
export function selectMainAgent(
  agents: readonly ListedAgent[],
  workspaceId: string,
): ListedAgent | null {
  const eligible = agents.filter(
    (agent) =>
      agent.workspaceId === workspaceId &&
      agent.archivedAt == null &&
      isRoot(agent),
  );
  eligible.sort((left, right) => {
    const priorities = [
      Number(titleIsMain(right)) - Number(titleIsMain(left)),
      Number(hasOpenTab(right)) - Number(hasOpenTab(left)),
      liveRank(right) - liveRank(left),
      timestamp(right.lastUserMessageAt) - timestamp(left.lastUserMessageAt),
      timestamp(right.updatedAt) - timestamp(left.updatedAt),
      timestamp(right.createdAt) - timestamp(left.createdAt),
    ];
    for (const difference of priorities) if (difference !== 0) return difference;
    return left.id.localeCompare(right.id);
  });
  return eligible[0] ?? null;
}

/**
 * Fetch active agents in the project, following pagination rather than
 * assuming the daemon's first page contains this workspace's older main agent.
 */
export async function listProjectAgents(
  paseo: PaseoApi,
  projectId: string,
): Promise<ListedAgent[]> {
  const agents: ListedAgent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.agents.list({
      filter: { includeArchived: false, projectKeys: [projectId] },
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
    });
    for (const entry of result.entries) agents.push(entry.agent);
    cursor = result.pageInfo.nextCursor ?? undefined;
    if (!result.pageInfo.hasMore || cursor === undefined) break;
  }
  return agents;
}

export function agentDisplayTitle(agent: ListedAgent): string {
  const title = agent.title?.trim();
  return title ? title : `Agent ${agent.id.slice(0, 7)}`;
}

export function agentProvider(agent: ListedAgent): string {
  return agent.model ? `${agent.provider}/${agent.model}` : agent.provider;
}
