{ pkgs }:
let
  rev = "e03f023c8ea1771a829cee51024b8675ffede24c";
  packageVersion = "2.0.0-next.3-${builtins.substring 0 7 rev}";
  upstreamPluginSdkVersion = "2.0.4";
  src = pkgs.fetchFromGitHub {
    owner = "ex-machina-co";
    repo = "opencode-anthropic-auth";
    inherit rev;
    hash = "sha256-a6sLO9aN3t1DnmOT9VwFbYkLoTQXyhdiIbyVPcrBrVk=";
  };

  bunDeps = pkgs.stdenvNoCC.mkDerivation {
    name = "opencode-anthropic-auth-bun-deps-${builtins.substring 0 7 rev}";
    inherit src;

    nativeBuildInputs = [ pkgs.bun ];

    dontConfigure = true;
    dontFixup = true;

    buildPhase = ''
      export HOME=$TMPDIR
      bun install --no-progress --frozen-lockfile --ignore-scripts --production --omit optional
    '';

    installPhase = ''
      mkdir -p $out
      cp -r node_modules $out/node_modules
    '';

    outputHash = "sha256-Rs7ghwiW+HyVVfdR+/zboJURLC75UzOZa7N9pjxfM0A=";
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
  };
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "opencode-anthropic-auth";
  version = packageVersion;
  inherit src;

  # OpenCode disables WebSockets for every provider matched by an HTTP hook.
  patches = [ ../../patches/opencode-anthropic-auth-provider-hooks.patch ];

  nativeBuildInputs = [ pkgs.bun ];

  dontConfigure = true;
  dontFixup = true;

  buildPhase = ''
    cp -r ${bunDeps}/node_modules node_modules
    mkdir -p dist
    bun build src/index.ts \
      --target=node \
      --format=esm \
      --packages=bundle \
      --outfile=dist/anthropic-auth.js
  '';

  doCheck = true;
  checkPhase = ''
    cp ${./anthropic-auth.test.mjs} ./anthropic-auth.test.mjs
    bun test ./anthropic-auth.test.mjs \
      ./src/tests/index.test.ts \
      ./src/tests/config.test.ts \
      ./src/tests/version-rejection.test.ts \
      ./src/tests/rate-limit.test.ts \
      ./src/tests/tool-name-alias.test.ts \
      ./src/tests/bounded.test.ts
  '';

  installPhase = ''
    mkdir -p $out
    cp dist/anthropic-auth.js $out/anthropic-auth.js
    cp dist/anthropic-auth.js $out/index.js
    cp LICENSE $out/LICENSE
    cat > $out/package.json <<'EOF'
    {
      "name": "opencode-anthropic-auth",
      "version": "${packageVersion}",
      "type": "module",
      "exports": "./anthropic-auth.js"
    }
    EOF
  '';

  passthru = {
    inherit rev upstreamPluginSdkVersion;
  };

  meta = with pkgs.lib; {
    description = "OpenCode 2 Anthropic OAuth plugin";
    homepage = "https://github.com/ex-machina-co/opencode-anthropic-auth";
    license = licenses.mit;
    platforms = platforms.all;
  };
}
