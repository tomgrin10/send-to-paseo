import type { AgentToolDefinition, PluginServerContext } from "@getpaseo/plugin/server";

/** 0.14's launch hook is re-evaluated on create, resume, import, and refresh. */
export function registerAgentTools(server: PluginServerContext, tools: AgentToolDefinition[], workspaceOnly = false) {
  return server.before("agent.session_open", ({ request }) => {
    if (request.purpose !== "interactive" || !["claude", "codex"].includes(request.provider)
      || request.labels["plugin-tools/enabled"] === "false" || (workspaceOnly && !request.workspaceId)) return;
    return { ...request, tools: [...request.tools, ...tools] };
  });
}
