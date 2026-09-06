# Node kind → scaffold choice

Default technology per `NodeKind` when generating a runnable project. These
are starting points, not requirements — if the source doc names a specific
product ("Postgres", "Kafka", "Redis"), use that instead. This table is
about code generation only; it's deliberately separate from
`src/content/vendors/*.ts`, which prices real cloud SKUs for the simulator's
cost model and has no opinion on what to scaffold.

Kinds not listed under "own process" become a library call or middleware in
the service they modify — see the fallback rule at the bottom.

| `NodeKind`     | Represents                  | Default scaffold choice                                                                                                           |
| -------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `client`       | The traffic source          | A load-testing/smoke-test script, not a service                                                                                   |
| `lb`           | Load balancer               | nginx or Caddy reverse-proxy config                                                                                               |
| `service`      | An application server       | Minimal HTTP server (Node/Express, or the doc's dominant language)                                                                |
| `cache`        | In-memory cache             | Redis via compose, or an in-memory LRU stub for a teaching-scale example                                                          |
| `db`           | Primary datastore           | Postgres via compose, with a seed script                                                                                          |
| `queue`        | Work queue                  | Redis-backed list, or a documented in-process stub                                                                                |
| `worker`       | Queue consumer              | A small process that polls/subscribes the paired `queue`/`streambroker`                                                           |
| `autoscaler`   | Scaling controller          | A comment/README note on the service it targets — not a process; this app has no orchestrator to actually scale                   |
| `region`       | Multi-region/failover       | Two instances of the fronted service behind the `lb`, plus a README note on the failover story                                    |
| `cdn`          | Edge cache                  | A README note plus a `Cache-Control` header on the origin service; not its own process                                            |
| `ratelimiter`  | Request throttling          | Middleware in the service it guards                                                                                               |
| `breaker`      | Circuit breaker             | Middleware/library call in the service it guards (e.g. a simple failure-rate breaker)                                             |
| `replica`      | Read replica                | A second `db` instance in compose, wired read-only                                                                                |
| `shard`        | Horizontal partition        | A README note on the partitioning scheme; one `db` instance per shard only if the doc specifies a shard count worth materializing |
| `objectstore`  | Blob storage                | MinIO via compose (S3-compatible), or a local-disk stub                                                                           |
| `searchindex`  | Search index                | A minimal in-process inverted-index stub, or Meilisearch/Elasticsearch via compose if the doc names one                           |
| `timeseriesdb` | Time-series storage         | Postgres with a simple time-bucketed table, unless the doc names a specific TSDB                                                  |
| `graphdb`      | Graph storage               | An in-memory adjacency-list stub, unless the doc names a specific graph DB                                                        |
| `coldstorage`  | Archival storage            | A local-disk stub with a README note on the access-latency trade-off it represents                                                |
| `vectordb`     | Vector/embedding store      | An in-memory stub with a documented similarity search, unless the doc names a real one                                            |
| `streambroker` | Event stream (Kafka-like)   | Redis Streams via compose, or a documented in-process stub                                                                        |
| `pubsub`       | Publish/subscribe           | Redis Pub/Sub via compose, or a documented in-process stub                                                                        |
| `websocket`    | Realtime connection         | A small WebSocket server (e.g. `ws` for Node)                                                                                     |
| `apigateway`   | API gateway                 | Same as `lb`: nginx/Caddy config, or a thin routing proxy service                                                                 |
| `sidecar`      | Per-instance helper process | A second process in the same compose service, sharing its network namespace                                                       |
| `lambda`       | Serverless function         | A small handler function plus a local invoke script (no real FaaS runtime needed)                                                 |
| `cron`         | Scheduled job               | A script plus a documented cron entry or `docker-compose` scheduled-run comment                                                   |
| `bulkhead`     | Isolated resource pool      | A bounded connection-pool/semaphore in the service it protects                                                                    |
| `retryqueue`   | Deferred retry              | A dead-letter list beside the `queue`/`streambroker` it retries from                                                              |
| `transcoder`   | Media processing            | A small worker invoking a documented CLI (e.g. ffmpeg) on files from the paired `objectstore`                                     |
| `edgecompute`  | Edge function               | Same shape as `lambda`, with a README note on where it'd actually run at the edge                                                 |
| `writebehind`  | Async write-back cache      | The `cache` in front of a `db`, plus a background flush worker                                                                    |
| `loadshedder`  | Overload protection         | Middleware in the service it guards (reject beyond a documented threshold)                                                        |

## Fallback rule

A kind not worth its own process becomes a documented code-level concern
(middleware, a config block, a README note) of the node it modifies, rather
than an empty scaffold whose only content is its own name.
