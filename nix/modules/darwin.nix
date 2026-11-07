{ config, lib, ... }:
let
  cfg = config.programs.limitless;
  enabled = cfg.opencode.desktop.enable || cfg.t3.desktop.enable;
  # Both casks declare auto_updates, which `brew bundle --upgrade` skips unless
  # greedy. Their in-app updaters do not cross release channels, so an old
  # alpha install would otherwise stay on alpha.
  greedyCask = name: {
    inherit name;
    greedy = true;
  };
in
{
  options.programs.limitless = {
    opencode.desktop.enable = lib.mkEnableOption "OpenCode Desktop through the native Homebrew cask";
    t3.desktop.enable = lib.mkEnableOption "stable T3 Code Desktop through the native Homebrew cask";
  };

  config = lib.mkIf enabled {
    assertions = [
      {
        assertion = config.homebrew.enable;
        message = "Limitless desktop clients on macOS require homebrew.enable.";
      }
    ];
    homebrew = {
      enable = lib.mkDefault true;
      casks =
        lib.optional cfg.opencode.desktop.enable (greedyCask "opencode-desktop")
        ++ lib.optional cfg.t3.desktop.enable (greedyCask "t3-code");
    };
  };
}
