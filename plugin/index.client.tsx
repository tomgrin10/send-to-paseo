import { contributeDisplay } from "./client/display";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeChat } from "./client/chat";
import { SendToPaseoSettings } from "./client/settings";
import { sidebarRow } from "./client/sidebar";

const TITLE = "Send to Paseo";

export default function contribute(client: PluginClientContext) {
  // `settings` is the id the screen had as a surface, so existing links and the
  // sidebar route keep resolving.
  const removeScreen = client.addScreen({ id: "settings", title: TITLE, Component: SendToPaseoSettings });
  const Row = sidebarRow(client, TITLE);
  const removeDisplay = contributeDisplay(client, {
    title: TITLE,
    register: () => client.addSidebarHeaderItem({ id: "send-to-paseo", title: TITLE, Component: Row }),
  });
  const removeChat = contributeChat(client);
  const removeCommand = client.addCommandCenterItem({
    id: "send-to-paseo-settings",
    title: "Send to Paseo: pairing and recent sends",
    icon: "Send",
    keywords: ["graphite", "github", "bridge", "token", "pair", "pull request", "extension", "chrome"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "settings" });
    },
  });
  return () => { removeScreen(); removeDisplay(); removeChat(); removeCommand(); };
}
