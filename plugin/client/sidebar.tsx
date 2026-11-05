import { useEffect, useState } from "react";
import { View } from "react-native";
import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";

import { getSummary } from "../shared/contracts";
import { summaryAttention, type Summary } from "../shared/summary";

/**
 * The sidebar row: quiet while everything works, a dot when the bridge needs the
 * person (amber: not paired yet; red: the bridge is down or the last send failed).
 */
export function sidebarRow(client: PluginClientContext, title: string) {
  return function SendToPaseoRow({ host, theme, currentScreen, openScreen }: PluginSidebarItemProps) {
    const [summary, setSummary] = useState<Summary | null>(null);
    useEffect(() => {
      let live = true;
      const read = () => void client.rpc(getSummary, { serverId: host.id }).then((value) => { if (live) setSummary(value); }, () => undefined);
      read();
      const timer = setInterval(read, 15_000);
      return () => { live = false; clearInterval(timer); };
    }, [host.id]);
    const attention = summary === null ? null : summaryAttention(summary);
    const color = attention === null ? null : attention.tone === "danger" ? theme.colors.statusDanger : theme.colors.statusWarning;
    return <SidebarRow
      icon="Send"
      label={title}
      active={currentScreen?.screenId === "settings"}
      onPress={() => openScreen({ screenId: "settings" })}
      trailing={color === null ? undefined : <View accessibilityLabel={attention!.label} style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color, marginRight: 6 }} />}
    />;
  };
}
