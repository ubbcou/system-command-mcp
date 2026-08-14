## Problem Statement

Codex and DSH currently execute development programs through host-specific shell tools whose invocation syntax, program discovery, inherited environment, lifecycle behavior, and result projection vary between Windows and macOS and between terminal and GUI launches. A direct invocation such as Git, Node.js, a package manager, Python, ripgrep, a compiler, formatter, or test runner should not require an agent to choose Bash, PowerShell, or cmd.exe, probe the host with shell-specific commands, or construct a quoted shell command string.

The existing MCP Server proves the basic `program + args[]` approach but relies on the Server process's inherited PATH, exposes only one Working Directory Root, terminates only the direct child, retains only output tails, treats normal nonzero outcomes as MCP errors, and lacks managed configuration, diagnosis, complete Process Tree lifecycle, bounded concurrency, large-output retrieval, and verified Codex/DSH behavior on both target platforms. Consequently, the same installation can expose different Registered Programs or behave differently depending on which host launched it, and timed-out commands can leave descendants running.

The product needs one stable cross-host execution contract for finite, non-interactive development programs. It must remain a direct-program executor rather than a shell emulator or filesystem sandbox.

## Solution

Evolve `system-command-mcp` into the shared system-program execution interface for Codex and DSH on Windows x64 and macOS arm64.

Agents invoke one Logical Program with an Argument Vector, an authorized working directory, a finite timeout, and optional bounded Execution Input. The Server constructs one authoritative Execution Environment at startup and uses it both to register programs and to run every child process. Stable deployments use a versioned Program Manifest shared by Codex and DSH; each host separately supplies its Host Authorization through one or more Working Directory Roots. The backward-compatible Automatic Discovery Mode remains available for zero-configuration use but makes no cross-host identity guarantee.

A deep `Command Runtime` module owns Program Configuration, the Environment Snapshot, execution limits, Process Tree lifecycle, Inline Output, Execution Artifacts, Output Page reads, concurrency, and shutdown. The MCP Server and management CLI are adapters over this interface. The public MCP tools remain `system_exec` and `system_environment`, with `system_output` added when Execution Artifacts are implemented.

Host Guidance makes the responsibility split explicit:

- One installed program is invoked with `system_exec`.
- Shell composition, redirection, pipelines, shell built-ins, or interactive behavior use the host shell.
- Filesystem reads, writes, and searches use host filesystem tools.

The Server does not accept a shell command string, does not provide interactive TTY or background-job semantics, and does not claim that Working Directory Roots constrain which files an invoked program can access.

## User Stories

1. As a Codex user on Windows, I want to invoke Git with a Logical Program and literal Argument Vector, so that I do not need to construct a PowerShell or cmd.exe command string.
2. As a Codex user on macOS, I want the same `system_exec` interface used on Windows, so that agent instructions remain portable.
3. As a DSH user on Windows, I want the same Canonical Result as Codex receives, so that execution behavior does not depend on the host.
4. As a DSH user on macOS, I want Homebrew and version-manager programs to resolve consistently from GUI and terminal launches, so that DSH does not lose tools when launched outside a shell.
5. As an agent, I want each argument passed literally, so that spaces, Unicode, quotes, `$HOME`, wildcards, and shell operators are not unintentionally expanded.
6. As an agent, I want a Logical Program enum containing only Registered Programs, so that I do not guess executable names.
7. As a user, I want `python` to resolve to the configured platform executable, so that instructions do not depend on whether the machine calls it `python3` or `python`.
8. As a user, I want `ripgrep` to resolve to `rg`, so that the model sees a stable descriptive name.
9. As an administrator, I want Codex and DSH to share one Program Manifest, so that both hosts select the same executables and Execution Environment.
10. As an administrator, I want Codex and DSH to authorize different Working Directory Roots, so that shared program identity does not require shared directory access.
11. As a first-time user, I want Automatic Discovery Mode to work without a Program Manifest, so that I can evaluate the Server with minimal setup.
12. As a stable-deployment user, I want Configured Mode to reject an invalid explicit Program Manifest, so that the Server never silently falls back to a different environment.
13. As a configuration author, I want a versioned JSON Program Manifest, so that configuration interpretation is explicit and machine-validatable.
14. As a configuration author, I want unknown Manifest fields rejected, so that a misspelled field cannot create false confidence.
15. As a configuration author, I want base definitions with platform overrides, so that common configuration is written once while Windows and macOS differences remain explicit.
16. As a configuration author, I want arrays replaced and objects shallow-merged by documented rules, so that platform overrides are predictable.
17. As a configuration author, I want Program Candidates expressed as absolute, home-relative, Manifest-relative, or PATH names, so that both fixed and portable installations are possible.
18. As a user, I want the Server to retain both the Declared Candidate and resolved executable, so that I can diagnose symlinks and wrapper resolution.
19. As a user, I want Shadowed Candidates reported by `doctor`, so that I can see why one Node.js or Git installation won.
20. As an administrator, I want Configured Mode to disable inherited PATH by default, so that GUI and terminal hosts do not select different programs.
21. As a user, I want program discovery and child processes to use the same Execution Environment, so that a discovered wrapper can find its interpreter at runtime.
22. As a Windows user, I want PATHEXT behavior to support `.EXE`, `.CMD`, `.BAT`, and configured extensions, so that npm and pnpm wrappers work while retaining the documented cmd.exe argument-reparse limitation.
23. As a user, I want the contract to acknowledge Platform Wrappers without accepting shell command strings or promising native literal-argument behavior for `.cmd` and `.bat`, so that Windows support is accurate rather than misleading.
24. As a configuration author, I want Core Programs to prevent startup when unavailable, so that required development capabilities fail early.
25. As a configuration author, I want Optional Programs omitted when unavailable, so that the model does not invoke programs that cannot run.
26. As a zero-configuration user, I want Automatic Discovery Mode to have no mandatory Core Program, so that non-Node and non-Git workflows can still inspect the environment.
27. As a configuration author, I want per-Program timeout defaults and maximums, so that fast commands and test suites can have appropriate limits.
28. As an agent, I want to request a timeout within the Program Policy maximum, so that long but bounded operations can complete.
29. As an administrator, I want a Server hard timeout maximum, so that Manifest or agent configuration cannot permit unbounded commands.
30. As a user, I want optional bounded Execution Input for explicitly enabled programs, so that non-interactive stdin workflows work without adding a TTY.
31. As a user, I want Execution Input closed immediately after writing, so that programs do not wait indefinitely for more input.
32. As a security-conscious user, I want Execution Input content excluded from logs, errors, and Artifact metadata, so that secrets are not copied.
33. As a configuration author, I want Environment Layers that can remove or assign variables globally and per Program, so that execution can be stabilized without call-time environment mutation.
34. As a configuration author, I want literal environment values and Environment References represented distinctly, so that secrets need not be stored in the Manifest.
35. As a configuration author, I want missing required Environment References to fail startup, so that required credentials do not fail later in obscure ways.
36. As a configuration author, I want missing optional Environment References to remove the target variable, so that an unrelated inherited value is not used accidentally.
37. As a Windows user, I want environment names resolved case-insensitively, so that `Path` and `PATH` behave as the same variable.
38. As an agent, I want an Execution Request to select any existing cwd inside Host Authorization, so that one Server can work across authorized repositories.
39. As a single-Root user, I want relative cwd values and a default of `.`, so that common calls stay concise.
40. As a multi-Root user, I want absolute cwd values required, so that the selected Root is never ambiguous.
41. As an administrator, I want duplicate and nested Roots normalized away, so that the effective Host Authorization is clear.
42. As an administrator, I want Root paths resolved physically and symlink escapes rejected, so that cwd authorization cannot be widened by a link.
43. As an administrator, I want each request to revalidate Root and cwd availability, so that deleted or unmounted directories fail clearly.
44. As an administrator, I want Root Identity checked when the platform supports it, so that a different directory object mounted at the same path does not silently inherit authorization.
45. As a user, I want `CWD_NOT_FOUND`, `CWD_NOT_ALLOWED`, and `ROOT_UNAVAILABLE` distinguished, so that I can correct configuration or request arguments.
46. As an agent, I want a normal nonzero exit code returned as an Execution Result, so that `rg` no-match and `git diff --quiet` are not confused with MCP failures.
47. As an agent, I want timeout and cancellation returned as structured Execution Terminal States, so that retained output remains available.
48. As an agent, I want invalid requests, spawn failures, and internal execution failures represented as tool errors, so that protocol failures remain distinct from process outcomes.
49. As an integrator, I want stable error codes with structured MCP error data where supported, so that Codex and DSH can diagnose failures consistently.
50. As an agent, I want stdout and stderr represented separately, so that diagnostics preserve stream identity.
51. As an agent, I want bounded head and tail Inline Output, so that both initial context and final diagnostics remain visible.
52. As an existing caller, I want `stdout.text` and `stderr.text` retained, so that the output contract can evolve without removing the existing projection.
53. As a user, I want truncation measured in bytes with `totalBytes` and `omittedBytes`, so that I understand how much output was omitted.
54. As a user, I want Inline Output truncation to respect UTF-8 boundaries, so that truncation does not create avoidable replacement characters.
55. As a user, I want invalid UTF-8 reported explicitly, so that I know when the text projection is lossy.
56. As a user, I want raw output bytes retained in an Execution Artifact when configured, so that non-UTF-8 or large diagnostics remain recoverable.
57. As a user, I want Artifact Policy choices of `never`, `on-truncation`, and `always`, so that storage behavior can match each Program.
58. As a user, I want `on-truncation` to preserve output from process start, so that the retained Artifact is complete rather than beginning at the truncation point.
59. As a user, I want Artifact failure not to change the process outcome, so that a full cache disk does not turn a successful command into a failed execution.
60. As a user, I want Artifact Status returned separately, so that incomplete or failed persistence is visible.
61. As a user, I want one opaque Artifact identity per Execution Request, so that stdout and stderr belong to one diagnostic object.
62. As an agent, I want `system_output` to read a bounded Output Page from either stream, so that large output can be inspected without flooding context.
63. As an agent, I want UTF-8 and base64 Output Page encodings, so that text is convenient and arbitrary bytes remain lossless.
64. As an agent, I want byte offsets, `nextOffset`, and `eof`, so that Artifact pagination is deterministic.
65. As a user, I want only Published Artifacts readable, so that partially written output is never mistaken for a complete result.
66. As a user, I want Artifacts stored in a user-private managed cache, so that repositories are not polluted.
67. As a user, I want Artifact retention and disk quotas enforced, so that command output cannot consume unbounded storage.
68. As a user, I want Artifact age fixed from publication rather than extended by reads, so that sensitive output expires predictably.
69. As a user, I want expired and absent Artifact identities to return `ARTIFACT_NOT_FOUND`, so that cleanup behavior remains simple.
70. As a user running Codex and DSH simultaneously, I want multiple Server processes to share the Artifact cache safely, so that concurrent use does not corrupt output.
71. As a user, I want old incomplete spools recovered after crashes, so that temporary files do not accumulate indefinitely.
72. As an administrator, I want a maximum concurrent execution count, so that agents cannot create unbounded processes.
73. As an agent, I want concurrency overflow rejected immediately by default, so that host and command timeouts are not obscured by an implicit queue.
74. As a user, I want a concurrency slot held until termination, output collection, and Artifact publication finish, so that the limit reflects real resource use.
75. As a user, I want spawn failures to consume the same bounded execution capacity, so that repeated failed launches cannot bypass limits.
76. As a user, I want each Execution Request to own the Process Tree members contained by its Lifecycle Adapter, so that timeout and cancellation do not leave contained descendant workers running.
77. As a user, I want the first timeout, cancellation, or shutdown event to become the sole Termination Reason, so that the result is unambiguous.
78. As a user, I want timeout and cancellation mutually exclusive, so that one execution has one terminal cause.
79. As a user, I want graceful tree termination before forced termination, so that programs can flush output and clean temporary state.
80. As an administrator, I want bounded Grace Period and final termination waits, so that cleanup cannot hang forever.
81. As a user, I want a structured Termination Outcome, so that I know whether force was required and whether tree cleanup was confirmed.
82. As a user, I want normal completion to report `treeCleaned: null`, so that the Server does not claim to track deliberately detached daemons.
83. As a Windows user, I want a validated Lifecycle Adapter that cleans contained `.exe` and `.cmd` process members, so that package-manager and test-runner timeouts are reliable.
84. As a macOS user, I want the Unix Lifecycle Adapter validated with process groups and descendant fixtures, so that termination works through wrappers.
85. As a maintainer, I want the Windows mechanism selected through a blocking prototype comparing Job Objects, `taskkill`, and mature process-tree libraries, so that the implementation decision is evidence-based.
86. As a maintainer, I want Windows and Unix Lifecycle Adapters behind the same Command Runtime interface, so that platform differences do not leak to callers.
87. As a host, I want Server shutdown to cancel active executions in parallel within an overall deadline, so that closing Codex or DSH does not orphan processes or hang indefinitely.
88. As a maintainer, I want `CommandRuntime.close()` to be idempotent, so that transport close, signals, and error paths can converge safely.
89. As a caller, I want new work rejected with `RUNTIME_CLOSING` after shutdown begins, so that teardown has a clear state transition.
90. As a user, I want `system_environment` to report Server version, mode, platform, architecture, Roots, effective execution path, capabilities, limits, and Registered Programs, so that host differences are diagnosable.
91. As a security-conscious user, I want `system_environment` and Diagnostic Reports to omit environment values and command arguments, so that secrets are not exposed.
92. As a user, I want actual executable paths visible, so that I can compare Codex and DSH resolution.
93. As a user, I want an `init` command that discovers common development programs and generates a Program Manifest, so that stable setup does not require hand-authoring JSON.
94. As a user, I want `init` to output Codex and DSH configuration snippets without editing host files automatically, so that I can review changes.
95. As an automation author, I want `init --yes` and explicit flags, so that setup is repeatable without prompts.
96. As a user, I want `init` to refuse to overwrite an existing Manifest unless explicitly forced, so that configuration is not destroyed accidentally.
97. As a user, I want `doctor` to validate Manifest syntax, Roots, Program Candidates, executable permissions, environment references, and effective limits, so that failures are found before host startup.
98. As an automation author, I want `doctor` exit codes to distinguish runnable configuration from invocation errors, so that CI can gate deployment.
99. As a user, I want `doctor --execute` to run only explicit Execution Probes, so that diagnostics do not execute arbitrary defaults.
100. As a user, I want Core Program probes run by default and Optional Program probes only with `--all`, so that routine diagnosis stays bounded.
101. As a configuration author, I want Execution Probes to declare accepted exit codes, so that program-specific normal outcomes are represented correctly.
102. As a user, I want probes excluded from normal Server startup, so that MCP initialization remains side-effect free.
103. As a Codex user, I want an official `AGENTS.md` guidance snippet, so that the model prefers `system_exec` for direct invocations.
104. As a DSH user, I want an official prompt or preset snippet, so that DSH follows the same tool-responsibility split.
105. As a DSH operator, I want official configuration to fail startup when this required MCP cannot connect or synchronize tools, so that missing capability is not silent.
106. As a DSH operator, I want bounded automatic reconnect behavior documented, so that crash loops terminate rather than restart forever.
107. As a Codex user, I want a fixed Managed Installation and absolute Server entry point, so that startup does not download or change package versions.
108. As a user, I want only stdio transport supported in this scope, so that local execution does not expose a network listener.
109. As a maintainer, I want stable tool names and compatible Schema evolution, so that Host Guidance and tool history remain valid.
110. As a maintainer, I want a staged pre-1.0 evolution path, so that necessary contract corrections can land before interfaces freeze.
111. As a maintainer, I want one Command Runtime test seam, so that execution behavior is tested once rather than duplicated across MCP and CLI adapters.
112. As a maintainer, I want small MCP and CLI adapter tests, so that translation to the Command Runtime contract is verified without repeating lifecycle tests.
113. As a maintainer, I want real Codex and DSH integration tests on Windows x64 and macOS arm64, so that support means more than MCP SDK compatibility.
114. As a maintainer, I want Canonical Results compared across hosts rather than rendered prose, so that host-specific projection does not create false failures.
115. As a maintainer, I want deterministic integration tests in CI and model tool-selection checks as a release evaluation, so that nondeterministic model behavior does not destabilize routine CI.
116. As a product owner, I want direct-program model selection to reach at least 90% in the agreed evaluation set, so that the MCP is actually used for its intended work.
117. As a maintainer, I want cold-start, invocation-overhead, diagnosis, and registration performance gates, so that determinism does not make host startup unacceptably slow.
118. As a maintainer, I want Automatic Discovery Mode to capture one startup Environment Snapshot, so that behavior remains stable during one Server lifetime.
119. As an existing user, I want the legacy CLI invocation retained with a deprecation notice before 1.0, so that configuration migration is gradual.
120. As a user, I want Server logs written only to stderr and never stdout, so that stdio MCP framing cannot be corrupted.
121. As a user, I want logs to exclude Argument Vectors, Execution Input, environment values, and output content, so that diagnostics do not duplicate sensitive data.

## Implementation Decisions

1. MCP is the shared execution interface for Codex and DSH. A DSH-native execution adapter is not part of this solution.
2. The product supports finite, non-interactive, foreground program execution. Shell composition, interactive TTY, background jobs, and daemon supervision remain host responsibilities.
3. The primary internal seam is a deep Command Runtime with four operations: inspect the Environment Snapshot, execute an Execution Request, read an Output Page, and close the runtime. MCP and management CLI behavior are adapters over this seam.
4. The Server continues to use `system_exec` and `system_environment`; `system_output` is added with Execution Artifacts. Public tool names do not carry version suffixes.
5. Stable deployments use Configured Mode with a strict, versioned JSON Program Manifest. Explicit Manifest failure prevents startup. Automatic Discovery Mode remains backward-compatible and makes no cross-host consistency guarantee.
6. Program Configuration is shared by Codex and DSH. Host Authorization is supplied separately through startup Working Directory Roots.
7. Configured Mode requires at least one explicit Root. Automatic Discovery Mode may default to the startup cwd. Single-Root requests may use relative cwd; multi-Root requests require absolute cwd.
8. Roots are resolved physically, normalized, deduplicated, and stripped of redundant nested roots. Requests revalidate Root and cwd existence and containment. Root Identity replacement detection is used where the platform supports it.
9. Manifest v1 contains execution defaults, Program definitions, common search paths, optional PATHEXT, Environment Layers, and platform overrides. Unknown fields and empty Candidate arrays are invalid.
10. Platform overrides shallow-merge objects by key and replace arrays. Program definitions merge by Logical Program name and then by Program field. `enabled: false` disables an Optional Program on a platform; disabling a Core Program is invalid.
11. Logical Program names use a short stable identifier format. The Manifest may register arbitrary user programs; it does not enforce subcommand or argument allowlists.
12. Program Candidates are strings representing an absolute path, `~/` path, explicit Manifest-relative path, or bare PATH name. Arbitrary shell-style environment expansion is not supported.
13. Candidate resolution retains the Declared Candidate and resolves a real executable path at startup. Program identity does not automatically change during a Server lifetime.
14. The effective search path is platform search paths followed by common search paths, then inherited PATH only when explicitly enabled. Declaration order is authoritative and the first normalized path wins.
15. Configured Mode defaults `allowInheritedPath` to false. Initialization records selected executable directories and platform base directories and may include both an absolute Candidate and a PATH-name fallback.
16. Automatic Discovery Mode exposes the fixed non-Shell set `git`, `node`, `npm`, `pnpm`, `yarn`, `bun`, `python`, and `ripgrep` when available. `python` tries `python3` then `python`; `ripgrep` resolves `rg`.
17. Shells are not registered automatically. Configured Mode may explicitly register a Shell as a Logical Program, but Host Guidance recommends the host shell for Shell semantics.
18. The Execution Environment is captured at startup and is used for both registration and every child process. Windows environment-key lookup is case-insensitive.
19. Environment Layers apply in this order: startup environment; normalized PATH/PATHEXT; global removals; global assignments; Program removals; Program assignments. Assignments in a layer win over removals in the same layer.
20. Environment assignments support literal values and Environment References. Missing required references prevent startup; missing optional references remove the target variable.
21. Program Policy supports default and maximum timeout, Execution Input permission, and Artifact Policy. It does not inspect arguments or authorize operations.
22. The Server hard timeout maximum is ten minutes. Program and global timeout policies may lower the effective maximum. Request timeout must fit the effective Program Policy.
23. Execution Input is optional UTF-8, defaults absent, is bounded to 1 MiB, is available only to Programs that explicitly allow it, and is written once before stdin closes.
24. Argument Vectors reject NUL, allow at most 4,096 arguments, limit one argument to 64 KiB UTF-8, and limit the aggregate to 256 KiB UTF-8.
25. The public direct-program contract remains `program + args[]`; the Server never accepts a caller-controlled shell command string. Native executables receive literal arguments; Windows `.cmd` and `.bat` Platform Wrappers require cmd.exe launching and therefore reparse arguments rather than providing the same arbitrary literal-argument guarantee.
26. A process that starts successfully always resolves to an Execution Result, including nonzero exit, timeout, and cancellation. Invalid requests, start failures, pipe failures, and internal-state failures are tool errors.
27. Timeout, cancellation, and Server shutdown compete atomically; the first observed event becomes the sole Termination Reason. `timedOut` and `cancelled` are mutually exclusive.
28. Every Execution Request owns the lifecycle of Process Tree members contained by its Lifecycle Adapter. Lifecycle Adapters first request graceful contained-member termination, wait a configurable Grace Period, force termination, then wait a bounded final interval.
29. Default Grace Period is two seconds and default final termination wait is five seconds; both are Manifest-configurable within hard limits. Server shutdown has a separate default overall deadline of fifteen seconds.
30. Windows lifecycle behavior is blocked on a prototype comparing Job Objects, `taskkill`, and mature process-tree libraries. Unix uses an isolated process group and group signals, validated on macOS with the shared descendant-process fixture.
31. Termination Outcome reports whether termination was requested, its reason, whether force was used, whether contained-member cleanup was confirmed, and any cleanup error. Normal completion has `treeCleaned: null` and does not claim to track deliberately escaped descendants.
32. Concurrency defaults to four active execution attempts with immediate rejection on overflow. The slot covers spawn, process lifetime, termination, stream collection, and Artifact publication.
33. The MCP does not serialize work by cwd and does not implement argument-level safety policy.
34. Inline Output defaults to 256 KiB head and 768 KiB tail per stream, with a configurable total and an 8 MiB hard maximum. `text` remains and contains the head/tail projection with an omission marker when truncated.
35. Output accounting is byte-based. Inline text is UTF-8, truncation aligns retained excerpt boundaries where possible, and lossy decoding is reported. Execution Artifacts retain raw bytes.
36. Artifact Policy is `never`, `on-truncation`, or `always`, defaulting to `on-truncation`. Policies that may publish full output spool both streams from process start.
37. An Execution Artifact represents one completed Execution Request and contains stdout and stderr streams. It is published atomically only after execution completes.
38. Artifact persistence uses a user-private managed cache, opaque high-entropy IDs, versioned metadata, per-stream execution limits, total cache limits, fixed retention, oldest-first cleanup, and stale-spool recovery.
39. Default Artifact retention is 24 hours, total cache maximum is 1 GiB, and execution maximum is 100 MiB per stream. Reaching a persistence limit does not terminate or alter the process result.
40. `system_output` pages raw bytes using a byte offset and supports UTF-8 and base64 projections. Default page size is 64 KiB and hard maximum is 1 MiB.
41. Artifact persistence failures and incomplete output are represented by Artifact Status and do not become Execution Terminal State failures.
42. The Canonical Result includes Logical Program, exit status, stream projections and byte accounting, timeout/cancellation state, input byte count, process duration, Termination Outcome, and Artifact Status. It excludes Argument Vector and cwd.
43. `system_environment` exposes version, mode, platform, architecture, Roots, effective path/PATHEXT, capabilities, limits, Registered Program executable resolution, required state, Program Policy, and environment-variable names affected by configuration. It never returns secret values or the full inherited environment.
44. MCP tool errors use structured error data when preserved by the SDK and hosts, with a stable `CODE: message` textual fallback.
45. The management CLI introduces `serve`, `init`, and `doctor`, while retaining the legacy direct `--root` invocation with a pre-1.0 deprecation warning.
46. `init` detects the fixed common development-program set, constructs a deterministic Manifest, lets interactive users choose Core Programs, defaults all detected programs to Optional under `--yes`, emits Codex and DSH snippets, and does not edit host configuration files.
47. `doctor` performs static validation by default. `doctor --execute` runs only explicit Execution Probes, defaults to Core Programs, and uses accepted exit-code sets. Probes never run during Server startup.
48. `doctor` exits zero for runnable configuration even with Optional warnings, one for an unusable configuration/environment, and two for invalid CLI invocation.
49. `CommandRuntime.close()` is idempotent. Runtime Closing cancels active work in parallel, rejects new execution and output reads, waits within the shutdown deadline, and releases resources.
50. stdio is the only transport in this scope. All logs go to stderr. Logs and Artifact metadata exclude arguments, stdin, environment values, and process output.
51. Official Host Guidance and tool descriptions use the same responsibility split. DSH configuration sets startup failure to fatal and uses bounded reconnect. Codex recovery beyond a new session is host behavior, not a Server guarantee.
52. The implementation remains usable on Linux through the Unix Lifecycle Adapter, but Linux is not a release hard gate. macOS Intel is best effort.
53. Public Schema may make deliberate compatibility corrections before 1.0. After 1.0, minor releases only add optional fields or otherwise preserve semantics.
54. The current source is expected to become an Authoritative Package separate from the Skillshare Integration. Repository ownership, package scope, license, and other non-implementation governance are intentionally deferred.

## Testing Decisions

1. The highest and primary test seam is the Command Runtime. Tests exercise its public behavior through Environment Snapshot inspection, Execution Request completion, Output Page reads, and idempotent close. Tests do not reach through this interface to assert private classes, timers, buffer layouts, spawn options, or filesystem implementation choices.
2. The existing program-registry and execution tests provide prior art for literal argument passing, PATH/PATHEXT resolution, output retention, timeout reporting, and stdio MCP invocation. They should be evolved upward toward Command Runtime contract tests rather than multiplied across internal modules.
3. MCP adapter tests verify tool discovery, input/output Schema, argument translation, Canonical Result projection, error translation, `isError` behavior, cancellation propagation, and stable public tool names. They do not duplicate Process Tree or Artifact behavior already covered through Command Runtime.
4. CLI adapter tests verify subcommand parsing, legacy invocation compatibility, deterministic snippets, JSON reporting, exit codes, and the guarantee that protocol stdout remains uncontaminated.
5. Manifest contract tests cover strict versioned validation, unknown fields, empty Candidates, shallow object merge, array replacement, platform enable/disable semantics, relative/home/PATH Candidate resolution, Environment References, Core/Optional behavior, deterministic search order, and Shadowed Candidate diagnostics.
6. Execution Environment tests prove that registration and child processes use the same PATH/PATHEXT and Environment Layers, including a shebang or Platform Wrapper that launches another configured executable.
7. Host Authorization tests cover single and multiple Roots, default and absolute cwd behavior, nonexistent cwd, physical containment, symlink escape, duplicate/nested normalization, Root disappearance, and Root Identity replacement when the platform supports it.
8. Argument and input tests cover spaces, Unicode, quote characters, shell metacharacters, Windows paths, NUL rejection, count and byte limits, allowed/forbidden Execution Input, input closure, and absence of sensitive values from logs and metadata.
9. Execution Terminal State tests cover zero and nonzero exits, signals, timeout, cancellation, simultaneous terminal events, spawn failure, stream failure, and the distinction between Execution Results and tool errors.
10. Process Tree tests use a shared fixture that creates descendants through native executables and wrappers. The contract asserts graceful termination, force escalation, contained-member cleanup reporting, bounded return, and no surviving tracked descendants.
11. The Windows Lifecycle Adapter mechanism is chosen by a prototype, not assumed. The prototype must compare Job Objects, `taskkill`, and mature libraries under Node 20 and the latest LTS, including `.exe`, `.cmd`, grandchildren, permission failure, and forced termination.
12. The Unix Lifecycle Adapter is validated on real macOS arm64 with independent process groups, wrappers, grandchildren, SIGTERM, SIGKILL, and concurrent timeout/cancellation races. Linux runs the same suite as a compatibility check.
13. Inline Output tests cover head/tail projection, omission accounting, exact limits, empty streams, very small limits, chunk boundaries, UTF-8 boundaries, invalid UTF-8, and simultaneous large stdout/stderr.
14. Artifact tests cover all three policies, complete spooling from process start, deletion of unneeded spools, atomic publication, per-stream limits, persistence failure, version mismatch, multiple concurrent Server processes, stale-spool recovery, oldest-first cleanup, fixed expiry, and absent/expired identity errors.
15. Output Page tests verify byte offsets, pagination, UTF-8/base64 projection, invalid UTF-8 signaling, page limits, stream selection, eof behavior, and attempts to read before publication or during Runtime Closing.
16. Concurrency tests prove immediate overflow rejection, slot ownership through cleanup/publication, spawn-failure accounting, and release after every terminal path.
17. Shutdown tests prove idempotent close, parallel cancellation, overall deadline, rejection of new work, Artifact and stream cleanup, and convergence of transport-close, signal, and error paths.
18. `init` and `doctor` tests use controlled environment fixtures rather than the developer machine. They verify no automatic host-file edits, overwrite protection, deterministic Manifest generation, Core/Optional selection, probe scoping and accepted exit codes, secret redaction, and documented exit codes.
19. Real Codex and DSH deterministic integration tests run on Windows x64 and macOS arm64. They verify Server startup, MCP discovery, tool names, direct calls, Canonical Result retention, timeout coordination, DSH fatal startup behavior, and DSH reconnect without duplicate registrations.
20. Cross-host comparison is made at the Canonical Result level. Model-visible text projection only needs to preserve the critical execution information and may differ by host.
21. Model Selection Evaluation is a release assessment rather than a normal CI gate. The agreed direct-program scenario set should choose `system_exec` at least 90% of the time; explicit shell-composition controls should select the host shell.
22. Release performance checks initially target Server cold start through tool discovery under two seconds, p95 MCP overhead for an empty program under 100 ms, static `doctor` under two seconds, and registration of 100 Programs under two seconds.
23. Node.js tests cover the minimum supported LTS line and the latest LTS. The hard platform-host matrix is Windows x64 plus Codex/DSH and macOS arm64 plus Codex/DSH.
24. Tests must verify that stderr logging never contaminates MCP stdout and that arguments, Execution Input, environment values, and output content are absent from Server logs and Artifact metadata.

## Out of Scope

- Shell command strings, pipelines, redirection, command substitution, wildcard expansion, environment expansion, or shell built-ins.
- Interactive TTY sessions, password prompts, terminal menus, streaming stdin, or bidirectional terminal emulation.
- Background jobs, long-running watchers, development servers, incremental live-log reading, or daemon supervision.
- A DSH-native execution implementation; DSH consumes the same MCP interface as Codex.
- Filesystem isolation of invoked programs. Working Directory Roots constrain cwd selection, not all file access.
- Containerization, virtual machines, low-privilege account provisioning, network isolation, or a general untrusted-code sandbox.
- Argument-level allowlists, subcommand authorization, write-operation classification, or network-operation classification.
- Automatic program hash pinning, executable attestation, or supply-chain verification.
- Automatic editing of Codex or DSH configuration files.
- Dynamic Program registration, Manifest watching, PATH watching, or `tools/list_changed` behavior during one Server lifetime.
- Streamable HTTP or any network-listening transport.
- Automatic package update or version-check networking.
- Built-in telemetry.
- Formal Linux support as a release gate and formal macOS Intel support.
- Repository ownership, npm scope, license, contribution policy, security-reporting process, release authorization, and other project-governance choices.

## Further Notes

- The authoritative language is recorded in `CONTEXT.md`. In particular, Working Directory Root must not be described as a sandbox, a nonzero exit must not be described as a tool error, and a shell command string is not part of an Execution Request.
- The accepted ADRs establish MCP as the shared host interface, Configured Mode's Execution Environment as authoritative, process outcomes as structured results, and Process Trees as one lifecycle.
- The current code already demonstrates literal arguments with `shell: false`, PATH/PATHEXT resolution, Root containment, output-tail bounding, timeout reporting, and stdio MCP integration. The implementation should deepen this behavior behind the Command Runtime rather than layering parallel paths around it.
- The current source lives inside the Skillshare skills repository. The implementation plan must include a history-preserving separation into an Authoritative Package, but the destination repository and package identity are deferred.
- The Windows Lifecycle Adapter prototype is a blocking implementation decision. The behavior contract is complete even though the platform mechanism is intentionally undecided.
- The current local `npm test` attempt could not rebuild `dist` because the execution sandbox denied writes outside the active workspace. This is an environment limitation of the planning session, not evidence of a project test failure.
