{
  pkgs,
  self,
  system,
}:
let
  version = "0.25.4";
  sources = {
    x86_64-linux = {
      url = "https://github.com/vercel-labs/agent-browser/releases/download/v${version}/agent-browser-linux-x64";
      sha256 = "02d26f105a9d8e203f8f966acfeb4bab191cfa4625431a535b8be5f8f5905472";
    };
    aarch64-linux = {
      url = "https://github.com/vercel-labs/agent-browser/releases/download/v${version}/agent-browser-linux-arm64";
      sha256 = "f44b037cf208e1c5771ad498983f5674aca2b65da5c1b2f440aba901f3ddf536";
    };
    x86_64-darwin = {
      url = "https://github.com/vercel-labs/agent-browser/releases/download/v${version}/agent-browser-darwin-x64";
      sha256 = "184d753f023f69a3075c65ea942b6f6c9cb4dfc1cb53b35cf6659b1439f655fc";
    };
    aarch64-darwin = {
      url = "https://github.com/vercel-labs/agent-browser/releases/download/v${version}/agent-browser-darwin-arm64";
      sha256 = "65d105557e2b0fc95072d2cbb3ed2dab714cef7720b85aae56fbf3e15e4294e7";
    };
  };
  platformSrc = sources.${system} or (throw "Unsupported system for agent-browser: ${system}");
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "agent-browser";
  inherit version;

  src = pkgs.fetchurl {
    inherit (platformSrc) url sha256;
  };

  nativeBuildInputs = [ pkgs.makeWrapper ];

  dontUnpack = true;
  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    mkdir -p $out/bin $out/share/skills
    install -m755 $src $out/bin/agent-browser
    cp -r ${self}/nix/skills/agent-browser $out/share/skills/agent-browser
  '';

  # On Linux, point agent-browser at nix-provided chromium so users don't need
  # to run `agent-browser install` (which fails outright on Linux ARM64 because
  # Chrome for Testing ships no ARM64 builds). `--set-default` keeps user
  # overrides via environment working.
  # On Darwin we leave auto-detection alone so Chrome.app or an upstream
  # `agent-browser install` continues to work.
  postFixup = pkgs.lib.optionalString pkgs.stdenv.isLinux ''
    wrapProgram $out/bin/agent-browser \
      --set-default AGENT_BROWSER_EXECUTABLE_PATH ${pkgs.chromium}/bin/chromium
  '';

  meta = with pkgs.lib; {
    description = "Browser automation CLI for AI agents";
    homepage = "https://github.com/vercel-labs/agent-browser";
    mainProgram = "agent-browser";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "x86_64-darwin"
      "aarch64-darwin"
    ];
  };
}
