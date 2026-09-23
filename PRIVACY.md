# Send to Paseo privacy policy

Effective date: September 23, 2026

Send to Paseo is a developer tool that lets a user send an instruction from a GitHub or Graphite
pull-request page to a Paseo agent that the user controls.

## Data the extension handles

The extension handles only the information needed to provide that workflow:

- the repository owner, repository name, pull-request number, and related pull-request identifiers
  read from the GitHub or Graphite page the user is viewing;
- instructions the user types into the Send to Paseo composer;
- Paseo bridge addresses and pairing tokens supplied by the user;
- extension preferences, agent-target choices, and limited recent-send state.

## How data is used and shared

Pull-request context and the user's instruction are sent only when needed to resolve a destination
or when the user chooses **Send**. They go directly to the Paseo bridge or bridges configured by the
user. A configured bridge may in turn use the user's own Paseo and GitHub connections to resolve a
workspace and dispatch the instruction.

The extension does not send this data to the extension developer. It contains no advertising,
analytics, tracking, or telemetry, and it does not sell personal information. Data is not used for
creditworthiness, lending, or purposes unrelated to the extension's single purpose.

## Storage and retention

Settings, pairing tokens, preferences, and recent-send state are stored locally using Chrome
extension storage. The extension developer does not operate a server that stores them. Users can
remove locally stored data by clearing the extension's storage or uninstalling the extension.
Information received by a user-configured Paseo installation is governed by that installation and
the services the user has connected to it.

## Permissions

The extension runs only on supported GitHub and Graphite pull-request pages. It uses local storage
for settings and credentials, connects by default to the local Send to Paseo bridge at
`127.0.0.1:7788`, and requests an exact additional origin only when the user explicitly configures
another bridge. Optional origin access is not granted until the user approves Chrome's prompt.

## Security

Pairing tokens remain in the extension service worker's storage and are not inserted into page
content. Bridge requests are authenticated, and the extension refuses insecure non-loopback remote
bridge addresses.

## Changes and contact

Material changes to this policy will be published in this repository with an updated effective
date. Questions and privacy requests can be filed at
<https://github.com/tomgrin10/send-to-paseo/issues>.
