# MPDControls

MPDControls is a Vencord userplugin for desktop clients, adapted from Vencord's [SpotifyControls](https://github.com/Vendicated/Vencord/tree/main/src/plugins/spotifyControls).

<img width="391" height="165" alt="image" src="https://github.com/user-attachments/assets/05d49493-b989-4158-a700-986c182bc23f" />

## Requirements

- Vencord running in a desktop client, either [built from source](https://docs.vencord.dev/installing/custom-plugins/).
- MPD listening on `127.0.0.1:6600` and permitting unauthenticated control access.

## Installation from Vencord source

1. Place this directory at `src/userplugins/mpdControls.desktop` in your Vencord source tree.
2. Rebuild Vencord and restart Discord.
3. Enable **MPDControls** in Vencord's Plugins settings.

## Installation with Nixcord

Add the plugin to your [Nixcord](https://github.com/4evy/nixcord#third-party-user-plugins) configuration and enable it:

```nix
programs.nixcord = {
  userPlugins."mpdControls.desktop" = "github:sarowish/mpdControls/<full-40-character-commit>";
  extraConfig.plugins.MPDControls.enable = true;
};
```

Replace `<full-40-character-commit>` with a commit from the repository, then rebuild your Home Manager or NixOS configuration and restart Discord. Nixcord requires remote user plugins to be pinned.

## Settings

- **Show controls on hover** hides the playback buttons until the player is hovered.
- **Restart currently playing track** makes the previous button seek to the start when more than three seconds have elapsed.
