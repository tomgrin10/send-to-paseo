import type { PluginTheme } from "@getpaseo/plugin";
import {
  getPaseoClient,
  type PluginSurfaceProps,
  useHosts,
  useRpc,
} from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  addAdditionalMachine,
  clearRecentSends,
  DEFAULT_PORT,
  enablePrivateAccess,
  externalBridgeUrlProblem,
  getConnectionCode,
  getStatus,
  removeAdditionalMachine,
  regenerateToken,
  revealToken,
  testAdditionalMachine,
  updateAdditionalMachine,
  updateConfig,
  type AdditionalMachine,
  type AgentProfileOption,
  type BridgeStatus,
  type DependencyReportPayload,
  type ModeOption,
  type ProviderOption,
} from "../shared/contracts";
import { Overview } from "./overview";
import { raised } from "./theme";
import { checkHostAccess, organizeDiscoveredHosts, type DiscoveredHostRow } from "./hosts";

/**
 * The Send to Paseo sidebar surface: bridge status, the pairing token, the
 * default model and a short send history.
 *
 * Every `Text` takes its color from `theme.colors` and every gap from
 * `layout.compact`. Unstyled text renders black, which is unreadable in Paseo's
 * dark themes and on mobile.
 */

const QUERY_KEY = ["send-to-paseo", "status"];
/** The daemon offers 180+ models; the list stays usable behind a filter. */
const PROVIDER_LIST_LIMIT = 12;

function stateLabel(status: BridgeStatus): string {
  switch (status.state) {
    case "running":
      return `Listening on http://127.0.0.1:${status.port}`;
    case "starting":
      return "Starting…";
    case "failed":
      return "Not running";
    case "stopped":
      return "Stopped";
  }
}

function stateTone(status: BridgeStatus, theme: PluginTheme): string {
  if (status.state === "running") return theme.colors.statusSuccess;
  if (status.state === "failed" || status.state === "stopped") return theme.colors.statusDanger;
  return theme.colors.statusWarning;
}

function hostStatusTone(
  status: DiscoveredHostRow["status"],
  theme: PluginTheme,
): string {
  if (status === "online") return theme.colors.statusSuccess;
  if (status === "error") return theme.colors.statusDanger;
  return theme.colors.statusWarning;
}

function formatWhen(iso: string | null): string {
  if (iso === null) return "never";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "never";
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(at).toLocaleDateString();
}

async function copyToClipboard(value: string): Promise<boolean> {
  try {
    await copyText(value);
    return true;
  } catch {
    return false;
  }
}

function useStyles(theme: PluginTheme, compact: boolean) {
  return useMemo(
    () => ({
      screen: {
        flex: 1,
        backgroundColor: theme.colors.surface0,
      },
      content: {
        padding: compact ? 16 : 32,
        gap: compact ? 16 : 20,
        width: "100%" as const,
        maxWidth: 820,
        alignSelf: "center" as const,
      },
      card: {
        backgroundColor: theme.colors.surface1,
        borderRadius: 12,
        ...raised(theme.colors),
        padding: compact ? 12 : 16,
        gap: compact ? 8 : 10,
      },
      heading: {
        color: theme.colors.foreground,
        fontSize: compact ? 15 : 16,
        fontWeight: "600" as const,
      },
      title: {
        color: theme.colors.foreground,
        fontSize: compact ? 20 : 24,
        fontWeight: "600" as const,
      },
      body: { color: theme.colors.foreground, fontSize: compact ? 13 : 14 },
      muted: { color: theme.colors.foregroundMuted, fontSize: compact ? 12 : 13 },
      mono: {
        color: theme.colors.foreground,
        fontSize: compact ? 12 : 13,
        fontFamily: Platform.OS === "ios" ? "Menlo" : Platform.OS === "android" ? "monospace" : "ui-monospace, SFMono-Regular, Menlo, monospace",
      },
      row: { flexDirection: "row" as const, gap: 8, alignItems: "center" as const },
      wrapRow: { flexDirection: "row" as const, gap: 8, flexWrap: "wrap" as const },
      input: {
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        fontSize: compact ? 13 : 14,
        minWidth: 96,
      },
      button: {
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
      },
      buttonText: { color: theme.colors.foreground, fontSize: compact ? 12 : 13 },
      primary: {
        backgroundColor: theme.colors.accent,
        borderColor: theme.colors.accent,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
      },
      primaryText: { color: theme.colors.accentForeground, fontSize: compact ? 12 : 13 },
      danger: { color: theme.colors.statusDanger, fontSize: compact ? 12 : 13 },
      tokenBox: {
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 10,
      },
      listRow: {
        borderTopColor: theme.colors.border,
        borderTopWidth: 1,
        paddingVertical: 8,
        gap: 2,
      },
      radio: {
        width: 16,
        height: 16,
        borderRadius: 8,
        borderWidth: 1.5,
        borderColor: theme.colors.foregroundMuted,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        marginTop: compact ? 1 : 2,
      },
      radioOn: { borderColor: theme.colors.foreground },
      radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.foreground },
      choiceRow: { borderRadius: 8, paddingHorizontal: 8 },
      selectedRow: {
        backgroundColor: theme.colors.surface2,
        borderRadius: 8,
        paddingHorizontal: 8,
      },
    }),
    [theme, compact],
  );
}

type Styles = ReturnType<typeof useStyles>;

function Button({
  label,
  onPress,
  styles,
  primary = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  styles: Styles;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [primary ? styles.primary : styles.button, disabled ? { opacity: 0.5 } : null, { transform: [{ scale: pressed && !disabled ? 0.97 : 1 }] }]}
    >
      <Text style={primary ? styles.primaryText : styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

/** A radio row: neutral ring and dot, so the accent stays on primary buttons. */
function Choice({ on, styles, children }: { on: boolean; styles: Styles; children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: "row", gap: 10, paddingVertical: 6 }}>
      <View style={[styles.radio, on ? styles.radioOn : null]}>
        {on ? <View style={styles.radioDot} /> : null}
      </View>
      <View style={{ flex: 1, gap: 2 }}>{children}</View>
    </View>
  );
}

function ProviderPicker({
  providers,
  selected,
  onSelect,
  styles,
}: {
  providers: ProviderOption[];
  selected: string | null;
  onSelect: (id: string) => void;
  styles: Styles;
}) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const matches = useMemo(() => {
    const filtered =
      needle === ""
        ? providers
        : providers.filter(
            (provider) =>
              provider.label.toLowerCase().includes(needle) ||
              provider.id.toLowerCase().includes(needle),
          );
    return filtered.slice(0, PROVIDER_LIST_LIMIT);
  }, [providers, needle]);

  return (
    <View style={{ gap: 8 }}>
      <TextInput
        value={filter}
        onChangeText={setFilter}
        placeholder="Filter models"
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {matches.length === 0 ? (
        <Text style={styles.muted}>No model matches that filter.</Text>
      ) : null}
      {matches.map((provider) => {
        const isSelected = provider.id === selected;
        return (
          <Pressable
            key={provider.id}
            accessibilityRole="button"
            accessibilityLabel={`Use ${provider.label} by default`}
            onPress={() => onSelect(provider.id)}
            style={isSelected ? styles.selectedRow : styles.choiceRow}
          >
            <Choice on={isSelected} styles={styles}>
              <Text style={styles.body}>
                
                {provider.label}
              </Text>
              <Text style={styles.muted}>{provider.id}</Text>
            </Choice>
          </Pressable>
        );
      })}
      {providers.length > matches.length ? (
        <Text style={styles.muted}>
          {providers.length - matches.length} more; use the filter to narrow it down.
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The saved Paseo agent profiles, as a single-select list.
 *
 * A profile is followed by *id*, re-read on every send: there is no way to
 * reference one at agent-create time, so the plugin copies `provider`, `model`,
 * `modeId` and `thinkingOptionId` out of it each time. Edit the profile in
 * Paseo and the next send follows, with no re-copy step here.
 */
function ProfilePicker({
  profiles,
  selected,
  onSelect,
  styles,
}: {
  profiles: AgentProfileOption[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  styles: Styles;
}) {
  if (profiles.length === 0) {
    return <Text style={styles.muted}>No agent profiles are saved in Paseo yet.</Text>;
  }
  return (
    <View style={{ gap: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Do not follow a profile"
        onPress={() => onSelect(null)}
        style={selected === null ? styles.selectedRow : styles.choiceRow}
      >
        <Choice on={selected === null} styles={styles}>
          <Text style={styles.body}>No profile</Text>
          <Text style={styles.muted}>Use the model and mode chosen below instead.</Text>
        </Choice>
      </Pressable>
      {profiles.map((profile) => {
        const isSelected = profile.id === selected;
        const detail = [
          profile.model === null ? profile.provider : `${profile.provider}/${profile.model}`,
          profile.modeId === null ? "no mode set" : `mode ${profile.modeId}`,
          profile.thinkingOptionId === null ? null : `thinking ${profile.thinkingOptionId}`,
        ]
          .filter((part): part is string => part !== null)
          .join(" · ");
        return (
          <Pressable
            key={profile.id}
            accessibilityRole="button"
            accessibilityLabel={`Follow the ${profile.name} profile`}
            onPress={() => onSelect(profile.id)}
            style={isSelected ? styles.selectedRow : styles.choiceRow}
          >
            <Choice on={isSelected} styles={styles}>
              <Text style={styles.body}>
                
                {profile.name}
              </Text>
              <Text style={styles.muted}>{detail}</Text>
            </Choice>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Permission modes, grouped by provider because mode ids *are* per provider:
 * `bypassPermissions` is a Claude id and means nothing to Codex. The stored
 * value is a bare mode id, and a send validates it against whichever provider
 * it actually resolved to, falling through when it does not fit.
 *
 * Unattended modes are listed, never hidden — they are marked in the warning
 * colour and named as what they are.
 */
function ModePicker({
  modes,
  selected,
  onSelect,
  styles,
  theme,
}: {
  modes: ModeOption[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  styles: Styles;
  theme: PluginTheme;
}) {
  const providers = useMemo(() => {
    const grouped = new Map<string, ModeOption[]>();
    for (const mode of modes) {
      const bucket = grouped.get(mode.provider);
      if (bucket === undefined) grouped.set(mode.provider, [mode]);
      else bucket.push(mode);
    }
    return [...grouped.entries()];
  }, [modes]);

  if (providers.length === 0) {
    return <Text style={styles.muted}>Paseo reported no selectable modes.</Text>;
  }

  return (
    <View style={{ gap: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Follow Paseo's own default mode"
        onPress={() => onSelect(null)}
        style={selected === null ? styles.selectedRow : styles.choiceRow}
      >
        <Choice on={selected === null} styles={styles}>
          <Text style={styles.body}>Follow Paseo</Text>
          <Text style={styles.muted}>Each provider&apos;s own default mode.</Text>
        </Choice>
      </Pressable>
      {providers.map(([provider, providerModes]) => (
        <View key={provider} style={{ gap: 2 }}>
          <Text style={styles.muted}>{provider}</Text>
          {providerModes.map((mode) => {
            const isSelected = mode.id === selected;
            const unattended = mode.isUnattended === true;
            return (
              <Pressable
                key={`${provider}/${mode.id}`}
                accessibilityRole="button"
                accessibilityLabel={`Default to ${mode.label} for ${provider}`}
                onPress={() => onSelect(mode.id)}
                style={isSelected ? styles.selectedRow : styles.choiceRow}
              >
                <Choice on={isSelected} styles={styles}>
                  <Text style={styles.body}>
                    
                    {mode.label}
                    {unattended ? (
                      <Text style={{ color: theme.colors.statusWarning }}> — unattended</Text>
                    ) : null}
                    {mode.isDefault ? <Text style={styles.muted}> (provider default)</Text> : null}
                  </Text>
                  <Text style={styles.muted}>{mode.id}</Text>
                </Choice>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

/**
 * One external command: whether it was found, which copy, and what is lost
 * without it. `path` is shown because the whole point of the well-known-location
 * probing is that the answer here can differ from the user's terminal.
 */
function DependencyRow({
  dependency,
  styles,
  theme,
}: {
  dependency: DependencyReportPayload;
  styles: Styles;
  theme: PluginTheme;
}) {
  const tone =
    dependency.state === "ok"
      ? theme.colors.statusSuccess
      : dependency.required
        ? theme.colors.statusDanger
        : theme.colors.statusWarning;
  const summary =
    dependency.state === "ok"
      ? (dependency.version ?? "found")
      : dependency.state === "missing"
        ? dependency.required
          ? "not installed — required"
          : "not installed — optional"
        : "installed, not usable";

  return (
    <View style={{ gap: 2 }}>
      <View style={styles.row}>
        <Icon name={dependency.state === "ok" ? "CircleCheck" : "TriangleAlert"} size={14} color={tone} />
        <Text style={styles.body}>
        {dependency.name} — {summary}
      </Text>
      </View>
      {dependency.path === null ? null : <Text style={styles.muted}>{dependency.path}</Text>}
      {dependency.detail === "" ? null : (
        <Text style={styles.muted}>{dependency.detail}</Text>
      )}
      {dependency.hint === "" ? null : <Text style={styles.mono}>{dependency.hint}</Text>}
    </View>
  );
}

export function SendToPaseoSettings({ theme, host, layout, navigation }: PluginSurfaceProps) {
  const styles = useStyles(theme, layout.compact);
  const toast = useToast();
  const queryClient = useQueryClient();
  const paseoHosts = useHosts();

  const fetchStatus = useRpc(getStatus);
  const reveal = useRpc(revealToken);
  const regenerate = useRpc(regenerateToken);
  const update = useRpc(updateConfig);
  const clearRecent = useRpc(clearRecentSends);
  const addMachine = useRpc(addAdditionalMachine);
  const updateMachine = useRpc(updateAdditionalMachine);
  const removeMachine = useRpc(removeAdditionalMachine);
  const testMachine = useRpc(testAdditionalMachine);
  const connectionCode = useRpc(getConnectionCode);
  const enableAccess = useRpc(enablePrivateAccess);

  const [revealed, setRevealed] = useState<string | null>(null);
  const [portDraft, setPortDraft] = useState<string | null>(null);
  const [externalUrlDraft, setExternalUrlDraft] = useState<string | null>(null);
  const [connectionCodeDraft, setConnectionCodeDraft] = useState("");
  const [sharedCode, setSharedCode] = useState<string | null>(null);
  // Null until the person chooses; a bridge that is down opens the details on its own.
  const [detailsChoice, setShowConnectionDetails] = useState<boolean | null>(null);
  const [showAgentDefaults, setShowAgentDefaults] = useState(false);
  const [showAdvancedAccess, setShowAdvancedAccess] = useState(false);
  const [machineTests, setMachineTests] = useState<Record<string, string>>({});
  const [hostChecks, setHostChecks] = useState<Record<string, string>>({});

  const query = useQuery({
    queryKey: [...QUERY_KEY, host.id],
    queryFn: () => fetchStatus({ serverId: host.id }),
    refetchInterval: 5_000,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: QUERY_KEY });

  const savePort = useMutation({
    mutationFn: async (port: number) => update({ serverId: host.id, port }),
    onSuccess: (result) => {
      setPortDraft(null);
      invalidate();
      if (result.error !== null) toast.error(result.error);
      else toast.show(`Bridge now on port ${result.status.port}`, { variant: "success" });
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const saveProvider = useMutation({
    mutationFn: async (defaultProvider: string | null) =>
      update({ serverId: host.id, defaultProvider }),
    onSuccess: () => {
      invalidate();
      toast.show("Default model saved", { variant: "success" });
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const saveDispatch = useMutation({
    mutationFn: async (agentDispatch: "new" | "main") =>
      update({ serverId: host.id, agentDispatch }),
    onSuccess: () => {
      invalidate();
      toast.show("Agent destination saved", { variant: "success" });
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const saveExternalUrl = useMutation({
    mutationFn: async (externalBridgeUrl: string | null) =>
      update({ serverId: host.id, externalBridgeUrl }),
    onSuccess: (result) => {
      setExternalUrlDraft(null);
      invalidate();
      toast.show(
        result.status.externalBridgeUrl === null
          ? "Private bridge access disabled"
          : "Private bridge address saved",
        { variant: "success" },
      );
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const saveProfile = useMutation({
    mutationFn: async (defaultProfileId: string | null) =>
      update({ serverId: host.id, defaultProfileId }),
    onSuccess: () => {
      invalidate();
      toast.show("Profile saved", { variant: "success" });
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const saveMode = useMutation({
    mutationFn: async (defaultModeId: string | null) =>
      update({ serverId: host.id, defaultModeId }),
    onSuccess: () => {
      invalidate();
      toast.show("Default permission mode saved", { variant: "success" });
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const rotate = useMutation({
    mutationFn: async () => regenerate({ serverId: host.id }),
    onSuccess: (result) => {
      setRevealed(result.token);
      invalidate();
      toast.show("New token generated. Paste it into the extension options.", {
        variant: "warning",
      });
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const connectMachine = useMutation({
    mutationFn: async (code: string) =>
      addMachine({ serverId: host.id, connectionCode: code }),
    onSuccess: (result) => {
      setConnectionCodeDraft("");
      invalidate();
      toast.show(
        `Connected ${result.machine.label || result.machine.machineName || "additional Paseo machine"}`,
        { variant: "success" },
      );
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const enableAccessMutation = useMutation({
    mutationFn: async () => enableAccess({ serverId: host.id }),
    onSuccess: (result) => {
      if (!result.ready || result.code === null) {
        toast.error(result.error ?? "Private access could not be enabled.");
        return;
      }
      setSharedCode(result.code);
      invalidate();
      toast.show("Private access enabled. Connection code is ready.", { variant: "success" });
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const status = query.data?.status ?? null;
  const showConnectionDetails = detailsChoice ?? (status?.state === "failed" || status?.state === "stopped");
  const providers = query.data?.providers ?? [];
  const providersError = query.data?.providersError ?? null;
  const modes = query.data?.modes ?? [];
  const profiles = query.data?.profiles ?? [];
  const profilesError = query.data?.profilesError ?? null;
  const recent = query.data?.recentSends ?? [];
  const dependencies = query.data?.dependencies ?? [];
  const additionalMachines = query.data?.additionalMachines ?? [];
  const hostDiscovery = useMemo(
    () => organizeDiscoveredHosts(paseoHosts, host.id, additionalMachines),
    [paseoHosts, host.id, additionalMachines],
  );
  const selectedProvider =
    status?.defaultProvider ?? providers.find((provider) => provider.isDefault)?.id ?? null;
  const selectedProfileId = status?.defaultProfileId ?? null;
  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId) ?? null;

  async function onReveal() {
    if (revealed !== null) {
      setRevealed(null);
      return;
    }
    try {
      const result = await reveal({ serverId: host.id });
      setRevealed(result.token);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function onCopy() {
    try {
      const token = revealed ?? (await reveal({ serverId: host.id })).token;
      const copied = await copyToClipboard(token);
      if (copied) {
        toast.show("Token copied", { variant: "success" });
      } else {
        setRevealed(token);
        toast.show("Copy is unavailable here; the token is shown so you can copy it.", {
          variant: "info",
        });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function onCopyValue(value: string, label: string) {
    if (await copyToClipboard(value)) toast.show(`${label} copied`, { variant: "success" });
    else toast.error("Copy is unavailable here.");
  }

  async function onCopyConnectionCode() {
    try {
      const result = await connectionCode({ serverId: host.id });
      if (!result.ready || result.code === null) {
        toast.error(result.error ?? "Enable private access first.");
        return;
      }
      setSharedCode(result.code);
      await onCopyValue(result.code, "Connection code");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function onTestMachine(machine: AdditionalMachine) {
    setMachineTests((current) => ({ ...current, [machine.id]: "Testing…" }));
    try {
      const result = await testMachine({ serverId: host.id, id: machine.id });
      setMachineTests((current) => ({ ...current, [machine.id]: result.detail }));
      invalidate();
      if (result.ok) toast.show("Additional machine connected", { variant: "success" });
      else toast.error(result.detail);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMachineTests((current) => ({ ...current, [machine.id]: detail }));
      toast.error(detail);
    }
  }

  async function onCheckHost(target: DiscoveredHostRow) {
    setHostChecks((current) => ({ ...current, [target.serverId]: "Checking…" }));
    try {
      const projectCount = await checkHostAccess(target.serverId, getPaseoClient);
      const detail = `Paseo access verified · ${projectCount} project${projectCount === 1 ? "" : "s"}`;
      setHostChecks((current) => ({ ...current, [target.serverId]: detail }));
      toast.show(`${target.label}: Paseo access verified`, { variant: "success" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setHostChecks((current) => ({ ...current, [target.serverId]: detail }));
      toast.error(detail);
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {status === null ? (
        <Text style={styles.muted}>{query.isError ? "Status unavailable. Check that the plugin is running." : "Loading…"}</Text>
      ) : (
        <Overview
          status={status}
          sends={recent}
          colors={theme.colors}
          compact={layout.compact}
          onCopyToken={() => void onCopy()}
          detailsOpen={showConnectionDetails}
          onToggleDetails={() => setShowConnectionDetails(!showConnectionDetails)}
          onOpenAgent={navigation === undefined ? null : (agentId) => navigation.openAgent({ agentId, serverId: host.id })}
          onClear={() => void clearRecent({ serverId: host.id }).then(invalidate)}
        />
      )}

      {status !== null && showConnectionDetails ? (
      <View style={styles.card}>
        <Text style={styles.heading}>Connection</Text>
          <>
            <Text style={{ ...styles.body, color: stateTone(status, theme) }}>
              {stateLabel(status)}
            </Text>
            <Text style={styles.muted}>
              {hostDiscovery.hosts.length} Paseo machine
              {hostDiscovery.hosts.length === 1 ? "" : "s"} discovered automatically.
            </Text>
              <View style={{ gap: 8 }}>
                <Text style={styles.muted}>
                  {status.paired ? "Paired" : "Not yet paired"} · {status.requestCount} request
                  {status.requestCount === 1 ? "" : "s"} · last {formatWhen(status.lastRequestAt)}
                </Text>
                <Text style={styles.muted}>
                  Daemon{" "}
                  {status.daemon.reachable
                    ? `reachable (${status.daemon.version ?? "unknown"})`
                    : "unreachable"}
                  {status.dryRun ? " · dry run enabled" : ""}
                </Text>
                <View style={styles.row}>
                  <Text style={styles.muted}>Port</Text>
                  <TextInput
                    value={portDraft ?? String(status.configuredPort)}
                    onChangeText={setPortDraft}
                    keyboardType="number-pad"
                    style={styles.input}
                    accessibilityLabel="Bridge port"
                  />
                  <Button
                    label="Save"
                    styles={styles}
                    primary
                    disabled={portDraft === null || savePort.isPending}
                    onPress={() => {
                      const parsed = Number(portDraft);
                      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
                        toast.error("Enter a port between 1 and 65535.");
                        return;
                      }
                      savePort.mutate(parsed);
                    }}
                  />
                </View>
              </View>
          </>
      </View>
      ) : null}

      {showConnectionDetails ? (
        <>
      <View style={styles.card}>
        <Text style={styles.heading}>Paseo machines</Text>
        <Text style={styles.muted}>
          Discovered automatically from Paseo 0.9. Offline configured hosts stay visible. “Check
          Paseo access” borrows that exact host&apos;s authenticated app connection; it never falls
          back to this screen&apos;s host.
        </Text>
        {hostDiscovery.hosts.length === 0 ? (
          <Text style={styles.muted}>No Paseo hosts are configured in this app.</Text>
        ) : (
          hostDiscovery.hosts.map((target) => (
            <View key={target.serverId} style={styles.listRow}>
              <Text style={styles.body}>
                {target.label}
                {target.isSurfaceHost ? " — this screen" : ""}
              </Text>
              <Text style={{ ...styles.muted, color: hostStatusTone(target.status, theme) }}>
                {target.status}
              </Text>
              <Text style={styles.mono}>{target.serverId}</Text>
              <Text style={styles.muted}>
                {target.isSurfaceHost
                  ? "Browser route: this plugin's loopback bridge."
                  : target.route === null
                    ? "Discovered by Paseo; not connected to this browser bridge yet."
                    : `Browser route: ${target.route.enabled ? "connected" : "disabled"} · ${target.route.bridgeUrl}`}
              </Text>
              {hostChecks[target.serverId] === undefined ? null : (
                <Text style={styles.muted}>{hostChecks[target.serverId]}</Text>
              )}
              <Button
                label={target.status === "online" ? "Check Paseo access" : `Unavailable (${target.status})`}
                styles={styles}
                disabled={target.status !== "online" || hostChecks[target.serverId] === "Checking…"}
                onPress={() => void onCheckHost(target)}
              />
            </View>
          ))
        )}
        <Text style={styles.muted}>
          Paseo discovery does not expose bridge URLs or pairing tokens. To make another host a
          browser target, copy its Send to Paseo connection code and paste it here.
        </Text>
        <TextInput
          value={connectionCodeDraft}
          onChangeText={setConnectionCodeDraft}
          placeholder="Paste stp1_… connection code"
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Additional Paseo machine connection code"
        />
        <Button
          label={connectMachine.isPending ? "Connecting…" : "Connect additional machine"}
          styles={styles}
          disabled={connectionCodeDraft.trim() === "" || connectMachine.isPending}
          onPress={() => connectMachine.mutate(connectionCodeDraft)}
        />
        <Text style={styles.heading}>Browser bridge routes</Text>
        {additionalMachines.length === 0 ? (
          <Text style={styles.muted}>No additional browser routes connected yet.</Text>
        ) : (
          additionalMachines.map((machine) => (
            <View key={machine.id} style={styles.listRow}>
              <Text style={styles.body}>
                {machine.label || machine.machineName || new URL(machine.bridgeUrl).host}
                {machine.enabled ? "" : " — disabled"}
              </Text>
              <Text style={styles.mono}>
                {machine.serverId ?? "Server ID pending first successful check"}
              </Text>
              <Text style={styles.muted}>{machine.bridgeUrl}</Text>
              <Text style={styles.muted}>Token {machine.tokenPreview}</Text>
              {machineTests[machine.id] === undefined ? null : (
                <Text style={styles.muted}>{machineTests[machine.id]}</Text>
              )}
              <View style={styles.wrapRow}>
                <Button
                  label="Test"
                  styles={styles}
                  onPress={() => void onTestMachine(machine)}
                />
                <Button
                  label={machine.enabled ? "Disable" : "Enable"}
                  styles={styles}
                  onPress={() =>
                    void updateMachine({
                      serverId: host.id,
                      id: machine.id,
                      enabled: !machine.enabled,
                    })
                      .then(invalidate)
                      .catch((error: unknown) =>
                        toast.error(error instanceof Error ? error.message : String(error)),
                      )
                  }
                />
                <Button
                  label="Remove"
                  styles={styles}
                  onPress={() =>
                    void removeMachine({ serverId: host.id, id: machine.id })
                      .then(invalidate)
                      .catch((error: unknown) =>
                        toast.error(error instanceof Error ? error.message : String(error)),
                      )
                  }
                />
              </View>
            </View>
          ))
        )}
        {hostDiscovery.undiscoveredRoutes.length === 0 ? null : (
          <Text style={styles.muted}>
            {hostDiscovery.undiscoveredRoutes.length} route
            {hostDiscovery.undiscoveredRoutes.length === 1 ? " is" : "s are"} retained for browser
            compatibility but not currently present in Paseo&apos;s configured host list. Check or
            remove {hostDiscovery.undiscoveredRoutes.length === 1 ? "it" : "them"} above.
          </Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>Share this Paseo machine</Text>
        <Text style={styles.muted}>
          This is needed only for browser bridge routing; Paseo host discovery itself is automatic.
          “Enable private access” runs Tailscale Serve on this machine, then creates one secret
          connection code containing its server ID, private bridge address and pairing token.
        </Text>
        <View style={styles.wrapRow}>
          <Button
            label={enableAccessMutation.isPending ? "Enabling…" : "Enable private access"}
            styles={styles}
            primary
            disabled={enableAccessMutation.isPending}
            onPress={() => enableAccessMutation.mutate()}
          />
          <Button label="Copy connection code" styles={styles} onPress={() => void onCopyConnectionCode()} />
        </View>
        {sharedCode === null ? null : (
          <View style={styles.tokenBox}>
            <Text style={styles.mono} selectable>{sharedCode}</Text>
          </View>
        )}
        <Text style={styles.muted}>
          The code is a secret: anyone who has it can start Paseo agents on this machine.
        </Text>
        <Button
          label={showAdvancedAccess ? "Hide advanced setup" : "Advanced: configure private access manually"}
          styles={styles}
          onPress={() => setShowAdvancedAccess(!showAdvancedAccess)}
        />
        {showAdvancedAccess ? (
          <View style={{ gap: 8 }}>
            <Text style={styles.muted}>
              Run this command in a terminal on this Paseo machine, then paste the HTTPS .ts.net
              address it prints below. Do not use a cloud .internal name or a 100.x IP over HTTP.
            </Text>
            <View style={styles.tokenBox}>
              <Text style={styles.mono} selectable>
                {`tailscale serve --bg ${status?.configuredPort ?? DEFAULT_PORT}`}
              </Text>
            </View>
            <Button
              label="Copy command"
              styles={styles}
              onPress={() => void onCopyValue(`tailscale serve --bg ${status?.configuredPort ?? DEFAULT_PORT}`, "Command")}
            />
            <TextInput
              value={externalUrlDraft ?? status?.externalBridgeUrl ?? ""}
              onChangeText={setExternalUrlDraft}
              placeholder="https://devbox.example.ts.net"
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              accessibilityLabel="Private bridge address"
            />
            <Button
              label={saveExternalUrl.isPending ? "Saving…" : "Save private bridge address"}
              styles={styles}
              disabled={externalUrlDraft === null || saveExternalUrl.isPending}
              onPress={() => {
                const value = externalUrlDraft?.trim() ?? "";
                if (value === "") return saveExternalUrl.mutate(null);
                const problem = externalBridgeUrlProblem(value);
                if (problem !== null) return toast.error(problem);
                saveExternalUrl.mutate(value);
              }}
            />
          </View>
        ) : null}
      </View>
        </>
      ) : null}

      {/*
        The most discoverable place to learn that gh is missing. Sending works
        without it, so this reads as information rather than as a failure — the
        card only turns loud for a dependency that is actually required.
      */}
      {showConnectionDetails || dependencies.some((dependency) => dependency.state !== "ok") ? (
      <View style={styles.card}>
        <Text style={styles.heading}>Requirements</Text>
        {dependencies.length === 0 ? (
          <Text style={styles.muted}>{query.isError ? "Unavailable." : "Checking…"}</Text>
        ) : (
          dependencies.map((dependency) => (
            <DependencyRow
              key={dependency.name}
              dependency={dependency}
              styles={styles}
              theme={theme}
            />
          ))
        )}
      </View>
      ) : null}

      {status?.paired === false && status.state === "running" ? null : (
      <View style={styles.card}>
        <Text style={styles.heading}>Pairing token</Text>
        <Text style={styles.muted}>
          Paste this into the extension options page. It is the only thing standing between a web
          page and an agent on this machine, so treat it like a password.
        </Text>
        <View style={styles.tokenBox}>
          <Text style={styles.mono} selectable>
            {revealed ?? status?.tokenPreview ?? "…"}
          </Text>
        </View>
        <View style={styles.wrapRow}>
          <Button
            label={revealed === null ? "Reveal" : "Hide"}
            styles={styles}
            onPress={() => void onReveal()}
          />
          <Button label="Copy" styles={styles} onPress={() => void onCopy()} />
          <Button
            label={rotate.isPending ? "Regenerating…" : "Regenerate"}
            styles={styles}
            disabled={rotate.isPending}
            onPress={() => rotate.mutate()}
          />
        </View>
      </View>
      )}

      <View style={styles.card}>
        <Text style={styles.heading}>Default agent destination</Text>
        <Text style={styles.muted}>
          Sets the extension dropdown&apos;s initial choice. You can override it for each send.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Default each send to a new agent"
          onPress={() => saveDispatch.mutate("new")}
          style={(status?.agentDispatch ?? "new") === "new" ? styles.selectedRow : styles.choiceRow}
        >
          <Choice on={(status?.agentDispatch ?? "new") === "new"} styles={styles}>
            <Text style={styles.body}>
              New agent
            </Text>
            <Text style={styles.muted}>Start a separate agent for every send.</Text>
          </Choice>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Default each send to the main agent in the target workspace"
          onPress={() => saveDispatch.mutate("main")}
          style={status?.agentDispatch === "main" ? styles.selectedRow : styles.choiceRow}
        >
          <Choice on={status?.agentDispatch === "main"} styles={styles}>
            <Text style={styles.body}>
              Main workspace agent
            </Text>
            <Text style={styles.muted}>
              Reuse the best root agent in that workspace. Prefers one named Main, then an open,
              active, or recently used agent; subagents are ignored. Starts fresh if none exists.
            </Text>
          </Choice>
        </Pressable>
        {status?.agentDispatch === "main" ? (
          <View style={{ gap: 6 }}>
            <Text style={styles.muted}>
              Profile, model, and permission defaults only apply if no main agent exists.
            </Text>
            <Button
              label={showAgentDefaults ? "Hide fallback agent defaults" : "Fallback new-agent defaults"}
              styles={styles}
              onPress={() => setShowAgentDefaults(!showAgentDefaults)}
            />
          </View>
        ) : null}
      </View>

      {(status?.agentDispatch ?? "new") === "new" || showAgentDefaults ? (
        <>
      <View style={styles.card}>
        <Text style={styles.heading}>Agent profile</Text>
        <Text style={styles.muted}>
          Follow one of your saved Paseo profiles. Its model, permission mode and thinking option
          are re-read on every send, so editing it in Paseo changes what this plugin does next —
          there is nothing to copy back here.
        </Text>
        {profilesError === null ? null : <Text style={styles.danger}>{profilesError}</Text>}
        <ProfilePicker
          profiles={profiles}
          selected={selectedProfileId}
          onSelect={(id) => saveProfile.mutate(id)}
          styles={styles}
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>Default permission mode</Text>
        <Text style={styles.muted}>
          Used when a send does not pick one and the followed profile does not set one. Mode ids
          belong to a provider, so a mode the chosen provider does not offer is skipped rather than
          failing the send.
        </Text>
        {selectedProfile?.modeId === null || selectedProfile === null ? null : (
          <Text style={styles.muted}>
            The {selectedProfile.name} profile sets mode {selectedProfile.modeId}, which wins over
            this.
          </Text>
        )}
        <ModePicker
          modes={modes}
          selected={status?.defaultModeId ?? null}
          onSelect={(id) => saveMode.mutate(id)}
          styles={styles}
          theme={theme}
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>Default model</Text>
        <Text style={styles.muted}>
          Used when a send does not pick one. {selectedProvider ?? "Following the daemon default."}
        </Text>
        {selectedProfile === null || selectedProfile.model === null ? null : (
          <Text style={styles.muted}>
            The {selectedProfile.name} profile selects {selectedProfile.provider}/
            {selectedProfile.model}, which wins over this.
          </Text>
        )}
        {providersError === null ? null : <Text style={styles.danger}>{providersError}</Text>}
        <ProviderPicker
          providers={providers}
          selected={selectedProvider}
          onSelect={(id) => saveProvider.mutate(id)}
          styles={styles}
        />
        {status?.defaultProvider === null || status === null ? null : (
          <Button
            label="Follow the daemon default"
            styles={styles}
            onPress={() => saveProvider.mutate(null)}
          />
        )}
      </View>
        </>
      ) : null}

    </ScrollView>
  );
}
