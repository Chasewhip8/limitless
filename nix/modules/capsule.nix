{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.limitless.capsule;
  linux = pkgs.stdenv.hostPlatform.isLinux;
  enabled = cfg.enable && linux && cfg.package != null;
  runtimePath = lib.types.addCheck lib.types.str (
    path:
    lib.hasPrefix "/" path
    && path != "/"
    && path != builtins.storeDir
    && !lib.hasPrefix "${builtins.storeDir}/" path
    && lib.strings.trim path == path
  );
  github =
    lib.optionalAttrs (cfg.github.tokenFile != null) { inherit (cfg.github) tokenFile; }
    // lib.optionalAttrs (cfg.github.tokenEnv != null) { inherit (cfg.github) tokenEnv; };
  settings = {
    inherit (cfg) root checkoutRoot controlDirectory;
    runtime = cfg.package.runtime;
    credentials = {
      inherit github;
    }
    // lib.optionalAttrs (cfg.identity != null) { inherit (cfg) identity; };
  }
  // lib.optionalAttrs (cfg.dockerSocket != null) { inherit (cfg) dockerSocket; };
in
{
  options.programs.limitless = {
    capsule = {
      enable = lib.mkEnableOption "Capsule workspaces in the shared native OpenCode server";
      package = lib.mkOption {
        type = lib.types.nullOr lib.types.package;
        default = self.packages.${pkgs.stdenv.hostPlatform.system}.capsule or null;
        defaultText = lib.literalExpression "the Capsule package on Linux; null otherwise";
        description = "Capsule CLI and pinned runtime used by the native workspace provider.";
      };
      root = lib.mkOption {
        type = runtimePath;
        default = "${config.xdg.stateHome}/capsule/runtime";
        description = "Dedicated runtime-state root on this host. Keep it stable for retained workspaces and separate from checkout and control directories.";
      };
      checkoutRoot = lib.mkOption {
        type = runtimePath;
        default = "${config.xdg.dataHome}/capsule/checkouts";
        description = "Dedicated root for retained full clones. Runtime purge never removes these checkouts.";
      };
      controlDirectory = lib.mkOption {
        type = runtimePath;
        default = "${config.xdg.stateHome}/capsule/control";
        description = "Host-only OpenCode Location where the Capsule management RPC is registered. Enroll this exact path with Pipeline; never use a task checkout.";
      };
      github = {
        tokenFile = lib.mkOption {
          type = lib.types.nullOr runtimePath;
          default = null;
          description = "Runtime GitHub token file, reread for each authenticated command. Only the path enters Nix configuration. Mutually exclusive with tokenEnv.";
        };
        tokenEnv = lib.mkOption {
          type = lib.types.nullOr (lib.types.strMatching "[A-Za-z_][A-Za-z0-9_]*");
          default = null;
          description = "Host environment variable holding the GitHub token. With neither source configured, use GH_TOKEN then GITHUB_TOKEN. Environment resolution receives no injected credentials.";
        };
      };
      identity = lib.mkOption {
        type = lib.types.nullOr (
          lib.types.submodule {
            options = {
              name = lib.mkOption {
                type = lib.types.nonEmptyStr;
                description = "Git author and committer name for Capsule commands.";
              };
              email = lib.mkOption {
                type = lib.types.nonEmptyStr;
                description = "Git author and committer email for Capsule commands.";
              };
            };
          }
        );
        default = null;
        description = "Optional host-owned Git identity, injected when commands execute.";
      };
      dockerSocket = lib.mkOption {
        type = lib.types.nullOr runtimePath;
        default = null;
        description = "Existing host Docker Unix socket exposed to these workspaces. The daemon and its authority remain shared.";
      };
    };
    _generated.capsuleHostConfig = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      internal = true;
      readOnly = true;
      description = "Non-secret native Capsule host configuration.";
    };
  };

  config = lib.mkMerge [
    {
      programs.limitless._generated.capsuleHostConfig =
        if enabled then config.xdg.configFile."capsule/host.json".source else null;
      assertions = [
        {
          assertion = !cfg.enable || linux;
          message = "programs.limitless.capsule requires Linux.";
        }
        {
          assertion = !cfg.enable || config.programs.limitless.enable;
          message = "Capsule native-host integration requires programs.limitless.enable.";
        }
        {
          assertion = !cfg.enable || cfg.package != null;
          message = "programs.limitless.capsule requires a Capsule runtime package.";
        }
        {
          assertion = cfg.github.tokenFile == null || cfg.github.tokenEnv == null;
          message = "Configure one Capsule GitHub token source: tokenFile or tokenEnv.";
        }
      ];
    }
    (lib.mkIf enabled {
      home.packages = [ cfg.package ];
      xdg.configFile."capsule/host.json".text = builtins.toJSON settings;
    })
  ];
}
