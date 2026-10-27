{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.limitless;
  inherit (cfg) paseo;
  linux = pkgs.stdenv.hostPlatform.isLinux;
  enabled = cfg.enable && paseo.enable && linux && paseo.package != null;
  configure = pkgs.writeShellApplication {
    name = "limitless-paseo-settings";
    text = ''
      exec ${lib.getExe pkgs.nodejs} ${../packages/paseo-settings.mjs} ${
        lib.escapeShellArgs [
          paseo.home
          "127.0.0.1:${toString paseo.port}"
          "${config.home.profileDirectory}/bin/opencode-paseo"
          (lib.boolToString paseo.browserTools)
        ]
      }
    '';
  };
in
{
  options.programs.limitless.paseo = {
    enable = lib.mkEnableOption "the supervised Paseo daemon, connected to the managed OpenCode service through opencode-paseo";
    package = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.paseo or null;
      defaultText = lib.literalExpression "the pinned Paseo daemon on Linux; null otherwise";
      description = "Paseo daemon and CLI package. The desktop app is packaged separately as paseo-desktop.";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 6767;
      description = "Loopback port for the Paseo daemon. Paseo's relay stays disabled.";
    };
    hostnames = lib.mkOption {
      type = lib.types.listOf (
        lib.types.addCheck (lib.types.strMatching "\\.?[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?") (
          name: lib.toLower name != "true"
        )
      );
      default = [ ];
      example = [ "pc.example.ts.net" ];
      description = ''
        Additional HTTP/WebSocket hostnames accepted through PASEO_HOSTNAMES.
        Use bare names without a scheme, port or trailing dot; a leading dot
        also permits subdomains. Paseo merges these with its persisted allowlist
        and always allows localhost and IP addresses. This is not authentication:
        set a private daemon password before publishing a proxy. Changes take
        effect when the managed Paseo service is restarted.
      '';
    };
    home = lib.mkOption {
      type = lib.types.addCheck lib.types.str (
        path:
        lib.hasPrefix "/" path
        && lib.strings.trim path == path
        && path != builtins.storeDir
        && !lib.hasPrefix "${builtins.storeDir}/" path
      );
      default = "${config.home.homeDirectory}/.paseo";
      description = "Mutable Paseo home (PASEO_HOME). The desktop app must use the same home to attach to this daemon.";
    };
    browserTools = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Offer Paseo's browser tools to agents. They need a connected Paseo desktop app.";
    };
  };

  config = lib.mkMerge [
    {
      assertions = [
        {
          assertion = !paseo.enable || cfg.enable;
          message = "programs.limitless.paseo.enable requires programs.limitless.enable.";
        }
        {
          assertion = !paseo.enable || linux;
          message = "programs.limitless.paseo requires Linux and a systemd user manager.";
        }
        {
          assertion = !paseo.enable || paseo.package != null;
          message = "programs.limitless.paseo requires a Paseo package.";
        }
        {
          assertion = !paseo.enable || cfg.opencode.service.enable;
          message = "programs.limitless.paseo requires programs.limitless.opencode.service.enable: opencode-paseo connects Paseo to the managed OpenCode service.";
        }
      ];
    }
    (lib.mkIf enabled {
      assertions = [
        {
          assertion = config.systemd.user.enable;
          message = "programs.limitless.paseo requires systemd.user.enable.";
        }
      ];
      home.packages = [ paseo.package ];
      systemd.user.services.paseo = {
        Unit = {
          Description = "Paseo daemon";
          StartLimitIntervalSec = 0;
          # Rebuilds must not terminate agents. Restart explicitly when idle.
          X-SwitchMethod = "keep-old";
          Wants = [ "opencode.service" ];
          After = [ "opencode.service" ];
        };
        Service = {
          Type = "exec";
          ExecStartPre = lib.getExe configure;
          ExecStart = lib.getExe' paseo.package "paseo-server";
          WorkingDirectory = config.home.homeDirectory;
          # Paseo's terminals and workspace scripts run in this environment; it
          # matches the OpenCode service's.
          Environment = [
            "HOME=${config.home.homeDirectory}"
            "PATH=/run/wrappers/bin:${config.home.profileDirectory}/bin:/run/current-system/sw/bin"
            "XDG_CONFIG_HOME=${config.xdg.configHome}"
            "XDG_DATA_HOME=${config.xdg.dataHome}"
            "XDG_STATE_HOME=${config.xdg.stateHome}"
            "XDG_CACHE_HOME=${config.xdg.cacheHome}"
            "PASEO_HOME=${paseo.home}"
          ]
          ++ lib.optional (
            paseo.hostnames != [ ]
          ) "PASEO_HOSTNAMES=${lib.concatStringsSep "," paseo.hostnames}";
          Restart = "always";
          RestartSec = "5s";
          TimeoutStopSec = "15s";
        };
        Install.WantedBy = [ "default.target" ];
      };
    })
  ];
}
