# Chrome Web Store submission

Submission values for **Send to Paseo 1.4.0**.

Store item: [Send to Paseo](https://chromewebstore.google.com/detail/send-to-paseo/blflbbgkckbabbkoigpocilbkkmfijfg).
Future package uploads and review submission use the [automated release pipeline](AUTOMATION.md)
after the one-time Google account setup.

## Listing

- Visibility: **Unlisted**
- Language: **English (United States)**
- Category: **Developer Tools**
- Homepage: <https://github.com/tomgrin10/send-to-paseo>
- Support: <https://github.com/tomgrin10/send-to-paseo/issues>
- Privacy policy: <https://github.com/tomgrin10/send-to-paseo/blob/main/PRIVACY.md>

Short description:

> Send instructions from GitHub and Graphite pull requests to new or existing agents in your Paseo workspaces.

Detailed description (paste into the dashboard's Description field):

> Turn a pull request into a task for your AI coding agent.
>
> Send to Paseo adds a button to GitHub and Graphite pull requests. Ask an agent to fix failing
> tests, address review feedback, or explain a change, then send your instruction with the
> pull-request context to the right project in Paseo.
>
> New to Paseo? It's an open-source app for running and managing AI coding agents such as
> Claude Code and Codex. Learn more and download it at https://paseo.sh.
>
> Source code and full installation guide: https://github.com/tomgrin10/send-to-paseo
>
> WHAT YOU CAN DO
>
> • Start a new agent or continue working with an existing agent.
> • Use an existing project workspace or create a separate checkout for the pull request.
> • Choose the model and permission mode when starting a new agent.
> • Work with stacked pull requests on Graphite.
> • Send work to your laptop or another Paseo machine you've connected.
>
> You choose the destination and review your instruction before pressing Send.
>
> GET STARTED
>
> This extension requires Paseo 0.9.0 or newer, the Send to Paseo plugin, and git on the
> computer running Chrome.
>
> 1. Install Paseo from https://paseo.sh and enable plugins in Settings → Plugins.
> 2. In a terminal, run: paseo plugin install npm:send-to-paseo
> 3. In Paseo, open Send to Paseo and copy the pairing token. Open the extension from Chrome's
>    Extensions menu, paste the token, and click Test connection.
>
> Then open a GitHub or Graphite pull request and click Send to Paseo.
>
> PRIVACY
>
> No ads, analytics, or telemetry. Pairing credentials stay in Chrome extension storage, and
> requests go directly to the Paseo bridges you configure.

The detailed description can be updated in the Chrome Web Store dashboard. The upload API does
not update listing text. The short summary shown on the store comes from the packaged manifest;
changing it requires a new extension package.

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
  no remote origin is granted by default. Chrome notes that this broad declaration can lengthen
  review; it supports Advanced direct connections to user-chosen HTTPS hosts.
- GitHub and Graphite content scripts: add the Send to Paseo action to pull-request pages, read the
  PR identity needed for resolution, and survive each site's client-side navigation.

The extension executes no remotely hosted code.

## Privacy practices data usage

Disclose the categories the extension actually handles, even when data is stored locally or sent
only to the user's own bridge:

- **Personally identifiable information:** a repository owner can be a person's username.
- **Authentication information:** the plugin-generated bearer pairing token is a credential for
  the user's bridge, even though it is not a Google or GitHub password.
- **Personal communications:** the instruction written to a Paseo agent.
- **Web history:** the current pull-request page URL is sent on **Send**. The extension does not
  read the browser's history of other pages.
- **Website content:** PR identity and Graphite stack links read from the current PR page.

The extension does not handle health, financial, location, or user-activity monitoring data. The
three limited-use certifications match `PRIVACY.md`: no sale or unrelated transfer, no unrelated
purpose, and no creditworthiness or lending use.

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
- Store icon: `docs/chrome-web-store/icon-128.png`
- Screenshots: `docs/chrome-web-store/github-pr-1280x800.png` and
  `docs/chrome-web-store/graphite-pr-1280x800.png`. Both show the composer on actual PR pages;
  local machine names and a reviewer's name and avatar are obscured.
- Small promotional tile: `docs/chrome-web-store/small-promo-440x280.png` (440×280)
