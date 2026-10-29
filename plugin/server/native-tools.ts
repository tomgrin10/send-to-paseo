import { defineAgentTool, type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { getBridgeStatus } from "./bridge";
import { dependencySnapshot } from "./deps";
import { registerAgentTools } from "./agent-tools";
export function contributeAgentTools(server: PluginServerContext) {
  return registerAgentTools(server, [defineAgentTool({
    name: "send_to_paseo_bridge_status", description: "Diagnose the Send to Paseo browser bridge and required executables. Never returns pairing tokens, connection codes, credentials or recent prompt text. Does not start agents or change pairing.",
    input: z.object({}).strict(),
    async execute(_, { signal }) {
      if (signal.aborted) throw new Error("Tool call cancelled.");
      const [bridge, deps] = await Promise.all([getBridgeStatus(), dependencySnapshot()]);
      const result = { state: bridge.state, port: bridge.port, paired: bridge.paired, dryRun: bridge.dryRun, defaultProvider: bridge.defaultProvider, agentDispatch: bridge.agentDispatch, dependencies: deps.dependencies.map(dep => ({ name: dep.name, state: dep.state })) };
      return { text: JSON.stringify(result), structuredContent: result };
    },
  })]);
}
