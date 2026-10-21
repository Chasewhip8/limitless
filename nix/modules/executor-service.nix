# Credential-owning Executor service. Clients never receive its upstream grants.
{ config, lib, ... }:
let
  cfg = config.services.limitless.executor;
  stateDirectory = "/var/lib/limitless-executor";
in
{
  options.services.limitless.executor = {
    enable = lib.mkEnableOption "the self-hosted Executor MCP gateway";
    origin = lib.mkOption {
      type = lib.types.strMatching "(https://[A-Za-z0-9.-]+(:[0-9]+)?|http://localhost:[0-9]+)";
      description = "Browser-visible origin without a trailing slash. Use localhost only during SSH-forwarded owner setup.";
      example = "https://athena.example.ts.net:9443";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 4400;
      description = "Loopback host port; HTTPS routing is owned by the consuming configuration.";
    };
    image = lib.mkOption {
      type = lib.types.strMatching "[^[:space:]@]+@sha256:[0-9a-f]{64}";
      # Published 2.0.0-beta.25, linux/amd64 and linux/arm64 manifest index.
      default = "ghcr.io/usefulsoftwareco/executor-selfhost@sha256:5cb26b28e482a9b289e8e075648d42b443d29c5be6d09efe74566ef4ad7a48e9";
      description = "Official self-host image pinned by digest. Back up stopped state before changing versions.";
    };
    memoryLimitMiB = lib.mkOption {
      type = lib.types.ints.positive;
      default = 2048;
      description = "Container memory budget, including the app runtime and collector.";
    };
    workerLimit = lib.mkOption {
      type = lib.types.ints.positive;
      default = 4;
      description = "Idle app-worker residency budget; not a concurrency or security limit.";
    };
  };

  config = lib.mkIf cfg.enable {
    # A dedicated mapping keeps container UID 1000 distinct from agent UID 1000.
    # This account allocates IDs; it does not run Podman or need a home/linger.
    users.users.limitless-executor = {
      isSystemUser = true;
      group = "limitless-executor";
      autoSubUidGidRange = true;
    };
    users.groups.limitless-executor = { };

    systemd.tmpfiles.rules = [
      "d ${stateDirectory} 0700 root root -"
      # Keep Podman's shifted ownership on subsequent activations.
      "d ${stateDirectory}/product 0700 - - -"
      "d ${stateDirectory}/collector 0700 - - -"
    ];

    virtualisation = {
      podman.enable = true;
      oci-containers = {
        backend = "podman";
        containers.limitless-executor = {
          inherit (cfg) image;
          autoStart = true;
          podman.user = "root";
          user = "1000:1000";
          ports = [ "127.0.0.1:${toString cfg.port}:4400" ];
          # :U assigns the mapped container UID, not the agent's host UID.
          volumes = [
            "${stateDirectory}/product:/app/data:U"
            "${stateDirectory}/collector:/app/motel-data:U"
          ];
          environment = {
            BETTER_AUTH_URL = cfg.origin;
            DO_NOT_TRACK = "1";
            EXECUTOR_APPS_ALLOW_PRIVATE_FETCH = "false";
            EXECUTOR_APP_WORKERS = toString cfg.workerLimit;
            EXECUTOR_APP_WORKER_IDLE_SECONDS = "60";
          };
          extraOptions = [
            "--network=bridge"
            "--subuidname=limitless-executor"
            "--subgidname=limitless-executor"
            "--cap-drop=ALL"
            "--security-opt=no-new-privileges"
            "--init"
            "--read-only"
            "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=256m,mode=1777"
            "--pids-limit=256"
            "--memory=${toString cfg.memoryLimitMiB}m"
            "--cpus=2"
            "--stop-timeout=30"
            "--health-start-period=120s"
          ];
        };
      };
    };
    systemd.services.podman-limitless-executor = {
      serviceConfig = {
        TimeoutStartSec = lib.mkForce 900;
      };
    };
  };
}
