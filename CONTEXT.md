# System Command Execution

This context provides Codex and DSH with one cross-platform interface for invoking finite, non-interactive development programs on Windows and macOS. It standardizes program identity, literal argument passing, working-directory policy, execution lifecycle, and results without emulating a shell or claiming filesystem isolation.

## Language

**Logical Program**:
A stable, platform-independent program identity exposed to agents, such as `git`, `python`, or `ripgrep`; it resolves to one executable on the current machine.
_Avoid_: Command, tool, binary

**Registered Program**:
A Logical Program that resolved to an executable in the Server's startup environment and is available for execution.
_Avoid_: Installed command, detected tool

**Execution Request**:
A request to invoke one Registered Program with literal arguments, an allowed working directory, and a finite timeout.
_Avoid_: Shell command, command string

**Execution Result**:
The structured outcome of an Execution Request, including process status, separate output streams, truncation state, timeout state, and cancellation state.
_Avoid_: Terminal output, command response

**Working Directory Root**:
The directory tree within which an Execution Request may select its working directory. It limits where a process starts, not which files that process can access.
_Avoid_: Sandbox, security root, workspace jail

**Core Program**:
A Logical Program required by a configured installation; if it cannot be registered, the Server is unavailable.
_Avoid_: Required command

**Optional Program**:
A Logical Program exposed only when it can be registered on the current machine.
_Avoid_: Best-effort command

**Execution Environment**:
The authoritative startup snapshot used both to register programs and to run them, so discovery and child-process behavior do not depend on differences between host launch environments.
_Avoid_: Shell environment, inherited environment

**Program Manifest**:
The recommended, versioned declaration of Logical Programs, platform-specific candidate locations, required availability, search paths, and controlled environment changes shared by Codex and DSH.
_Avoid_: Command config, PATH config

**Program Candidate**:
An absolute path, home-relative path, Manifest-relative path, or PATH name that may resolve a Logical Program to an executable on the current platform.
_Avoid_: Alias, fallback command

**Program Configuration**:
The shared Program Manifest content that gives Codex and DSH the same program identities and Execution Environment; each host may authorize different Working Directory Roots.
_Avoid_: MCP config, workspace config

**Execution Terminal State**:
A completed, nonzero, timed-out, or cancelled process outcome represented as an Execution Result rather than as a protocol failure.
_Avoid_: Tool error, command failure

**Execution Artifact**:
A controlled, short-lived user-level representation of output too large for the inline Execution Result; the inline result refers to it by opaque identity while retaining bounded diagnostic excerpts.
_Avoid_: Log file, spill file

**Host Authorization**:
The Working Directory Roots and tool-call limits a particular Codex or DSH deployment grants to the Server independently of the shared Program Configuration.
_Avoid_: Program config, Manifest permissions

**Automatic Discovery Mode**:
The backward-compatible, zero-configuration mode that registers programs found in the inherited environment without promising cross-host identity.
_Avoid_: Default manifest, stable mode

**Configured Mode**:
The recommended deployment mode in which an explicit Program Manifest defines program identity and the Execution Environment; invalid configuration prevents Server startup rather than silently falling back.
_Avoid_: Production mode, strict mode

**Diagnostic Report**:
A human- or machine-readable assessment of whether configuration and environment can start the Server, with optional explicit execution probes and no secret values.
_Avoid_: Health check, environment dump

**Output Page**:
A bounded byte range read from one stream of an Execution Artifact through its opaque identity.
_Avoid_: File read, log chunk

**Termination Reason**:
The single event that first moves a running Execution Request into termination: timeout, cancellation, or Server shutdown. Competing later events do not change it.
_Avoid_: Kill reason, failure reason

**Termination Outcome**:
The structured account of whether graceful termination was requested, force was required, and the process tree was confirmed cleaned.
_Avoid_: Exit status, kill result

**Grace Period**:
The bounded interval allowed for a process tree to exit after a graceful termination request before forced termination begins.
_Avoid_: Timeout, shutdown delay

**Process Tree**:
The invoked process and every descendant it creates during an Execution Request, treated as one lifecycle for termination purposes.
_Avoid_: Child process, job

**Inline Output**:
The bounded, UTF-8 diagnostic projection of one process stream containing retained head and tail excerpts when the complete byte stream is too large.
_Avoid_: Full output, terminal buffer

**Execution Input**:
An optional bounded UTF-8 payload written once to a process's standard input and then closed; a Logical Program must explicitly allow it, and its content is never logged or echoed.
_Avoid_: Terminal input, stdin stream

**Program Policy**:
The execution defaults attached to a Logical Program, such as timeout bounds and whether Execution Input is accepted; it does not inspect or authorize particular subcommands or arguments.
_Avoid_: Command allowlist, security policy

**Environment Reference**:
A Program Manifest value that obtains a variable from the Server's startup environment by exact name without shell expansion or storing the referenced secret in the Manifest.
_Avoid_: Environment expansion, secret value

**Platform Wrapper**:
A script or launcher such as a Windows `.cmd` file that represents a Logical Program and may require platform runtime handling even though callers still provide a program and literal argument array rather than a shell command string.
_Avoid_: Shell command, native executable

**Argument Vector**:
The bounded ordered list of literal strings supplied to a Registered Program; it excludes NUL characters and is never copied into Server logs or Execution Artifact metadata.
_Avoid_: Command line, command string

**Canonical Result**:
The MCP structured representation of an Execution Result that remains consistent across Codex and DSH even when each host projects it differently into model-visible text.
_Avoid_: Host output, rendered result

**Host Guidance**:
The host-specific instructions that assign direct single-program invocation to `system_exec`, shell composition to the host shell, and filesystem operations to host filesystem tools.
_Avoid_: Tool description, execution policy

**Support Matrix**:
The host, operating-system, architecture, and Node.js combinations whose deterministic integration tests gate a release.
_Avoid_: Compatibility list, test platforms

**Model Selection Evaluation**:
A release-time behavioral assessment of whether an agent chooses `system_exec` for direct program invocations and the host shell for tasks that genuinely require shell semantics.
_Avoid_: Integration test, tool test

**Authoritative Package**:
The single versioned npm package containing the Server implementation; Skillshare distributes and configures fixed installations of it rather than maintaining another source copy.
_Avoid_: Skill copy, bundled implementation

**Managed Installation**:
A fixed package version and absolute Server entry point referenced by Codex and DSH without downloading or resolving packages at host startup.
_Avoid_: npx invocation, PATH install

**Shadowed Candidate**:
A valid Program Candidate that was not selected because an earlier Candidate or search-path entry resolved the same Logical Program.
_Avoid_: Duplicate program, unused executable

**Artifact Policy**:
The Program Policy choice controlling whether complete process streams are persisted never, only when Inline Output truncates, or for every execution.
_Avoid_: Logging policy, output mode

**Skillshare Integration**:
The consumption layer that installs a Managed Installation, presents setup guidance, and references templates generated by the Authoritative Package without owning a second implementation.
_Avoid_: Package source, implementation mirror

**Lifecycle Adapter**:
The platform-specific implementation that enforces the shared Process Tree termination contract on Windows or Unix without changing the Execution Request interface.
_Avoid_: Process manager, platform policy

**Published Artifact**:
A completed Execution Artifact made visible by opaque identity only after its Execution Request finishes; temporary output under construction is not readable.
_Avoid_: Live log, running artifact

**Release Gate**:
A deterministic Support Matrix, lifecycle, security, compatibility, and performance requirement that must pass before the Authoritative Package is published.
_Avoid_: Checklist, manual test

**Environment Layer**:
A global or Program-specific set of variable removals and assignments applied in a defined order to the Execution Environment; assignments may use literal values or Environment References.
_Avoid_: Environment map, shell environment

**Declared Candidate**:
The Program Candidate text recorded in the Program Manifest before home, relative-path, PATH, or symbolic-link resolution.
_Avoid_: Executable path, resolved program

**Command Runtime**:
The deep module that owns the Environment Snapshot, program execution, Output Page reads, resource limits, Process Tree lifecycle, and shutdown behind one interface used by MCP and management commands.
_Avoid_: MCP Server, command service

**Artifact Status**:
The structured result of attempting to persist and publish an Execution Artifact, independent of the process's Execution Terminal State.
_Avoid_: Output error, execution failure

**Artifact Spool**:
The unpublished temporary byte storage written from process start when Artifact Policy may retain complete output; it is either atomically published after completion or deleted.
_Avoid_: Live Artifact, output file

**Runtime Closing**:
The Command Runtime state in which active Execution Requests are being cancelled within a shared shutdown deadline and no new execution or output-read work is accepted.
_Avoid_: Server stopped, process exit

**Execution Probe**:
An optional bounded argument vector and accepted-exit-code set used only by an explicit Diagnostic Report execution pass to assess a Registered Program.
_Avoid_: Startup check, health command

**Root Identity**:
The platform-specific identity of an authorized Working Directory Root captured at startup, when available, to detect replacement of the directory object at the same path.
_Avoid_: Root path, real path
