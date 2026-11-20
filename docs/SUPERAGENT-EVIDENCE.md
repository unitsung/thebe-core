# Superagent engineering evidence

Reviewed 2026-11-20. These sources inform Core's Superagent pilot and its
acceptance criteria. The domain model follows ADR 0003. [ADR 0003](adr/0003-dsh-superagent-domain.md)

## Primary sources and Core implications

- **Ticket and Assignment.** DSH gives a Ticket a succession of Assignments.
  On host restart it ends running Assignments and starts replacements with a
  recovery note that directs the Executor to inspect external state before
  repeating an action. Waiting and review states can survive the restart.
  Core's restart criterion is a stable Ticket identity, preserved history and
  at most one active Assignment, with deliberate pauses and stops respected.
  [DSH domain](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/001-domain.md)
  [DSH execution and restart](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/003-execution.md#restart)

- **Execution recovery.** Mastra 1.84 introduces experimental incremental
  storage for durable and evented execution. Its release notes distinguish
  broker redelivery from recovery initiated by the host, with ownership checks
  for the latter. For Core, persist the pilot's action intent before dispatch
  and record its reconciled outcome separately. Verify recovery at the actual
  write boundary. [Mastra 1.84 release](https://github.com/mastra-ai/mastra/releases/tag/@mastra%2Fcore@1.84.0)

- **Approval and uncertain writes.** OpenAI's SDK guide describes persisting a
  server-owned approval snapshot and atomically consuming an authorized
  decision. It calls out the need to reconcile uncertain external effects
  before recovery. Core should bind approval to the exact recorded intent and
  recheck authority before dispatch. If an interrupted write cannot be verified
  or safely retried, retain an uncertain Report and wait for the person.
  [OpenAI human-in-the-loop guide](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)

- **Evidence and correlation.** A preprint compares identical executions
  through different views. Tool aggregation and delegation caused judgment
  transport failures of about 31% in the reported experiments. Restoring
  provenance recovered 85.5% of failures. In Core, link a concise Report to
  its original provider receipt, read-back evidence or Artifact. Allow an
  inconclusive verdict when observability is insufficient. Keep stable
  Ticket, Assignment and operation identifiers across process lifetimes.
  OpenTelemetry supports linking spans across traces and treats tool arguments
  and results as opt-in data. [Verification Transport](https://arxiv.org/abs/2611.18471)
  [OpenTelemetry span links](https://opentelemetry.io/docs/specs/otel/trace/api/#specifying-links)
  [GenAI tool conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/execute-tool.md)

- **Skill quality and delegation.** In a controlled preprint covering 13
  enterprise procedures, coordinated arms used 1.4–4.7 times the tokens and
  2.6–5.8 times the latency of the single-agent arm. High-quality Skills
  improved the observed success rate from 67.4% to 73.1%, while the targeted
  multi-agent redesign reached 75.6%. Aggregate differences were generally
  inconclusive. The Agent Skills format permits a version under optional
  metadata. Record the pilot's Skill version or content digest, permissions and
  completion checks with the benchmark. Run the same cases, tools and model
  for each execution mode. [Architecture evaluation](https://arxiv.org/abs/2611.12953)
  [Agent Skills specification](https://agentskills.io/specification)

## Core pilot acceptance

Use one existing NAS workflow across the checks below. The existing
`AcquisitionJob` is a candidate because it copies files to the library, checks
the destination and searches the media library after scanning. Its current
name-based check is weaker than exact write evidence, and jobs restored after
restart require explicit advancement. [Job runner](../src/agent/pipeline/job-runner.ts)
[Pipeline advancer](../src/agent/pipeline/advancer.ts)

| Scenario                                              | Observable outcome                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Process stops after dispatch and before the receipt   | On restart, read-back or a provider receipt proves the desired state, and recovery finishes without a second write.                        |
| The provider cannot prove whether the write landed    | An uncertain Report links the available evidence and the Ticket waits for a person. An automatic retry requires evidence that it is safe.  |
| Approval is pending when Core restarts                | The decision remains tied to the same intent. Duplicate decisions cannot dispatch another write, and a stopped Ticket stays stopped.       |
| The operator inspects a final Report                  | A Ticket and Assignment can be linked to approval, dispatch and read-back records. Missing evidence yields an inconclusive verdict.        |
| Single- and multi-Executor runs use the same fixtures | Record verified success, unsupported success claims, duplicate mutations, elapsed time and token use. Production defaults to one Executor. |
