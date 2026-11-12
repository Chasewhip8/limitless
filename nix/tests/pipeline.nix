{ pkgs, self }:
let
  inherit (pkgs) lib;
  package = self.packages.${pkgs.stdenv.hostPlatform.system}.pipeline;
  opencode = self.packages.${pkgs.stdenv.hostPlatform.system}.opencode;
  capsule = self.packages.${pkgs.stdenv.hostPlatform.system}.capsule;
  fileOption = lib.mkOption {
    type = lib.types.attrsOf lib.types.attrs;
    default = { };
    apply = lib.mapAttrs (
      name: file:
      file
      // lib.optionalAttrs (file ? text && !(file ? source)) {
        source = pkgs.writeText (builtins.baseNameOf name) file.text;
      }
    );
  };
  homeStubs = {
    options = {
      assertions = lib.mkOption {
        type = lib.types.listOf lib.types.attrs;
        default = [ ];
      };
      warnings = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
      };
      home = {
        file = fileOption;
        packages = lib.mkOption {
          type = lib.types.listOf lib.types.package;
          default = [ ];
        };
        shellAliases = lib.mkOption {
          type = lib.types.attrsOf lib.types.str;
          default = { };
        };
        homeDirectory = lib.mkOption {
          type = lib.types.str;
          default = "/home/test";
        };
        profileDirectory = lib.mkOption {
          type = lib.types.str;
          default = "/home/test/.nix-profile";
        };
      };
      xdg =
        lib.genAttrs [ "configHome" "dataHome" "stateHome" "cacheHome" ] (
          name:
          lib.mkOption {
            type = lib.types.str;
            default = "/home/test/${name}";
          }
        )
        // {
          configFile = fileOption;
        };
      systemd.user = {
        enable = lib.mkOption {
          type = lib.types.bool;
          default = true;
        };
        startServices = lib.mkOption {
          type = lib.types.bool;
          default = true;
        };
        services = lib.mkOption {
          type = lib.types.attrsOf lib.types.attrs;
          default = { };
        };
      };
      programs.git = {
        enable = lib.mkOption {
          type = lib.types.bool;
          default = false;
        };
        ignores = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
        };
      };
    };
  };
  evaluateWith =
    module: extra:
    lib.evalModules {
      specialArgs = { inherit pkgs; };
      modules = [
        module
        homeStubs
        extra
      ];
    };
  evaluate = evaluateWith (import ../modules/home.nix { inherit self; });
  valid = home: lib.all (entry: entry.assertion) home.config.assertions;
  defaults = evaluate { };
  capsuleHost = evaluate {
    programs.limitless = {
      enable = true;
      capsule = {
        enable = true;
        github.tokenFile = "/run/secrets/capsule-github";
        identity = {
          name = "Capsule Agent";
          email = "agent@example.invalid";
        };
        dockerSocket = "/run/docker.sock";
      };
      opencode.service.enable = true;
    };
  };
  capsuleSettings = builtins.fromJSON (
    builtins.unsafeDiscardStringContext capsuleHost.config.xdg.configFile."capsule/host.json".text
  );
  clientOnly = evaluate {
    programs.limitless = {
      enable = true;
      pipeline.client = {
        enable = true;
        url = "https://athena.example.ts.net:10443";
        tokenFile = "/run/secrets/pipeline-api";
      };
    };
  };
  worker = {
    id = "worker";
    url = "https://worker.example.ts.net";
    credentialFile = "/run/secrets/pipeline-worker";
    controlDirectory = "/home/test/capsule-control";
    system = "aarch64-linux";
  };
  coordinatorSettings = {
    enable = true;
    settings = {
      apiTokenFile = "/run/secrets/pipeline-api";
      githubTokenFile = "/run/secrets/pipeline-github";
      workers = [ worker ];
    };
  };
  coordinator = evaluate { programs.limitless.pipeline = coordinatorSettings; };
  standalone = evaluateWith (import ../modules/pipeline.nix { inherit self; }) {
    programs.limitless.pipeline = coordinatorSettings;
  };
  generated = coordinator.config.xdg.configFile."pipeline/config.json";
  settings = builtins.fromJSON generated.text;
  unit = coordinator.config.systemd.user.services.pipeline;
  accepts =
    settings:
    (builtins.tryEval (
      builtins.deepSeq
        (evaluate {
          programs.limitless.pipeline = lib.recursiveUpdate coordinatorSettings { inherit settings; };
        }).config.xdg.configFile."pipeline/config.json".text
        true
    )).success;
  runtimeTest = pkgs.runCommand "pipeline-runtime-test" { nativeBuildInputs = [ pkgs.bun ]; } ''
    mkdir -p nix/tests node_modules "$out"
    cp -r ${package.src}/packages packages
    chmod -R u+w packages
    ln -s ${package.dependencies}/node_modules/.bun node_modules/.bun
    ln -s ${package.dependencies}/packages/pipeline/node_modules/* node_modules/
    cp -r ${package.dependencies}/packages/pipeline/node_modules packages/pipeline/node_modules
    cp -r ${package.dependencies}/packages/capsule/node_modules packages/capsule/node_modules
    cp ${./pipeline-runtime.mjs} nix/tests/pipeline-runtime.mjs
    bun build nix/tests/pipeline-runtime.mjs \
      --target=node --format=esm --packages=bundle --outfile="$out/pipeline-runtime.mjs"
  '';
  runner = pkgs.writeShellApplication {
    name = "validate-pipeline";
    runtimeInputs = [
      pkgs.git
      pkgs.nix
      pkgs.coreutils
      pkgs.util-linux
    ];
    text = ''
      exec ${lib.getExe package.node} ${runtimeTest}/pipeline-runtime.mjs ${
        lib.escapeShellArgs [
          (lib.getExe opencode)
          capsule.runtimeConfig
          opencode.version
          pkgs.stdenv.hostPlatform.system
        ]
      } "$@"
    '';
  };
in
assert lib.assertMsg (
  valid defaults
  && defaults.config.home.packages == [ ]
  && defaults.config.xdg.configFile == { }
  && defaults.config.systemd.user.services == { }
) "Disabled Pipeline must not install packages, configuration, or services";
assert lib.assertMsg
  (
    valid capsuleHost
    && builtins.elem capsule capsuleHost.config.home.packages
    && !(builtins.elem package capsuleHost.config.home.packages)
    && builtins.attrNames capsuleHost.config.systemd.user.services == [ "opencode" ]
    &&
      capsuleSettings == {
        root = "/home/test/stateHome/capsule/runtime";
        checkoutRoot = "/home/test/dataHome/capsule/checkouts";
        controlDirectory = "/home/test/stateHome/capsule/control";
        inherit (capsule) runtime;
        credentials = {
          github.tokenFile = "/run/secrets/capsule-github";
          identity = {
            name = "Capsule Agent";
            email = "agent@example.invalid";
          };
        };
        dockerSocket = "/run/docker.sock";
      }
    && builtins.elem capsuleHost.config.programs.limitless._generated.capsuleHostConfig capsuleHost.config.systemd.user.services.opencode.Unit.X-Restart-Triggers
    && !(valid (evaluate {
      programs.limitless.capsule.enable = true;
    }))
    && !(valid (evaluate {
      programs.limitless.enable = true;
      programs.limitless.capsule = {
        enable = true;
        github = {
          tokenFile = "/run/secrets/token";
          tokenEnv = "TOKEN";
        };
      };
    }))
  )
  "Capsule workers configure the existing native server, with runtime credential paths and no Pipeline helper or second daemon";
assert lib.assertMsg (
  valid clientOnly
  && !(builtins.elem package clientOnly.config.home.packages)
  && clientOnly.config.systemd.user.services == { }
  &&
    lib.any
      (
        plugin:
        builtins.isAttrs plugin
        &&
          (plugin.options.pipeline or { }) == {
            enabled = true;
            url = "https://athena.example.ts.net:10443";
            tokenFile = "/run/secrets/pipeline-api";
          }
      )
      (builtins.fromJSON (
        builtins.unsafeDiscardStringContext clientOnly.config.xdg.configFile."opencode/opencode.json".text
      )).plugins
  && !(valid (evaluate {
    programs.limitless.enable = true;
    programs.limitless.pipeline.client.enable = true;
  }))
) "Caller tools require an enrolled origin and hosted plugin, not a local coordinator";
assert lib.assertMsg
  (
    valid coordinator
    && valid standalone
    && standalone.config.home.packages == coordinator.config.home.packages
    && standalone.config.systemd.user.services == coordinator.config.systemd.user.services
    && !coordinator.config.programs.limitless.enable
    && coordinator.config.home.packages == [ package ]
    && builtins.attrNames coordinator.config.xdg.configFile == [ "pipeline/config.json" ]
    && builtins.attrNames coordinator.config.systemd.user.services == [ "pipeline" ]
    &&
      settings == {
        host = "127.0.0.1";
        port = 4848;
        database = "/home/test/stateHome/pipeline/pipeline.sqlite";
        apiTokenFile = "/run/secrets/pipeline-api";
        githubTokenFile = "/run/secrets/pipeline-github";
        pollIntervalMs = 60000;
        queueTimeoutMs = 3600000;
        workers = [
          (
            worker
            // {
              capacity = 1;
              openCodeVersion = "2.2.7";
            }
          )
        ];
      }
  )
  "Coordinator JSON must match the standalone CLI contract without installing hosted OpenCode or secret values";
assert lib.assertMsg
  (
    unit.Service.Type == "exec"
    && lib.hasInfix "serve --config /home/test/configHome/pipeline/config.json" unit.Service.ExecStart
    && unit.Service.UMask == "0077"
    && unit.Service.StateDirectory == "pipeline"
    && unit.Service.StateDirectoryMode == "0700"
    && unit.Service.RuntimeDirectory == "pipeline"
    && unit.Service.RuntimeDirectoryMode == "0700"
    && unit.Service.KillSignal == "SIGTERM"
    && unit.Service.KillMode == "control-group"
    && unit.Service.SuccessExitStatus == [ 130 ]
    && unit.Service.Restart == "on-failure"
    && unit.Unit.X-Restart-Triggers == [ generated.source ]
    && !(unit.Service ? ProtectHome)
    && !(unit.Service ? ReadWritePaths)
    && !(unit.Service ? EnvironmentFile)
    && !(valid (evaluate {
      programs.limitless.pipeline = coordinatorSettings;
      systemd.user.enable = false;
    }))
  )
  "Supervision must preserve shutdown, private state, config restarts, and configured workspace access";
assert lib.assertMsg
  (
    lib.all (url: !accepts { workers = [ (worker // { inherit url; }) ]; }) [
      "http://worker.example.ts.net"
      "https://user:password@worker.example.ts.net"
      "https://worker.example.ts.net/path"
      "https://worker.example.ts.net?token=value"
      "https://worker.example.ts.net#fragment"
    ]
    && accepts { workers = [ (worker // { url = "http://127.0.0.1:4096"; }) ]; }
    && lib.all (path: !accepts { apiTokenFile = path; }) [
      "relative-token"
      "/nix/store/token"
      "/run/secrets/token "
    ]
    && !accepts { workers = [ (worker // { credentialFile = "/nix/store/password"; }) ]; }
    && !accepts { workers = [ (worker // { controlDirectory = "relative-control"; }) ]; }
    && !(valid (evaluate {
      programs.limitless.pipeline = lib.recursiveUpdate coordinatorSettings {
        settings.workers = [
          worker
          worker
        ];
      };
    }))
  )
  "Enrollment must reject insecure origins, store credentials, relative control Locations, and duplicate worker ids";
pkgs.runCommand "pipeline-check"
  {
    meta.mainProgram = "validate-pipeline";
    nativeBuildInputs = [
      package.node
      pkgs.bun
      pkgs.git
      pkgs.gnutar
      pkgs.util-linux
    ];
  }
  ''
    umask 077
    test -x ${lib.getExe package}
    grep -qF 'OPENCODE_CAPSULE_CONFIG' ${capsuleHost.config.programs.limitless._generated.opencodePackage}/bin/opencode
    for directory in ${lib.escapeShellArgs (lib.splitString ":" capsule.runtime.basePath)}; do
      grep -qF "$directory" ${capsuleHost.config.programs.limitless._generated.opencodePackage}/bin/opencode
    done
    if [ -n "$(find ${package.dependencies} -type d -path '*/node_modules/.bin' -print -quit)" ]; then
      echo "Pipeline dependencies contain nondeterministic executable links" >&2
      exit 1
    fi
    ${lib.getExe package.node} --input-type=module - ${lib.getExe package} <<'EOF'
    import assert from "node:assert/strict";
    import { spawn } from "node:child_process";
    import { randomUUID } from "node:crypto";
    import { mkdtemp, writeFile, stat } from "node:fs/promises";
    import { createServer } from "node:net";
    import { join } from "node:path";
    import { setTimeout as delay } from "node:timers/promises";

    const root = await mkdtemp(join(process.env.TMPDIR, "pipeline-smoke-"));
    const environment = {
      PATH: "", HOME: root,
      XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"),
      XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
    };
    const controlDirectory = join(root, "capsule-control");
    const socket = createServer();
    await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
    const { port } = socket.address();
    await new Promise(resolve => socket.close(resolve));
    const apiToken = randomUUID();
    const workerToken = randomUUID();
    const apiTokenFile = join(root, "api-token");
    const credentialFile = join(root, "worker-token");
    await writeFile(apiTokenFile, apiToken, { mode: 0o600 });
    await writeFile(credentialFile, workerToken, { mode: 0o600 });
    const database = join(root, "pipeline.sqlite");
    const config = join(root, "config.json");
    await writeFile(config, JSON.stringify({
      host: "127.0.0.1", port, database, apiTokenFile, githubTokenFile: null,
      pollIntervalMs: 100, queueTimeoutMs: 1000,
      workers: [{
        id: "fixture", url: "http://127.0.0.1:1", credentialFile,
        controlDirectory,
        system: "${pkgs.stdenv.hostPlatform.system}", capacity: 1, openCodeVersion: "2.2.7",
      }],
    }));
    const child = spawn(process.argv[2], ["serve", "--config", config], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const exited = new Promise((resolve, reject) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    });
    const base = `http://127.0.0.1:''${port}`;
    const headers = { Authorization: `Bearer ''${apiToken}` };
    try {
      let ready = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        assert.equal(child.exitCode, null, "Packaged coordinator exited before readiness");
        const response = await fetch(`''${base}/health`, { headers }).catch(() => null);
        if (response?.status === 200) {
          assert.deepEqual(await response.json(), { status: "ok" });
          ready = true;
          break;
        }
        await delay(50);
      }
      assert(ready, "Packaged coordinator never became ready");
      assert.equal((await fetch(`''${base}/health`)).status, 401, "Health must require auth");
      assert.equal((await fetch(`''${base}/health`, {
        headers: { Authorization: "Bearer incorrect" },
      })).status, 401, "Health must reject incorrect auth");
      assert.equal((await fetch(`''${base}/tasks/00000000-0000-4000-8000-000000000000`, { headers })).status, 404);
      assert((await stat(database)).size > 0, "Packaged SQLite schema was not initialized");
      child.kill("SIGTERM");
      const deadline = AbortSignal.timeout(10000);
      const result = await Promise.race([
        exited,
        new Promise((_, reject) => deadline.addEventListener("abort", () => reject(new Error("Coordinator did not stop")))),
      ]);
      assert.deepEqual(result, { code: 130, signal: null }, "SIGTERM must complete Effect's interruption teardown");
      assert(!output.includes(apiToken) && !output.includes(workerToken), "Credentials leaked to service output");
    } catch (error) {
      const diagnostic = output.replaceAll(apiToken, "[redacted]").replaceAll(workerToken, "[redacted]");
      throw new Error(`''${error.message}\n''${diagnostic.slice(-16000)}`, { cause: error });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
    EOF
    # Namespace creation and the shared Nix daemon are available only on the host.
    mkdir -p "$out"
    ln -s ${runner}/bin "$out/bin"
  ''
