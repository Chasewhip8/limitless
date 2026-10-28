{ pkgs, dependencies }:
pkgs.runCommand "limitless-dependencies-check" { nativeBuildInputs = [ pkgs.bun ]; } ''
  cp ${../packages/limitless-bun-links.mjs} limitless-bun-links.mjs
  cp ${../packages/limitless-bun-links.test.mjs} limitless-bun-links.test.mjs
  bun test limitless-bun-links.test.mjs
  # A package-manager bin-link race must not change the fixed-output tree.
  if [ -n "$(find ${dependencies} -type d -path '*/node_modules/.bin' -print -quit)" ]; then
    echo "Limitless dependencies contain generated executable links" >&2
    exit 1
  fi
  touch "$out"
''
