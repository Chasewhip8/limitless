{ pkgs, package }:
let
  inherit (pkgs) lib;
  inherit (package) contents launchers;
  original = pkgs.appimageTools.extract {
    pname = "t3-desktop";
    version = lib.getVersion package;
    inherit (package) src;
  };
  bundle = "apps/desktop/dist-electron/main.cjs";
in
pkgs.runCommand "limitless-t3-desktop-check"
  {
    nativeBuildInputs = [
      pkgs.asar
      pkgs.nodejs
    ];
  }
  ''
    # The archive rewrite changes only T3's main bundle, as read by upstream asar.
    asar extract ${original}/resources/app.asar original
    asar extract ${contents}/resources/app.asar patched
    mv original/${bundle} original.cjs
    mv patched/${bundle} patched.cjs
    diff -r original patched

    # T3 must keep the shim first after replacing PATH from a login shell or its cache.
    node ${./validate-t3-desktop.mjs} original.cjs patched.cjs ${launchers}/bin

    touch "$out"
  ''
