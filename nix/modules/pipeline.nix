{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.limitless.pipeline;
  linux = pkgs.stdenv.hostPlatform.isLinux;
  absolutePath = lib.types.addCheck lib.types.str (
    path: lib.hasPrefix "/" path && path != "/" && lib.strings.trim path == path
  );
  runtimePath = lib.types.addCheck absolutePath (
    path: path != builtins.storeDir && !lib.hasPrefix "${builtins.storeDir}/" path
  );
  origin = lib.types.addCheck lib.types.str (
    url:
    builtins.match "https://([A-Za-z0-9][A-Za-z0-9.-]*|[[][0-9a-fA-F:]+[]])(:[0-9]+)?/?" url != null
    || builtins.match "http://(127\\.0\\.0\\.1|localhost|[[]::1[]])(:[0-9]+)?/?" url != null
  );
  enabled = cfg.enable && linux && cfg.package != null;
  configFile = "pipeline/config.json";
  workerModule = lib.types.submodule {
    options = {
      id = lib.mkOption {
        type = lib.types.strMatching "[a-z0-9][a-z0-9-]*";
        description = "Stable, unique worker identifier persisted with task reservations.";
      };
      url = lib.mkOption {
        type = origin;
        description = "Native OpenCode service origin over HTTPS, without credentials, path, query, or fragment. Loopback HTTP is allowed for isolated tests.";
      };
      credentialFile = lib.mkOption {
        type = runtimePath;
        description = "Absolute runtime file containing the enrolled native OpenCode Basic password, not the password itself. Never use a Nix path literal or a store file.";
      };
      workspaceRoot = lib.mkOption {
        type = runtimePath;
        description = "Absolute Pipeline-owned workspace root on this worker. Must not contain unrelated checkouts.";
      };
      helperExecutable = lib.mkOption {
        type = absolutePath;
        default = "${config.home.profileDirectory}/bin/pipeline";
        defaultText = lib.literalExpression ''"\${config.home.profileDirectory}/bin/pipeline"'';
        description = "Absolute checkout-helper executable on the worker. Override when its profile differs from the coordinator's.";
      };
      system = lib.mkOption {
        type = lib.types.enum [
          "x86_64-linux"
          "aarch64-linux"
        ];
        example = "aarch64-linux";
        description = "Worker platform used for task placement. Declare the remote platform, not the coordinator's.";
      };
      capacity = lib.mkOption {
        type = lib.types.ints.positive;
        default = 1;
        description = "Advisory budget for Pipeline sessions and unresolved command deliveries. This is not an OS-process limit or a writer-exclusion guarantee.";
      };
      openCodeVersion = lib.mkOption {
        type = lib.types.nonEmptyStr;
        default = "2.2.7";
        description = "Expected native OpenCode version. Enroll and test this version before enabling the coordinator.";
      };
    };
  };
in
{
  options.programs.limitless.pipeline = {
    enable = lib.mkEnableOption "the standalone Pipeline coordinator (independent of programs.limitless.enable)";
    worker.enable = lib.mkEnableOption "the standalone Pipeline checkout helper, without another worker daemon";
    client = {
      enable = lib.mkEnableOption "Pipeline dispatch, resume, native observation, interrupt, and logical-close tools in the Limitless plugin";
      url = lib.mkOption {
        type = lib.types.nullOr origin;
        default = null;
        description = "Fixed Pipeline coordinator HTTPS origin. Loopback HTTP is allowed for isolated tests. Required when client tools are enabled.";
      };
      tokenFile = lib.mkOption {
        type = runtimePath;
        default = "${config.xdg.configHome}/pipeline/api-token";
        description = "Absolute runtime string path to the separate Pipeline API token. Only the path enters plugin configuration; never supply a store file or Nix path literal.";
      };
    };
    package = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.pipeline or null;
      defaultText = lib.literalExpression "the bundled Pipeline CLI on Linux; null otherwise";
      description = "Standalone Pipeline dispatcher and checkout-helper executable.";
    };
    settings = lib.mkOption {
      default = { };
      description = "Non-secret coordinator JSON settings. Credentials are read only from runtime files.";
      type = lib.types.submodule {
        options = {
          host = lib.mkOption {
            type = lib.types.enum [
              "127.0.0.1"
              "::1"
              "localhost"
            ];
            default = "127.0.0.1";
            description = "Coordinator bind address. Keep loopback behind host-managed authenticated HTTPS routing.";
          };
          port = lib.mkOption {
            type = lib.types.port;
            default = 4848;
            description = "Coordinator HTTP port. No Tailscale or firewall configuration is managed here.";
          };
          database = lib.mkOption {
            type = runtimePath;
            default = "${config.xdg.stateHome}/pipeline/pipeline.sqlite";
            description = "Absolute SQLite database file. Provision the parent directory when overriding the default state directory.";
          };
          apiTokenFile = lib.mkOption {
            type = runtimePath;
            default = "${config.xdg.configHome}/pipeline/api-token";
            description = "Absolute runtime file containing the required API bearer token. The module never generates, copies, or stores the token.";
          };
          githubTokenFile = lib.mkOption {
            type = lib.types.nullOr runtimePath;
            default = null;
            description = "Optional absolute runtime GitHub token file for PR metadata. Private checkout access also requires separately provisioned worker Git authentication.";
          };
          pollIntervalMs = lib.mkOption {
            type = lib.types.ints.positive;
            default = 60000;
            description = "Periodic safety reconciliation interval in milliseconds. Local transitions, worker events, and deadlines also wake reconciliation; agent waiters use event streams.";
          };
          queueTimeoutMs = lib.mkOption {
            type = lib.types.ints.positive;
            default = 3600000;
            description = "Maximum queue wait in milliseconds for a command that has not been sent. Expiry never clears an unconfirmed native delivery.";
          };
          workers = lib.mkOption {
            type = lib.types.listOf workerModule;
            default = [ ];
            description = "Explicitly enrolled worker origins, credential paths, platforms, and workspace roots.";
          };
        };
      };
    };
  };

  config = lib.mkMerge [
    {
      assertions = [
        {
          assertion = !(cfg.enable || cfg.worker.enable) || linux;
          message = "programs.limitless.pipeline requires Linux.";
        }
        {
          assertion = !(cfg.enable || cfg.worker.enable) || cfg.package != null;
          message = "programs.limitless.pipeline requires a Pipeline CLI package.";
        }
        {
          assertion = !cfg.client.enable || (config.programs.limitless.enable or false);
          message = "Pipeline caller tools require programs.limitless.enable; the dispatcher and checkout helper are independent.";
        }
        {
          assertion = !cfg.client.enable || cfg.client.url != null;
          message = "programs.limitless.pipeline.client.url is required when client tools are enabled.";
        }
      ];
    }
    (lib.mkIf ((enabled || cfg.worker.enable) && linux && cfg.package != null) {
      home.packages = [ cfg.package ];
    })
    (lib.mkIf enabled {
      assertions = [
        {
          assertion = config.systemd.user.enable;
          message = "programs.limitless.pipeline.enable requires systemd.user.enable.";
        }
        {
          assertion = cfg.settings.workers != [ ];
          message = "programs.limitless.pipeline.enable requires at least one enrolled worker.";
        }
        {
          assertion =
            lib.length (lib.unique (map (worker: worker.id) cfg.settings.workers))
            == lib.length cfg.settings.workers;
          message = "programs.limitless.pipeline.settings.workers must have unique ids.";
        }
      ];
      warnings = lib.optional (!config.systemd.user.startServices) ''
        Pipeline service changes require systemd.user.startServices = true
        for automatic application during Home Manager switches.
      '';
      xdg.configFile.${configFile}.text = builtins.toJSON cfg.settings;
      systemd.user.services.pipeline = {
        Unit = {
          Description = "Pipeline task coordinator";
          After = [ "network.target" ];
          StartLimitIntervalSec = 0;
          X-Restart-Triggers = [ config.xdg.configFile.${configFile}.source ];
        };
        Service = {
          Type = "exec";
          ExecStart = lib.escapeShellArgs [
            (lib.getExe cfg.package)
            "serve"
            "--config"
            "${config.xdg.configHome}/${configFile}"
          ];
          WorkingDirectory = config.home.homeDirectory;
          Environment = [
            "HOME=${config.home.homeDirectory}"
            "XDG_CONFIG_HOME=${config.xdg.configHome}"
            "XDG_STATE_HOME=${config.xdg.stateHome}"
            "XDG_DATA_HOME=${config.xdg.dataHome}"
            "XDG_CACHE_HOME=${config.xdg.cacheHome}"
          ];
          StateDirectory = "pipeline";
          StateDirectoryMode = "0700";
          RuntimeDirectory = "pipeline";
          RuntimeDirectoryMode = "0700";
          UMask = "0077";
          KillSignal = "SIGTERM";
          KillMode = "control-group";
          TimeoutStopSec = 45;
          # Effect 4 reports external interruption as exit 130 after scoped teardown.
          SuccessExitStatus = [ 130 ];
          Restart = "on-failure";
          RestartSec = "5s";
        };
        Install.WantedBy = [ "default.target" ];
      };
    })
  ];
}
