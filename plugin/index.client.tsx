import { contributeDisplay } from "./client/display";
import { withNavigation } from "./client/navigation";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SendToPaseoSettings } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  client.addSurface("settings", withNavigation(SendToPaseoSettings, client, "settings"));
  const removeDisplay = contributeDisplay(client, {
    id: "send-to-paseo",
    title: "Send to Paseo",
    icon: "Send",
    surface: "settings",
  });
  client.addCommandCenterItem({
    id: "send-to-paseo-settings",
    title: "Send to Paseo: bridge settings",
    icon: "Send",
    keywords: ["graphite", "bridge", "token", "pull request", "extension"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("settings");
    },
  });
  return () => { removeDisplay(); };
}
