{
  pkgs,
  nixpkgs,
  module,
}:
let
  inherit (pkgs) lib;
  evaluate =
    settings:
    (nixpkgs.lib.nixosSystem {
      system = pkgs.stdenv.hostPlatform.system;
      modules = [
        module
        {
          boot.isContainer = true;
          system.stateVersion = "26.11";
          services.limitless.executor = settings;
        }
      ];
    }).config;
  disabled = evaluate { };
  enabled = evaluate {
    enable = true;
    origin = "https://athena.example.ts.net:9443";
  };
  bootstrap = evaluate {
    enable = true;
    origin = "http://localhost:4400";
  };
  container = enabled.virtualisation.oci-containers.containers.limitless-executor;
  valid = config: lib.all (entry: entry.assertion) config.assertions;
in
assert lib.assertMsg (
  valid enabled && valid bootstrap && valid disabled
) "Executor service configurations must be valid";
assert lib.assertMsg (
  !disabled.virtualisation.podman.enable
  && disabled.virtualisation.oci-containers.containers == { }
  && !(disabled.users.users ? limitless-executor)
) "Importing the disabled Executor module must not activate infrastructure";
assert lib.assertMsg (
  enabled.virtualisation.oci-containers.backend == "podman"
  && container.ports == [ "127.0.0.1:4400:4400" ]
  && builtins.match ".*@sha256:[0-9a-f]{64}" container.image != null
  && container.user == "1000:1000"
  && container.podman.sdnotify == "healthy"
  && lib.all (flag: builtins.elem flag container.extraOptions) [
    "--network=bridge"
    "--subuidname=limitless-executor"
    "--subgidname=limitless-executor"
    "--cap-drop=ALL"
    "--security-opt=no-new-privileges"
    "--read-only"
    "--pids-limit=256"
    "--memory=2048m"
  ]
  && enabled.users.users.limitless-executor.autoSubUidGidRange
  && enabled.systemd.services.podman-limitless-executor.serviceConfig.TimeoutStartSec == 900
  && enabled.networking.firewall.allowedTCPPorts == [ ]
) "Executor must be digest-pinned, loopback-only, resource-bounded and isolated from host UID 1000";
assert lib.assertMsg
  (
    container.volumes == [
      "/var/lib/limitless-executor/product:/app/data:U"
      "/var/lib/limitless-executor/collector:/app/motel-data:U"
    ]
    && builtins.elem "d /var/lib/limitless-executor 0700 root root -" enabled.systemd.tmpfiles.rules
    && builtins.elem "d /var/lib/limitless-executor/product 0700 - - -" enabled.systemd.tmpfiles.rules
    && container.environment.BETTER_AUTH_URL == "https://athena.example.ts.net:9443"
    && container.environment.EXECUTOR_CATALOG_URL == "https://catalog.executor.sh/index.json"
    &&
      bootstrap.virtualisation.oci-containers.containers.limitless-executor.environment.BETTER_AUTH_URL
      == "http://localhost:4400"
    && container.environment.EXECUTOR_APPS_ALLOW_PRIVATE_FETCH == "false"
    && container.environment.EXECUTOR_APP_WORKERS == "4"
    && container.environment.DO_NOT_TRACK == "1"
    && container.environmentFiles == [ ]
  )
  "Executor must persist private state without baking credentials into configuration or resetting shifted ownership";
pkgs.runCommand "executor-service-check" { } ''
  touch "$out"
''
