import { defineSettings, settingsRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const displayPreferences = defineSettings({
  id: "display",
  scope: "host",
  version: 1,
  schema: z.object({ showSidebar: z.boolean().default(true) }),
});

export const displayRpc = settingsRpc(displayPreferences.id);

/** Plain contract keeps clients on older SDKs compatible. */
export const displayFeed = {
  name: "send-to-paseo.display-feed",
  input: z.object({}),
  event: z.object({ status: z.string(), revision: z.string().optional(), values: z.unknown().optional(), error: z.string().optional() }),
};
