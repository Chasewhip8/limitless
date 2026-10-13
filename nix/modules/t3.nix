{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.limitless;
  inherit (cfg) t3;
  linux = pkgs.stdenv.hostPlatform.isLinux;
  enabled = cfg.enable && t3.enable && linux && t3.package != null;
  configure = pkgs.writeShellApplication {
    name = "limitless-t3-settings";
    text = ''
      exec ${lib.getExe pkgs.nodejs} ${../packages/t3-settings.mjs} ${
        lib.escapeShellArgs (
          [
            t3.baseDir
            "${config.home.profileDirectory}/bin/opencode-t3"
          ]
          ++ lib.optional (!t3.opencode.enable) "--no-opencode"
        )
      }
    '';
  };
  managedOpenCode = t3.opencode.enable && cfg.opencode.service.enable;
in
{
  options.programs.limitless.t3 = {
    enable = lib.mkEnableOption "the supervised headless T3 Code environment";
    package = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.t3 or null;
      defaultText = lib.literalExpression "the bundled T3 CLI on Linux; null otherwise";
      description = "T3 server package. Desktop GUI packaging is independent.";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 3773;
      description = "Loopback HTTP/WebSocket port for the headless T3 environment.";
    };
    baseDir = lib.mkOption {
      type = lib.types.addCheck lib.types.str (
        path:
        lib.hasPrefix "/" path
        && lib.strings.trim path == path
        && path != builtins.storeDir
        && !lib.hasPrefix "${builtins.storeDir}/" path
      );
      default = "${config.home.homeDirectory}/.t3";
      description = "Mutable T3 home. An existing home retains its threads and accounts. The desktop must use this home to receive its remote-only setting.";
    };
    opencode.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Manage the OpenCode provider binding to opencode-t3 before service startup. Disabling this leaves existing provider settings untouched.";
    };
  };

  config = lib.mkMerge [
    {
      assertions = [
        {
          assertion = !t3.enable || cfg.enable;
          message = "programs.limitless.t3.enable requires programs.limitless.enable.";
        }
        {
          assertion = !t3.enable || linux;
          message = "programs.limitless.t3 requires Linux and a systemd user manager.";
        }
        {
          assertion = !t3.enable || t3.package != null;
          message = "programs.limitless.t3 requires a T3 CLI package.";
        }
      ];
    }
    (lib.mkIf enabled {
      assertions = [
        {
          assertion = config.systemd.user.enable;
          message = "programs.limitless.t3 requires systemd.user.enable.";
        }
      ];
      home.packages = [ t3.package ];
      systemd.user.services.t3code = {
        Unit = {
          Description = "T3 Code headless environment";
          StartLimitIntervalSec = 0;
          # Rebuilds must not terminate conversations. Restart explicitly when idle.
          X-SwitchMethod = "keep-old";
        }
        // lib.optionalAttrs managedOpenCode {
          Wants = [ "opencode.service" ];
          After = [ "opencode.service" ];
        };
        Service = {
          Type = "exec";
          ExecStartPre = lib.getExe configure;
          ExecStart = lib.escapeShellArgs [
            (lib.getExe t3.package)
            "serve"
            "--host"
            "127.0.0.1"
            "--port"
            (toString t3.port)
            "--base-dir"
            t3.baseDir
          ];
          WorkingDirectory = config.home.homeDirectory;
          Environment = [
            "HOME=${config.home.homeDirectory}"
            "XDG_CONFIG_HOME=${config.xdg.configHome}"
            "XDG_DATA_HOME=${config.xdg.dataHome}"
            "XDG_STATE_HOME=${config.xdg.stateHome}"
            "XDG_CACHE_HOME=${config.xdg.cacheHome}"
            "PATH=/run/wrappers/bin:${config.home.profileDirectory}/bin:/run/current-system/sw/bin"
            "T3CODE_TAILSCALE_SERVE=false"
          ];
          Restart = "always";
          RestartSec = "5s";
        };
        Install.WantedBy = [ "default.target" ];
      };
    })
  ];
}
