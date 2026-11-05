import { Platform, Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { ExternalLink, Icon } from "@getpaseo/plugin/client/ui";

import type { BridgeStatus, RecentSend } from "../shared/contracts";
import { CHROME_WEB_STORE_URL, ago, destination, lead, prLabel } from "../shared/overview";
import { raised, tabular, tint } from "./theme";

const mono = Platform.OS === "ios" ? "Menlo" : Platform.OS === "android" ? "monospace" : "ui-monospace, SFMono-Regular, Menlo, monospace";

type Colors = PluginTheme["colors"];

function GhostButton({ label, icon, onPress, colors, primary = false }: { label: string; icon?: string; onPress: () => void; colors: Colors; primary?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={4}
      style={({ pressed }) => ({
        flexDirection: "row", alignItems: "center", gap: 6, minHeight: 32, paddingHorizontal: 12, borderRadius: 8,
        borderWidth: 1, borderColor: primary ? colors.accent : colors.border,
        backgroundColor: primary ? colors.accent : pressed ? colors.surface2 : "transparent",
        transform: [{ scale: pressed ? 0.97 : 1 }],
      })}>
      {icon === undefined ? null : <Icon name={icon} size={14} color={primary ? colors.accentForeground : colors.foreground} />}
      <Text style={{ color: primary ? colors.accentForeground : colors.foreground, fontSize: 13, fontWeight: primary ? "600" : "400" }}>{label}</Text>
    </Pressable>
  );
}

function Step({ n, done, title, children, colors }: { n: number; done: boolean; title: string; children?: React.ReactNode; colors: Colors }) {
  return (
    <View style={{ flexDirection: "row", gap: 12 }}>
      <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: done ? tint(colors.statusSuccess, colors) : colors.surface2 }}>
        {done ? <Icon name="Check" size={13} color={colors.statusSuccess} /> : <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "600", ...tabular }}>{n}</Text>}
      </View>
      <View style={{ flex: 1, gap: 8, paddingTop: 2 }}>
        <Text style={{ color: colors.foreground, fontSize: 14, lineHeight: 19 }}>{title}</Text>
        {children}
      </View>
    </View>
  );
}

/**
 * Status first: one sentence that says whether sending works and what comes
 * next, then either the three pairing steps (first run) or the send history.
 */
export function Overview({ status, sends, colors, compact, onCopyToken, onToggleDetails, detailsOpen, onOpenAgent, onClear }: {
  status: BridgeStatus;
  sends: RecentSend[];
  colors: Colors;
  compact: boolean;
  onCopyToken: () => void;
  onToggleDetails: () => void;
  detailsOpen: boolean;
  onOpenAgent: ((agentId: string) => void) | null;
  onClear: () => void;
}) {
  const head = lead(status, sends);
  const tone = head.kind === "down" ? colors.statusDanger : head.kind === "setup" ? colors.statusWarning : colors.foreground;
  const facts = [
    status.state === "running" ? `Bridge on 127.0.0.1:${status.port}` : `Port ${status.configuredPort}`,
    status.daemon.version === null ? null : `Paseo ${status.daemon.version}`,
    status.dryRun ? "dry run" : null,
  ].filter((part): part is string => part !== null);
  return (
    <View style={{ gap: compact ? 16 : 20 }}>
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {head.kind === "ready" ? null : <Icon name={head.kind === "down" ? "CircleX" : "Link"} size={18} color={tone} />}
          <Text accessibilityRole="header" style={{ flexShrink: 1, color: head.kind === "down" ? tone : colors.foreground, fontSize: compact ? 18 : 20, lineHeight: compact ? 24 : 27, fontWeight: "600", ...tabular }}>{head.text}</Text>
        </View>
        {head.detail === "" ? null : <Text style={{ color: colors.foregroundMuted, fontSize: 14, lineHeight: 20, maxWidth: 620 }}>{head.detail}</Text>}
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 12, rowGap: 6, marginTop: 4 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12, ...tabular }}>{facts.join(compact ? ", " : " · ")}</Text>
          <Pressable accessibilityRole="button" aria-expanded={detailsOpen} onPress={onToggleDetails} hitSlop={6} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Text style={{ color: colors.foreground, fontSize: 12, textDecorationLine: "underline" }}>{detailsOpen ? "Hide connection details" : "Connection details"}</Text>
          </Pressable>
        </View>
      </View>

      {head.kind === "setup" ? (
        <View style={[{ borderRadius: 12, backgroundColor: colors.surface1, padding: compact ? 14 : 18, gap: 16 }, raised(colors)]}>
          <Step n={1} done={false} title="Add the Chrome extension" colors={colors}>
            <View style={{ flexDirection: "row" }}>
              <ExternalLink href={CHROME_WEB_STORE_URL} accessibilityLabel="Open Send to Paseo in the Chrome Web Store">
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 32, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: colors.border }}>
                  <Text style={{ color: colors.foreground, fontSize: 13 }}>Chrome Web Store</Text>
                </View>
              </ExternalLink>
            </View>
          </Step>
          <Step n={2} done={false} title="Copy the pairing token" colors={colors}>
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
              <GhostButton label="Copy token" icon="Copy" primary onPress={onCopyToken} colors={colors} />
              <Text style={{ color: colors.foregroundMuted, fontFamily: mono, fontSize: 12 }}>{status.tokenPreview}</Text>
            </View>
          </Step>
          <Step n={3} done={false} title="Click the extension's icon in Chrome, paste the token, and press Test connection" colors={colors}>
            <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 18 }}>This screen updates as soon as Chrome connects. Treat the token like a password.</Text>
          </Step>
        </View>
      ) : null}

      {sends.length === 0 ? null : (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 15, fontWeight: "600" }}>Recent sends</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Clear recent sends" onPress={onClear} hitSlop={6}
              style={({ pressed }) => ({ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: pressed ? colors.surface2 : "transparent" })}>
              <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Clear</Text>
            </Pressable>
          </View>
          <View style={[{ borderRadius: 12, backgroundColor: colors.surface1, overflow: "hidden" }, raised(colors)]}>
            {sends.map((send, index) => <SendRow key={send.id} send={send} first={index === 0} colors={colors} compact={compact} onOpen={onOpenAgent} />)}
          </View>
        </View>
      )}
    </View>
  );
}

function SendRow({ send, first, colors, compact, onOpen }: { send: RecentSend; first: boolean; colors: Colors; compact: boolean; onOpen: ((agentId: string) => void) | null }) {
  const failed = send.outcome === "failed";
  const openable = !failed && send.agentId !== null && onOpen !== null;
  const title = send.dispatch === "main" ? null : send.title.replace(/^PR #\d+ · /, "");
  const body = (hovered: boolean) => (
    <View style={{ flexDirection: "row", gap: 12, paddingHorizontal: compact ? 12 : 16, paddingVertical: 12, borderTopWidth: first ? 0 : 1, borderTopColor: colors.border, backgroundColor: hovered ? colors.surface2 : "transparent" }}>
      <View style={{ paddingTop: 2 }}>
        <Icon name={failed ? "TriangleAlert" : send.workspaceCreated ? "GitBranchPlus" : "GitPullRequest"} size={15} color={failed ? colors.statusDanger : colors.foregroundMuted} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foreground, fontSize: 14, fontWeight: "600", ...tabular }}>{prLabel(send.prLabel)}</Text>
          <View style={{ flex: 1 }} />
          <Text style={{ color: colors.foregroundMuted, fontSize: 12, ...tabular }}>{ago(send.at)}</Text>
        </View>
        {title === null || title === "" ? null : <Text numberOfLines={2} style={{ color: colors.foreground, fontSize: 13, lineHeight: 18 }}>{title}</Text>}
        <Text numberOfLines={failed ? 3 : 1} style={{ color: failed ? colors.statusDanger : colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{failed ? `Not sent. ${destination(send)}` : destination(send)}</Text>
      </View>
      <View style={{ width: 14, justifyContent: "center" }}>{openable ? <Icon name="ChevronRight" size={14} color={colors.foregroundMuted} /> : null}</View>
    </View>
  );
  if (!openable) return body(false);
  const agentId = send.agentId!;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Open the agent for ${prLabel(send.prLabel)}`} onPress={() => onOpen!(agentId)}>
      {(state) => body((state as { hovered?: boolean }).hovered === true)}
    </Pressable>
  );
}
