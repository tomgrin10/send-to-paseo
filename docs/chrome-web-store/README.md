# Chrome Web Store submission

Submission values for **Send to Paseo 1.4.0**.

## Listing

- Visibility: **Unlisted**
- Language: **English (United States)**
- Category: **Developer Tools**
- Homepage: <https://github.com/tomgrin10/send-to-paseo>
- Support: <https://github.com/tomgrin10/send-to-paseo/issues>
- Privacy policy: <https://github.com/tomgrin10/send-to-paseo/blob/main/PRIVACY.md>

Short description:

> Send instructions from GitHub and Graphite pull requests to new or existing agents in your Paseo workspaces.

Detailed description:

> Send to Paseo adds a focused action to GitHub and Graphite pull-request pages. From the PR, write
> an instruction, choose the resolved Paseo workspace, and either start a new agent or dispatch to
> that workspace's main agent.
>
> The extension discovers configured Paseo machines through your primary Send to Paseo plugin,
> resolves likely workspaces before you open the composer, and keeps provider and permission-mode
> choices scoped to the selected machine.
>
> Requires Paseo 0.9.0 or newer and the open-source `send-to-paseo` Paseo plugin. The extension has
> no advertising, analytics, or telemetry. Pairing credentials stay in Chrome extension storage,
> and requests go directly to bridges configured by the user.

## Single purpose

Send a user-written instruction and pull-request context from a supported GitHub or Graphite PR
page to an agent in a user-controlled Paseo workspace.

## Permission justifications

- `storage`: stores user-configured bridge addresses and pairing tokens, UI preferences, and
  limited recent-send state locally in Chrome extension storage.
- `http://127.0.0.1:7788/*`: communicates with the default loopback-only Send to Paseo bridge.
- Optional `http://127.0.0.1/*` and `http://localhost/*`: supports a loopback bridge forwarded to a
  user-selected local port. Chrome prompts before the optional origin is granted.
- Optional `https://*/*`: permits Chrome to grant one exact HTTPS origin selected by the user for
  an additional private Paseo bridge. The extension requests only that exact origin at runtime;
  no remote origin is granted by default.
- GitHub and Graphite content scripts: add the Send to Paseo action to pull-request pages, read the
  PR identity needed for resolution, and survive each site's client-side navigation.

The extension executes no remotely hosted code.

## Reviewer instructions

1. Install Paseo 0.9.0 or newer.
2. Run `paseo plugin install npm:send-to-paseo`.
3. In Paseo, open **Send to Paseo** and copy its pairing token.
4. Open the extension's options page, paste the token, and confirm the paired state.
5. Visit a GitHub pull request, open **Send to Paseo**, and observe the pre-resolved target list.
6. Enter an instruction and choose either **New agent** or the existing main agent. Sending starts
   or dispatches to the selected agent in the user's Paseo workspace.

No developer-operated test account is required. The extension communicates with the reviewer's
local Paseo installation.

## Assets

- Package: the `send-to-paseo-extension.zip` asset attached to GitHub release `v1.4.0`
- Store icon: `extension/dist/icons/icon-128.png`
- Screenshot: `docs/screenshots/options-page-paired.png` (1280×800)
- Small promotional tile: `docs/chrome-web-store/small-promo-440x280.png` (440×280)
