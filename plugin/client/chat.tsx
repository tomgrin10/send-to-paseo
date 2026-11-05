import { useEffect, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { ExternalLink, Icon, ScrollView } from "@getpaseo/plugin/client/ui";

import { dispatchesForAgent, type RecentSend } from "../shared/contracts";
import { PROVENANCE_CARD_KIND, ProvenanceSchema, TOOL_ROW_KIND, ToolRowSchema, bridgeToolRow, isBridgeStatusTool, provenance, type Provenance, type ToolRow } from "../shared/chat";
import { routeLine, siteLabel } from "../shared/route";
import { raised } from "./theme";

const mono = () => (Platform.OS === "ios" ? "Menlo" : Platform.OS === "android" ? "monospace" : "ui-monospace, SFMono-Regular, Menlo, monospace");

type Rpc = PluginClientContext["rpc"];

/** One lookup per agent and host, shared by every card in that chat. */
const lookups = new Map<string, Promise<RecentSend[]>>();
function sendsFor(rpc: Rpc, serverId: string, agentId: string): Promise<RecentSend[]> {
  const key = `${serverId}:${agentId}`;
  let pending = lookups.get(key);
  if (pending === undefined) {
    pending = rpc(dispatchesForAgent, { serverId, agentId }).then((result) => result.sends, () => []);
    lookups.set(key, pending);
    // Fresh enough for a chat that stays open; a later send is a new card anyway.
    setTimeout(() => lookups.delete(key), 60_000);
  }
  return pending;
}

/** The recorded send nearest this message, within a few minutes of it. */
function nearest(sends: RecentSend[], at: Date, number: number): RecentSend | null {
  let best: RecentSend | null = null;
  let gap = 5 * 60_000;
  for (const send of sends) {
    if (send.outcome !== "ok" || !send.prLabel.endsWith(`#${number}`)) continue;
    const delta = Math.abs(Date.parse(send.at) - at.getTime());
    if (delta <= gap) { gap = delta; best = send; }
  }
  return best;
}

function ProvenanceCard({ item, theme, layout, host, agentId, timestamp, rpc }: PluginTimelineItemProps<Provenance> & { rpc: Rpc }) {
  const c = theme.colors;
  const card = item.data;
  const [expanded, setExpanded] = useState(false);
  const [send, setSend] = useState<RecentSend | null>(null);
  useEffect(() => {
    let live = true;
    void sendsFor(rpc, host.id, agentId).then((sends) => { if (live) setSend(nearest(sends, timestamp, card.number)); });
    return () => { live = false; };
  }, [rpc, host.id, agentId, timestamp, card.number]);

  const site = siteLabel(card.site);
  const route = routeLine(card, send);
  const tight = layout.compact;
  return <View style={{ alignSelf: tight ? "stretch" : "flex-end", width: "100%", maxWidth: 600, marginVertical: 4 }}>
    <View style={[{ borderRadius: 12, backgroundColor: c.surface1, overflow: "hidden" }, raised(c)]}>
      <View style={{ paddingHorizontal: 14, paddingTop: 11, paddingBottom: 10, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name="GitPullRequest" size={14} color={c.foregroundMuted} />
          <Text numberOfLines={tight ? 2 : 1} style={{ flexShrink: 1, color: c.foregroundMuted, fontSize: 12, lineHeight: 17, fontVariant: ["tabular-nums"] }}>
            <Text style={{ color: c.foreground, fontWeight: "600" }}>{card.repo} #{card.number}</Text>
            {site === null ? "" : ` · sent from ${site}`}
          </Text>
          <View style={{ flex: 1 }} />
          <ExternalLink href={card.prUrl} accessibilityLabel={`Open ${card.repo} pull request ${card.number}`}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Open PR</Text>
            </View>
          </ExternalLink>
        </View>
        {card.title === null ? null : <Text numberOfLines={2} style={{ color: c.foreground, fontSize: 13, lineHeight: 18 }}>{card.title}</Text>}
        {card.head === null ? null : (
          <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontFamily: mono(), fontSize: 12, lineHeight: 17 }}>{card.head} → {card.base}</Text>
        )}
      </View>
      <View style={{ borderTopWidth: 1, borderTopColor: c.border, paddingHorizontal: 14, paddingVertical: 10 }}>
        <Text selectable style={{ color: c.foreground, fontSize: 14, lineHeight: 21 }}>{card.instruction}</Text>
      </View>
      <View style={{ flexDirection: tight ? "column" : "row", alignItems: tight ? "flex-start" : "center", gap: tight ? 4 : 8, paddingHorizontal: 14, paddingBottom: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1, alignSelf: "stretch" }}>
        <Icon name={route.attention ? "TriangleAlert" : "Route"} size={12} color={route.attention ? c.statusWarning : c.foregroundMuted} />
        <Text style={{ flex: 1, color: route.attention ? c.statusWarning : c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{route.text}</Text>
        </View>
        <Pressable accessibilityRole="button" aria-expanded={expanded} accessibilityLabel={expanded ? "Hide what the agent received" : "Show what the agent received"} onPress={() => setExpanded((value) => !value)} hitSlop={6}
          style={(state) => ({ marginLeft: tight ? 14 : 0, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: state.pressed ? c.surface2 : "transparent" })}>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{expanded ? "Hide" : "What the agent got"}</Text>
        </Pressable>
      </View>
      {expanded ? <View style={{ borderTopWidth: 1, borderTopColor: c.border }}>
        <ScrollView style={[{ maxHeight: 300 }, Platform.OS === "web" ? ({ overscrollBehavior: "contain" } as object) : null]} contentContainerStyle={{ padding: 14 }}>
          <Text selectable style={{ color: c.foregroundMuted, fontFamily: mono(), fontSize: 12, lineHeight: 18 }}>{card.text}</Text>
        </ScrollView>
      </View> : null}
    </View>
  </View>;
}

/** The bridge-status agent tool as one quiet line, sized like Paseo's own tool rows. */
function ToolRowView({ item, theme }: PluginTimelineItemProps<ToolRow>) {
  const c = theme.colors;
  const row = item.data;
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const openable = row.detail !== "";
  const open = expanded && openable;
  const active = openable && (hovered || expanded);
  const alert = row.tone === "danger" ? c.statusDanger : row.tone === "warning" ? c.statusWarning : null;
  return <View style={{ marginHorizontal: -13 }}>
    <Pressable disabled={!openable} onPress={() => setExpanded((value) => !value)} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
      accessibilityRole={openable ? "button" : undefined} aria-expanded={openable ? expanded : undefined} aria-busy={row.state === "running"}
      style={{ flexDirection: "row", alignItems: "center", borderRadius: 8, borderWidth: 1, borderColor: open ? c.border : "transparent", borderBottomLeftRadius: open ? 0 : 8, borderBottomRightRadius: open ? 0 : 8, backgroundColor: open ? c.surface1 : "transparent", paddingHorizontal: 8, paddingVertical: 4 }}>
      <View style={{ width: 22, height: 22, marginRight: 4, alignItems: "center", justifyContent: "center" }}>
        {active
          ? <View style={{ transform: [{ rotate: expanded ? "90deg" : "0deg" }] }}><Icon name="ChevronRight" size={14} color={c.foreground} /></View>
          : <Icon name={alert ? "TriangleAlert" : "Send"} size={12} color={alert ?? c.foregroundMuted} />}
      </View>
      <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 14, fontVariant: ["tabular-nums"], color: alert ?? (active || row.state === "running" ? c.foreground : c.foregroundMuted), opacity: row.state === "running" ? 0.72 : 1 }}>{row.line}</Text>
    </Pressable>
    {open ? <View style={{ borderWidth: 1, borderTopWidth: 0, borderColor: c.border, borderBottomLeftRadius: 8, borderBottomRightRadius: 8, overflow: "hidden" }}>
      <ScrollView style={[{ maxHeight: 240 }, Platform.OS === "web" ? ({ overscrollBehavior: "contain" } as object) : null]} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8 }}>
        <Text selectable style={{ color: c.foreground, fontFamily: mono(), fontSize: 12, lineHeight: 18 }}>{row.detail}</Text>
      </ScrollView>
    </View> : null}
  </View>;
}

export function contributeChat(client: PluginClientContext) {
  const rpc: Rpc = client.rpc.bind(client);
  const Card = (props: PluginTimelineItemProps<Provenance>) => <ProvenanceCard {...props} rpc={rpc} />;
  const removers = [
    client.addTimelineTransformer({
      id: "send-to-paseo-provenance",
      query: { itemType: "user_message" },
      transform({ item }) {
        const card = provenance(item.text);
        return card === null ? undefined : { items: [{ type: "plugin" as const, kind: PROVENANCE_CARD_KIND, version: 1, data: card }] };
      },
    }),
    client.addTimelineTransformer({
      id: "send-to-paseo-tool-calls",
      query: { itemType: "tool_call" },
      transform({ item }) {
        if (!isBridgeStatusTool(item.name)) return undefined;
        const detail = item.detail as { output?: unknown; result?: unknown } | undefined;
        const row = bridgeToolRow(item.status, detail?.output ?? detail?.result ?? detail, item.error);
        return { items: [{ type: "plugin" as const, kind: TOOL_ROW_KIND, version: 1, data: row }] };
      },
    }),
    client.addTimelineRenderer({ kind: PROVENANCE_CARD_KIND, version: 1, schema: ProvenanceSchema, Component: Card }),
    client.addTimelineRenderer({ kind: TOOL_ROW_KIND, version: 1, schema: ToolRowSchema, Component: ToolRowView }),
  ];
  return () => { for (const remove of removers) if (typeof remove === "function") void remove(); };
}
