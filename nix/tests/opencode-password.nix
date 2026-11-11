{ pkgs, opencode }:
pkgs.runCommand "opencode-password-check"
  {
    nativeBuildInputs = [ pkgs.coreutils ];
  }
  ''
    umask 077
    ${pkgs.lib.getExe pkgs.nodejs} ${./opencode-password.mjs} ${pkgs.lib.getExe opencode}
    touch "$out"
  ''
