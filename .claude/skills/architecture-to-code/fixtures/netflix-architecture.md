# Streaming playback path (a Netflix-style architecture)

A hand-written description of the request path for starting playback on a
video-streaming service, used to test the architecture-to-code skill. This
is written from general knowledge of how such systems are commonly
described, not copied from any internal source, and not checked against
this app's own built-in example of the same system before the skill runs
against it — the two are meant to be compared afterward, not matched
beforehand.

## Components

**Edge delivery network.** Video segments are served from edge caches
distributed close to users, so most playback requests never reach the
company's own datacenters at all.

**API gateway.** Every client request that does need to reach the backend
(sign-in, "what's next", starting a new title) first hits a gateway that
routes it to the right internal service and enforces per-client rate
limits.

**Circuit breaker.** Calls from the gateway to backend services are wrapped
in a circuit breaker: if a downstream service's error rate crosses a
threshold, the breaker trips and the gateway fails fast instead of piling
up timeouts.

**Playback API service.** The core service that decides what to actually
stream: it resolves a title and a user's entitlements into a manifest of
video segments and a CDN URL to fetch them from.

**Recommendations service.** A separate service, called from the client
alongside playback but not on its critical path, that ranks titles for the
home screen. It sits behind a bulkhead so a slow recommendations call can
never exhaust the connection pool the playback path depends on.

**User/session store.** A database holding accounts, entitlements and
resume-position state, read on nearly every request.

**Encoding farm.** Off the request path entirely: a fleet of workers that
transcodes newly uploaded source video into the many resolutions and
codecs the edge network serves, pulling jobs from a queue.

**Metadata/telemetry pipeline.** Playback events (started, paused,
buffered, stopped) are published to a stream and consumed asynchronously
for analytics and to feed the recommendations pipeline.

## Traffic

1. Client → edge delivery network, for the video bytes themselves. This is
   the overwhelming majority of traffic and rarely touches anything below.
2. Client → API gateway, for anything that isn't raw video bytes.
3. API gateway → circuit breaker → playback API service, to resolve a
   manifest.
4. API gateway → circuit breaker → recommendations service (via a
   bulkhead), for the home screen — a separate call, not on the playback
   critical path.
5. Playback API service → user/session store, to check entitlements and
   resume position.
6. Playback API service → metadata/telemetry pipeline, publishing a
   playback-started event.
7. Encoding farm workers pull from an upload queue, independent of the
   read path above, and their output lands in the storage the edge network
   serves from.
