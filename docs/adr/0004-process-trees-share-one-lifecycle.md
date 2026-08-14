# Process trees share one lifecycle

Each Execution Request owns the invoked process and all descendants as one Process Tree. Timeout, cancellation, and Server shutdown first request graceful tree termination, then force termination after a bounded Grace Period, and return a structured Termination Outcome; platform-specific Lifecycle Adapters may differ, with the Windows mechanism selected by a blocking prototype.
