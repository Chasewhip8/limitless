{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.limitless;
  service = cfg.opencode.service;
  enabled = cfg.enable && service.enable;
  opencodeDir = "opencode";
  launcher = pkgs.writeShellApplication {
    name = "limitless-opencode-service";
    text = ''
      exec ${pkgs.nodejs}/bin/node ${../packages/opencode-service.mjs} ${
        lib.escapeShellArgs [
          "${cfg._generated.opencodePackage}/bin/opencode"
          service.hostname
          (toString service.port)
        ]
      }
    '';
  };
  executor = cfg.mcp.executor;
  executorWaitSeconds = 60;
  # Tailnet DNS and Executor can lag user-service startup; OpenCode does not retry failed MCP connections.
  awaitExecutor = pkgs.writeShellApplication {
    name = "limitless-await-executor";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.curl
    ];
    text = ''
      url=${lib.escapeShellArg executor.url}
      deadline=$((SECONDS + ${toString executorWaitSeconds}))
      while [ "$SECONDS" -lt "$deadline" ]; do
        status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 3 "$url" || true)
        if [ "$status" -ge 200 ] && [ "$status" -lt 500 ]; then
          exit 0
        fi
        sleep 1
      done
      echo "Executor at $url was not ready within ${toString executorWaitSeconds}s; starting OpenCode anyway." >&2
    '';
  };
in
{
  options.programs.limitless.opencode.service = {
    enable = lib.mkEnableOption "login startup and systemd user supervision of OpenCode's native service (Linux only)";
    hostname = lib.mkOption {
      type = lib.types.nonEmptyStr;
      default = "127.0.0.1";
      description = "Native service bind address. Keep loopback for a local Tailscale reverse proxy.";
    };
    port = lib.mkOption {
      type = lib.types.ints.between 1 65535;
      default = 49374;
      example = 4096;
      description = "Native service port, persisted before the supervised server starts.";
    };
  };

  config = lib.mkMerge [
    {
      assertions = [
        {
          assertion = !enabled || pkgs.stdenv.hostPlatform.isLinux;
          message = "programs.limitless.opencode.service requires Linux and a systemd user manager.";
        }
      ];
    }
    (lib.mkIf (enabled && pkgs.stdenv.hostPlatform.isLinux) {
      assertions = [
        {
          assertion = config.systemd.user.enable;
          message = "programs.limitless.opencode.service requires systemd.user.enable.";
        }
      ];
      warnings = lib.optional (!config.systemd.user.startServices) ''
        Limitless OpenCode service changes require systemd.user.startServices = true
        for automatic application during Home Manager switches.
      '';
      systemd.user.services.opencode = {
        Unit = {
          Description = "OpenCode native service";
          StartLimitIntervalSec = 0;
          X-Restart-Triggers = [
            config.xdg.configFile."${opencodeDir}/opencode.json".source
            config.xdg.configFile."${opencodeDir}/AGENTS.md".source
            config.xdg.configFile."${opencodeDir}/agents".source
          ]
          ++ lib.optional cfg.skills.enable config.xdg.configFile."${opencodeDir}/skills".source;
        };
        Service = {
          Type = "exec";
          ExecStart = lib.getExe launcher;
          Environment = [
            "HOME=${config.home.homeDirectory}"
            "PATH=/run/wrappers/bin:${config.home.profileDirectory}/bin:/run/current-system/sw/bin"
            "XDG_CONFIG_HOME=${config.xdg.configHome}"
            "XDG_DATA_HOME=${config.xdg.dataHome}"
            "XDG_STATE_HOME=${config.xdg.stateHome}"
            "XDG_CACHE_HOME=${config.xdg.cacheHome}"
          ];
          Restart = "always";
          RestartSec = "5s";
        }
        // lib.optionalAttrs executor.enable {
          ExecStartPre = lib.getExe awaitExecutor;
        };
        Install.WantedBy = [ "default.target" ];
      };
    })
  ];
}
