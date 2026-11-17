# Architecture Decision Records (ADRs)

Short notes on important decisions: what we chose, why, and what we rejected.
New ADRs: use the `write-adr` skill. Never edit an accepted ADR's decision — write a new one that supersedes it.

| #    | Decision                                                                           | Status   |
| ---- | ---------------------------------------------------------------------------------- | -------- |
| 0001 | [Stack](0001-stack.md)                                                             | accepted |
| 0002 | [Model choice and swappable model layer](0002-model-layer.md)                      | accepted |
| 0003 | [libSQL client as the SQLite driver](0003-libsql-driver.md)                        | accepted |
| 0004 | [The agent layer may use the database](0004-agent-owns-conversation.md)            | accepted |
| 0005 | [Tracing with Langfuse behind an observer interface](0005-tracing.md)              | accepted |
| 0006 | [Frozen system prompt; changing context as messages](0006-frozen-system-prompt.md) | accepted |
