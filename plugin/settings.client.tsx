import { type PluginSurfaceProps, type PluginTheme, useRpc } from "@getpaseo/plugin";
import { useToast } from "@getpaseo/plugin/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  clearRecentSends,
  getStatus,
  regenerateToken,
  revealToken,
  updateConfig,
  type AgentProfileOption,
  type BridgeStatus,
  type DependencyReportPayload,
  type ModeOption,
  type ProviderOption,
  type RecentSend,
} from "./contracts.shared";

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
  if (status.state === "failed") return theme.colors.statusDanger;
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

/**
 * Copies through whichever clipboard the host actually provides. Paseo runs the
 * same bundle on desktop, browser and mobile, so neither path can be assumed.
 */
async function copyToClipboard(value: string): Promise<boolean> {
  const nav = (globalThis as { navigator?: { clipboard?: { writeText(v: string): Promise<void> } } })
    .navigator;
  if (nav?.clipboard !== undefined) {
    try {
      await nav.clipboard.writeText(value);
      return true;
    } catch {
      // Fall through to the React Native clipboard.
    }
  }
  try {
    const rn = (await import("react-native")) as { Clipboard?: { setString(v: string): void } };
    if (rn.Clipboard !== undefined) {
      rn.Clipboard.setString(value);
      return true;
    }
  } catch {
    // No clipboard available; the caller tells the user to copy by hand.
  }
  return false;
}

function useStyles(theme: PluginTheme, compact: boolean) {
  return useMemo(
    () => ({
      screen: {
        flex: 1,
        backgroundColor: theme.colors.surface0,
      },
      content: {
        padding: compact ? 16 : 24,
        gap: compact ? 16 : 20,
      },
      card: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 12,
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
        fontFamily: "Menlo",
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
      style={[primary ? styles.primary : styles.button, disabled ? { opacity: 0.5 } : null]}
    >
      <Text style={primary ? styles.primaryText : styles.buttonText}>{label}</Text>
    </Pressable>
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
            style={isSelected ? styles.selectedRow : undefined}
          >
            <View style={{ paddingVertical: 6 }}>
              <Text style={styles.body}>
                {isSelected ? "● " : "○ "}
                {provider.label}
              </Text>
              <Text style={styles.muted}>{provider.id}</Text>
            </View>
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
        style={selected === null ? styles.selectedRow : undefined}
      >
        <View style={{ paddingVertical: 6 }}>
          <Text style={styles.body}>{selected === null ? "● " : "○ "}No profile</Text>
          <Text style={styles.muted}>Use the model and mode chosen below instead.</Text>
        </View>
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
            style={isSelected ? styles.selectedRow : undefined}
          >
            <View style={{ paddingVertical: 6 }}>
              <Text style={styles.body}>
                {isSelected ? "● " : "○ "}
                {profile.name}
              </Text>
              <Text style={styles.muted}>{detail}</Text>
            </View>
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
        style={selected === null ? styles.selectedRow : undefined}
      >
        <View style={{ paddingVertical: 6 }}>
          <Text style={styles.body}>{selected === null ? "● " : "○ "}Follow Paseo</Text>
          <Text style={styles.muted}>Each provider&apos;s own default mode.</Text>
        </View>
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
                style={isSelected ? styles.selectedRow : undefined}
              >
                <View style={{ paddingVertical: 6 }}>
                  <Text style={styles.body}>
                    {isSelected ? "● " : "○ "}
                    {mode.label}
                    {unattended ? (
                      <Text style={{ color: theme.colors.statusWarning }}> — unattended</Text>
                    ) : null}
                    {mode.isDefault ? <Text style={styles.muted}> (provider default)</Text> : null}
                  </Text>
                  <Text style={styles.muted}>{mode.id}</Text>
                </View>
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
      <Text style={styles.body}>
        <Text style={{ color: tone }}>{dependency.state === "ok" ? "● " : "▲ "}</Text>
        {dependency.name} — {summary}
      </Text>
      {dependency.path === null ? null : <Text style={styles.muted}>{dependency.path}</Text>}
      {dependency.detail === "" ? null : (
        <Text style={styles.muted}>{dependency.detail}</Text>
      )}
      {dependency.hint === "" ? null : <Text style={styles.mono}>{dependency.hint}</Text>}
    </View>
  );
}

function RecentSendRow({
  send,
  styles,
  onOpen,
}: {
  send: RecentSend;
  styles: Styles;
  onOpen: ((agentId: string) => void) | null;
}) {
  const meta = [
    send.workspaceLabel,
    send.branch ?? "no branch",
    send.workspaceCreated ? "new worktree" : null,
    send.dryRun ? "dry run" : null,
    formatWhen(send.at),
  ]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");

  const body = (
    <View style={styles.listRow}>
      <Text style={styles.body}>
        {send.outcome === "ok" ? "" : "Failed — "}
        {send.prLabel} · {send.title}
      </Text>
      <Text style={styles.muted}>{meta}</Text>
      {send.error === null ? null : <Text style={styles.danger}>{send.error}</Text>}
    </View>
  );

  if (send.agentId === null || onOpen === null) return body;
  const agentId = send.agentId;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open the agent for ${send.prLabel}`}
      onPress={() => onOpen(agentId)}
    >
      {body}
    </Pressable>
  );
}

export function SendToPaseoSettings({ theme, layout, navigation }: PluginSurfaceProps) {
  const styles = useStyles(theme, layout.compact);
  const toast = useToast();
  const queryClient = useQueryClient();

  const fetchStatus = useRpc(getStatus);
  const reveal = useRpc(revealToken);
  const regenerate = useRpc(regenerateToken);
  const update = useRpc(updateConfig);
  const clearRecent = useRpc(clearRecentSends);

  const [revealed, setRevealed] = useState<string | null>(null);
  const [portDraft, setPortDraft] = useState<string | null>(null);

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => fetchStatus({}),
    refetchInterval: 5_000,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: QUERY_KEY });

  const savePort = useMutation({
    mutationFn: async (port: number) => update({ port }),
    onSuccess: (result) => {
      setPortDraft(null);
      invalidate();
      if (result.error !== null) toast.error(result.error);
      else toast.show(`Bridge now on port ${result.status.port}`, { variant: "success" });
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const saveProvider = useMutation({
    mutationFn: async (defaultProvider: string | null) => update({ defaultProvider }),
    onSuccess: () => {
      invalidate();
      toast.show("Default model saved", { variant: "success" });
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const saveProfile = useMutation({
    mutationFn: async (defaultProfileId: string | null) => update({ defaultProfileId }),
    onSuccess: () => {
      invalidate();
      toast.show("Profile saved", { variant: "success" });
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const saveMode = useMutation({
    mutationFn: async (defaultModeId: string | null) => update({ defaultModeId }),
    onSuccess: () => {
      invalidate();
      toast.show("Default permission mode saved", { variant: "success" });
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const rotate = useMutation({
    mutationFn: async () => regenerate({}),
    onSuccess: (result) => {
      setRevealed(result.token);
      invalidate();
      toast.show("New token generated. Paste it into the extension options.", {
        variant: "warning",
      });
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const status = query.data?.status ?? null;
  const providers = query.data?.providers ?? [];
  const providersError = query.data?.providersError ?? null;
  const modes = query.data?.modes ?? [];
  const profiles = query.data?.profiles ?? [];
  const profilesError = query.data?.profilesError ?? null;
  const recent = query.data?.recentSends ?? [];
  const dependencies = query.data?.dependencies ?? [];
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
      const result = await reveal({});
      setRevealed(result.token);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function onCopy() {
    try {
      const token = revealed ?? (await reveal({})).token;
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

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={{ gap: 4 }}>
        <Text style={styles.title}>Send to Paseo</Text>
        <Text style={styles.muted}>
          A local bridge that starts a Paseo agent in the workspace belonging to a pull request.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>Bridge</Text>
        {status === null ? (
          <Text style={styles.muted}>{query.isError ? "Status unavailable." : "Loading…"}</Text>
        ) : (
          <>
            <Text style={{ ...styles.body, color: stateTone(status, theme) }}>
              {stateLabel(status)}
            </Text>
            {status.error === null ? null : <Text style={styles.danger}>{status.error}</Text>}
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
          </>
        )}
      </View>

      {/*
        The most discoverable place to learn that gh is missing. Sending works
        without it, so this reads as information rather than as a failure — the
        card only turns loud for a dependency that is actually required.
      */}
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

      <View style={styles.card}>
        <View style={{ ...styles.row, justifyContent: "space-between" }}>
          <Text style={styles.heading}>Recent sends</Text>
          {recent.length === 0 ? null : (
            <Button
              label="Clear"
              styles={styles}
              onPress={() => {
                void clearRecent({}).then(invalidate);
              }}
            />
          )}
        </View>
        {recent.length === 0 ? (
          <Text style={styles.muted}>Nothing sent yet.</Text>
        ) : (
          recent.map((send) => (
            <RecentSendRow
              key={send.id}
              send={send}
              styles={styles}
              onOpen={
                navigation === undefined
                  ? null
                  : (agentId) => navigation.openAgent({ agentId })
              }
            />
          ))
        )}
      </View>
    </ScrollView>
  );
}
