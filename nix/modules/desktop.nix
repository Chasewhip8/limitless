{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.limitless;
  packages = self.packages.${pkgs.stdenv.hostPlatform.system} or { };
  clients = [
    "opencode"
    "t3"
    "paseo"
  ];
  desktopOptions = name: {
    enable = lib.mkEnableOption "the ${name} desktop client, independently of the Limitless workspace and services";
    package = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = packages."${name}-desktop" or null;
      defaultText = lib.literalExpression "the pinned ${name} desktop on x86_64 Linux; null otherwise";
      description = "Desktop application package. On macOS use the Limitless nix-darwin module instead.";
    };
  };
  enabled = builtins.filter (name: cfg.${name}.desktop.enable) clients;
  opencodeDesktop = cfg.opencode.desktop;
in
{
  options.programs.limitless = lib.genAttrs clients (name: {
    desktop = desktopOptions name;
  });

  config = {
    assertions =
      map (name: {
        assertion = cfg.${name}.desktop.package != null;
        message = "programs.limitless.${name}.desktop requires a package. Bundled desktops support x86_64-linux; on macOS use limitless.darwinModules.default in your nix-darwin configuration.";
      }) enabled
      ++ [
        {
          assertion =
            !opencodeDesktop.enable
            || !cfg.enable
            || opencodeDesktop.package == null
            || lib.getVersion opencodeDesktop.package == lib.getVersion cfg.opencode.package;
          message = "OpenCode Desktop and the Limitless OpenCode CLI must have the same version: Desktop can replace a running local service on version mismatch.";
        }
      ];
    warnings =
      lib.optional (opencodeDesktop.enable && cfg.enable && !cfg.opencode.service.enable)
        "OpenCode Desktop may start its bundled CLI before the Limitless CLI. Enable opencode.service.enable for supervised operation; the bundled CLI does not use the Limitless launcher environment.";
    home.packages = builtins.filter (package: package != null) (
      map (name: cfg.${name}.desktop.package) enabled
    );
  };
}
