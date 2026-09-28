# Gates: OpenCode Profile Manager stable 1.18.32

OWNS: package.json, tsconfig.json, src/**, test/**, scripts/**, examples/**, README.md, GATES.md

Scope: Deliver a profile engine, server and TUI plugins, verifiable isolation behavior, profile-owned plugin management, disposable profiles, and stable 1.18.32 evidence.

- [x] G1: Core handles profile validation, inheritance, diff, atomic persistence, rollback, and temporary lifecycle
  CHECK: bun test test/core.test.ts
  EXPECT: CORE_PROFILE_TESTS_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=65d9f6b2d94ef3932f0104f6b5dcbe001623943eb70bd801f5b57874f0198dd5; exit=0; EXPECT=matched; output-sha256=3e9ca19827e03b2a024e94d9c617b600eb5bb8133c88ffe9de5b92bb43eb6752; output-bytes=741; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\PC TRABALHO\Documents\Projetos\Opencode-Profile-Switcher; path=a38712dca203/67 entries

- [x] G2: Stable TUI adapter registers `/profile`, exposes metadata/actions, and uses the public keymap and plugin APIs
  CHECK: bun test test/tui.test.ts
  EXPECT: TUI_PROFILE_TESTS_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=33f1e99dbcd77dd3b64e0de92b3368f81be7966be92e3ad68db741cfb6a64ec1; exit=0; EXPECT=matched; output-sha256=7372da9ea9c1d8b9f62645f3511d02a9d5fabd5b10863316affda01ef1526337; output-bytes=645; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\PC TRABALHO\Documents\Projetos\Opencode-Profile-Switcher; path=a38712dca203/67 entries

- [x] G3: Server bootstrap applies the active profile and instance disposal reboots it without deleting sessions
  CHECK: bun test test/server.test.ts
  EXPECT: SERVER_PROFILE_TESTS_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=e6067271beae81d8e1aaed37b211c3101b8f57e0e03cfe961f385e3c5f738941; exit=0; EXPECT=matched; output-sha256=96fd6c2c4e18d3bd478d6c3ea24c1e4e79b0c163f0b7659f8c51d44f21ff82c8; output-bytes=262; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\PC TRABALHO\Documents\Projetos\Opencode-Profile-Switcher; path=a38712dca203/67 entries

- [x] G4: Isolation matrix reports global/project config, plugins, skills, MCPs, agents, and commands accurately
  CHECK: bun test test/isolation.test.ts
  EXPECT: ISOLATION_MATRIX_TESTS_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=18bb0c1de049bf20cdc60e7105734969cce9d1043e9031b9e5d703eededf983e; exit=0; EXPECT=matched; output-sha256=dd3553980fd575f436adc00e0796c535b67c8d48af5c90cec6171345a09bb33c; output-bytes=610; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\PC TRABALHO\Documents\Projetos\Opencode-Profile-Switcher; path=a38712dca203/67 entries

- [x] G5: GitHub plugin discovery, metadata, pinned refs, installed state, and activation use stable 1.18.32 behavior
  CHECK: bun test test/plugins.test.ts
  EXPECT: PROFILE_PLUGIN_TESTS_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=b8726c9b55752961fa24204a331656777a26759e7e3fc79684fe9364be302d19; exit=0; EXPECT=matched; output-sha256=2d6649b308fcac1c1419af8d84f8660f8c3520afab496a0b16be5735852267fe; output-bytes=389; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\PC TRABALHO\Documents\Projetos\Opencode-Profile-Switcher; path=a38712dca203/67 entries

- [x] G6: Abandoned temporary profiles are recovered without deleting shared package caches
  CHECK: bun test test/ephemeral.test.ts
  EXPECT: EPHEMERAL_PROFILE_TESTS_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=a97a81d88ce1a4258958db3ef5b7e33f662506b64b15c16446b5c6d614eef0f2; exit=0; EXPECT=matched; output-sha256=84ba507e6c1342744d397914a2236e522d087d34b9204afaf2c841543d97f404; output-bytes=509; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\PC TRABALHO\Documents\Projetos\Opencode-Profile-Switcher; path=a38712dca203/67 entries

- [x] G7: TypeScript strict checking passes against the 1.18.32 plugin API
  CHECK: bun run typecheck
  EXPECT: TYPECHECK_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=d4deb69c8d2eae2f142486fb0113e1a62bafe5f1950bbc76f505312d5bfa94f2; exit=0; EXPECT=matched; output-sha256=edbf36f3639077d41218ec077470de82191a1f6c922b3e2e6aa7b13cd19a6c38; output-bytes=77; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\PC TRABALHO\Documents\Projetos\Opencode-Profile-Switcher; path=a38712dca203/67 entries

- [x] G8: Installed OpenCode 1.18.32 smoke passes using isolated temporary HOME/XDG/config paths
  CHECK: bun run smoke:stable
  EXPECT: STABLE_11832_SMOKE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=a8246c1e2d88b7f4f36b91e4dbad85f7594c4c3ed0c388ca8ec96cb7f84ddd13; exit=0; EXPECT=matched; output-sha256=d476a0a4c69a72bfc79cc35e530d05c2a936be91cdb452f36bdf815e1adeaefd; output-bytes=58; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\PC TRABALHO\Documents\Projetos\Opencode-Profile-Switcher; path=a38712dca203/67 entries

- [x] G9: Combined strict typecheck and complete test suite pass; runtime integration evidence is checked separately in G8
  CHECK: bun run verify
  EXPECT: PROFILE_MANAGER_VERIFY_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=742e7cf7f6e6f273cb42442d062bb2aa69db2092926e34252418523293a3e576; exit=0; EXPECT=matched; output-sha256=999531f54c22f30fc113fe13651c286dc129eb2a6396977adc950758e043799b; output-bytes=2843; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\PC TRABALHO\Documents\Projetos\Opencode-Profile-Switcher; path=a38712dca203/67 entries

- [x] G10: Desktop extension limitation is documented from checked upstream code
  EVIDENCE: README.md Desktop support section links the exact v1.18.32 Desktop menu and TUI API source files.
