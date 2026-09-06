# Vocabulary → NodeKind

Step 2 (Analyze) maps whatever an architecture doc or diagram calls a
component onto one of the 34 kinds in `NodeKind` (`src/sim/types.ts:1`).
Most real docs don't use this project's names — they say "Kafka" or "Consul"
or "Stripe" — so this is the lookup table from common system-design and
real-product vocabulary to the kind that actually matches its queueing
behavior, and the label that keeps the real name visible on the node.

This table exists because AGENTS.md sets a real bar for adding a new kind
(step 7 of "Adding a component": "a test proving it behaves differently
from every existing kind"), and almost everything below clears that bar by
being _approximated well_, not by getting its own kind. Reach for step 3 of
`SKILL.md` ("When no existing kind fits") only for the rare case this table
doesn't cover and no row below is a reasonable fit.

Default labels (what a node gets if you don't rename it) are in
`DEFAULT_LABEL` in `src/sim/presets.ts` — the "Label" column below is what
to set instead when the doc names something more specific, so the real
product/pattern name survives onto the canvas.

## Traffic entry and routing

| Doc says                                            | `NodeKind`    | Label           | Note                                                                                            |
| --------------------------------------------------- | ------------- | --------------- | ----------------------------------------------------------------------------------------------- |
| Load balancer, L4/L7 LB, HAProxy                    | `lb`          | —               |                                                                                                 |
| Reverse proxy, ingress controller, Nginx as a proxy | `lb`          | "Reverse Proxy" |                                                                                                 |
| API gateway, Kong, Apigee, Zuul, Envoy gateway      | `apigateway`  | —               |                                                                                                 |
| Service mesh ingress gateway                        | `apigateway`  | "Mesh Ingress"  |                                                                                                 |
| CDN, Akamai, Cloudflare, Fastly                     | `cdn`         | —               |                                                                                                 |
| Edge function, Cloudflare Worker, Lambda@Edge       | `edgecompute` | —               |                                                                                                 |
| DNS                                                 | _(none)_      | —               | Resolved once per connection, not per request; note it in the README instead of drawing a node. |

## Compute

| Doc says                                                                | `NodeKind`        | Label      | Note                                                                              |
| ----------------------------------------------------------------------- | ----------------- | ---------- | --------------------------------------------------------------------------------- |
| Application server, microservice, backend service                       | `service`         | —          |                                                                                   |
| Monolith                                                                | `service`         | "Monolith" | One node, sized for the whole app's traffic.                                      |
| Queue consumer, background processor                                    | `worker`          | —          |                                                                                   |
| Serverless function, AWS Lambda, Cloud Function, Azure Function         | `lambda`          | —          |                                                                                   |
| Scheduled job, cron, batch job                                          | `cron`            | —          |                                                                                   |
| Sidecar proxy, Envoy/Linkerd data-plane proxy                           | `sidecar`         | —          |                                                                                   |
| Service mesh control plane (Istio control plane, Linkerd control plane) | _(none)_          | —          | Doesn't carry request traffic; a control note on the `sidecar`, not its own node. |
| ETL / batch pipeline                                                    | `cron` + `worker` | —          | The trigger and the processing are two nodes, same as any queue + worker pair.    |

## Storage

| Doc says                                                                                       | `NodeKind`      | Label                  | Note                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------- | --------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relational DB, Postgres, MySQL, primary datastore                                              | `db`            | —                      |                                                                                                                                                                                                     |
| NoSQL, document DB, key-value store, DynamoDB, MongoDB, Cassandra                              | `db`            | —                      | Kind is about queueing shape, not the data model.                                                                                                                                                   |
| Cache, Redis, Memcached                                                                        | `cache`         | —                      |                                                                                                                                                                                                     |
| Read replica                                                                                   | `replica`       | —                      |                                                                                                                                                                                                     |
| Horizontally partitioned store, sharded DB                                                     | `shard`         | —                      |                                                                                                                                                                                                     |
| Object storage, S3, blob storage                                                               | `objectstore`   | —                      |                                                                                                                                                                                                     |
| Full-text search, Elasticsearch, Meilisearch, Algolia                                          | `searchindex`   | —                      |                                                                                                                                                                                                     |
| Time-series DB, Prometheus storage, InfluxDB                                                   | `timeseriesdb`  | —                      |                                                                                                                                                                                                     |
| Graph database, Neo4j                                                                          | `graphdb`       | —                      |                                                                                                                                                                                                     |
| Archive tier, Glacier, cold storage                                                            | `coldstorage`   | —                      |                                                                                                                                                                                                     |
| Vector database, embeddings store, Pinecone, pgvector                                          | `vectordb`      | —                      |                                                                                                                                                                                                     |
| Write-behind cache, async-flush cache                                                          | `writebehind`   | —                      |                                                                                                                                                                                                     |
| Data warehouse, OLAP store, analytics DB                                                       | `db`            | "Data Warehouse"       | Tune `serviceMs` up and `capacity` down to reflect scan-heavy queries rather than adding a kind.                                                                                                    |
| Session store                                                                                  | `cache` or `db` | "Session Store"        | Whichever the doc implies for durability.                                                                                                                                                           |
| Distributed lock / coordination service, Zookeeper, etcd (used for locking or leader election) | `db`            | "Coordination Service" | `db.config.lockMs` already models per-write lock contention (`src/sim/behaviour-store.ts`) — this is what a lock/coordination service's cost actually looks like in the simulation, not a new kind. |

## Messaging

| Doc says                                                 | `NodeKind`                 | Label | Note                                                                                            |
| -------------------------------------------------------- | -------------------------- | ----- | ----------------------------------------------------------------------------------------------- |
| Message queue, SQS, RabbitMQ (queue mode)                | `queue`                    | —     |                                                                                                 |
| Event stream, Kafka, Kinesis, replayable log             | `streambroker`             | —     |                                                                                                 |
| Publish/subscribe, SNS, fan-out topic                    | `pubsub`                   | —     |                                                                                                 |
| Realtime connection, WebSocket server, Socket.IO gateway | `websocket`                | —     |                                                                                                 |
| Dead-letter queue, retry-with-backoff queue              | `retryqueue`               | —     |                                                                                                 |
| Event bus                                                | `pubsub` or `streambroker` | —     | `pubsub` if it's fan-out delivery, `streambroker` if consumers replay/read at their own offset. |

## Resilience and control

| Doc says                                            | `NodeKind`           | Label              | Note                                                                                                      |
| --------------------------------------------------- | -------------------- | ------------------ | --------------------------------------------------------------------------------------------------------- |
| Rate limiter, throttling middleware                 | `ratelimiter`        | —                  |                                                                                                           |
| Circuit breaker, Hystrix, resilience4j breaker      | `breaker`            | —                  |                                                                                                           |
| Bulkhead, isolated connection pool                  | `bulkhead`           | —                  |                                                                                                           |
| Load shedder, priority-based admission control      | `loadshedder`        | —                  |                                                                                                           |
| Autoscaler, HPA, scaling policy                     | `autoscaler`         | —                  | Control edge to the node it scales, not a traffic path — see `SimEdge.control`.                           |
| Multi-region, active-active, failover pair          | `region`             | —                  |                                                                                                           |
| Service discovery, service registry, Consul, Eureka | `cache`              | "Service Registry" | A per-call discovery lookup behaves like a fast, high-hit-rate cache read, not a distinct queueing shape. |
| Feature flag service, config service, LaunchDarkly  | `cache` or `service` | "Feature Flags"    | `cache` if it's a read-through lookup; `service` if the doc implies real backend logic.                   |
| Firewall, WAF                                       | `ratelimiter`        | "WAF"              | Rejects a fraction of requests before they reach anything downstream — same shape as a rate limiter.      |

## Often-external dependencies

These are usually drawn as one box even though they're somebody else's whole
system. Model them as a `service` the way you'd model any dependency you
don't control: real name in the label, config skewed toward the latency and
error rate the doc implies (or a documented guess if it doesn't say).

| Doc says                                               | `NodeKind`                  | Label                 |
| ------------------------------------------------------ | --------------------------- | --------------------- |
| Identity provider, OAuth/SSO, Auth0, Okta              | `service`                   | "Identity Provider"   |
| Payment gateway, Stripe, PayPal                        | `service`                   | "Payment Gateway"     |
| Notification service, email/SMS/push, SendGrid, Twilio | `worker` (behind a `queue`) | "Notification Worker" |
| Media transcoding, encoding farm, ffmpeg workers       | `transcoder`                | —                     |

## Not modeled as a node

Common in a real diagram, but not part of the request path a simulation
measures. Say so in the generated README rather than adding a node that
would sit at 0% utilization forever (`AGENTS.md`: "A component with no
meaningful value for a metric shows something else, or nothing. Never a
plausible-looking number.").

- **Logging / metrics / observability pipeline** (Datadog, Prometheus scrape, ELK, log shipping) — asynchronous and off the critical path in essentially every real system.
- **DNS** — resolved once per connection, not per request.
- **CI/CD, deployment pipeline** — not a runtime component at all.
- **VPN, firewall rules as network policy** (as opposed to a WAF actually rejecting traffic — see above) — infrastructure, not a request-path hop.
- **Container orchestrator control plane** (Kubernetes control plane, not the pods it schedules) — doesn't carry request traffic.
