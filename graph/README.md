# Resource graph import and resilience queries

Import one or more `cloud-inventory/1.0.0` JSON files into Neo4j, then query projects
for placement, recovery, availability, backup and routing evidence. The importer and
query utility live in this repository alongside the collectors. Collection itself
does not need a running database.

## Start a local database

Requires Node.js 22+, the repository dependencies, and either Docker Compose v2 or
an existing Neo4j 5.26+ installation. The included Compose file starts Neo4j Community
with its default `neo4j` database and a persistent data volume, listening on localhost.

From the repository root:

```sh
npm ci
npm run demo
export NEO4J_PASSWORD='choose-your-local-password'
docker compose -f graph/compose.yaml up -d --wait
```

The password must be valid for Neo4j (at least eight characters for the standard
installation). Choose the password before first startup; changing this environment
variable later does not change the password in an existing database volume.

If using an existing installation or Neo4j Aura, configure its connection instead:

```sh
export NEO4J_URI='neo4j+s://YOUR_DATABASE_HOST'
export NEO4J_USERNAME='neo4j'
export NEO4J_PASSWORD='YOUR_EXISTING_PASSWORD'
export NEO4J_DATABASE='neo4j'
```

The defaults are `bolt://127.0.0.1:7687`, username `neo4j`, database `neo4j`; a password
is always required. Credentials are read from environment variables, not command-line
password arguments or resource JSON. The utility does not provision hosted databases.
Compose creates the local default database; `init` creates the graph constraints/indexes.

## Import collected JSON

```sh
node bin/cloud-graph.js init
node bin/cloud-graph.js import \
  --input runs/demo/azure/cloud-inventory.json \
  --input runs/demo/aws/cloud-inventory.json \
  --input runs/demo/gcp/cloud-inventory.json
```

Use the same command with the JSON files written by `bin/cloud-collect.js` for live
projects. It does not call cloud APIs. Each import reports `imported` or
`already-imported`. Repeat `--input` for additional files, up to 256 MiB per file.

All input files are read and validated before opening the database connection.
Every snapshot's data is imported in one transaction; a failed snapshot rolls back
completely. A multi-file batch commits successful snapshots individually, so a later
database failure does not roll back earlier files. Re-running resumes safely.

The import command ensures constraints and indexes exist, so its identity needs the
corresponding Neo4j schema and write permissions. Query commands only read data.
No APOC plugins or enterprise features are required. Using a dedicated inventory
database avoids mixing this model with unrelated application graphs.

## Query projects

```sh
node bin/cloud-graph.js projects
node bin/cloud-graph.js projects --cloud gcp --limit 5000
```

Each row identifies a project/scope observation, snapshot ID, collection time, origin,
selection criteria, resource count and incomplete/unverified query counts. A project
means an Azure subscription, AWS account or GCP project, with region/resource-group
selection recorded separately. Synthetic examples are explicitly labelled.

Copy a project ID or the full `project` scope ID from that output:

```sh
node bin/cloud-graph.js resources --project YOUR_PROJECT_ID
node bin/cloud-graph.js resilience --project YOUR_PROJECT_ID
```

Use `--cloud` to disambiguate cloud IDs. By default, the utility selects the latest
**collection time**, not the last import time. If the project has multiple collection
selectors or origins, it requires an explicit `--snapshot` instead of guessing which
scope or synthetic/live dataset you intended.

```sh
node bin/cloud-graph.js resilience \
  --project YOUR_PROJECT_ID --snapshot YOUR_IMPORTED_SNAPSHOT_ID
node bin/cloud-graph.js resources \
  --project YOUR_PROJECT_ID --snapshot YOUR_IMPORTED_SNAPSHOT_ID --kind database
```

The default resource/reference result limit is 1000; use `--limit` up to 5000. Resource
results report their total matching count and truncation. The resilience view reports
resource/reference truncation and flags when service gaps may be truncated. A limited
view must not be interpreted as a complete assessment.

The resilience view returns configuration evidence under six categories:

- Configured placement, including explicit unknown placement.
- Automatic recovery and scaling settings.
- Database availability and replication settings.
- Backup and point-in-time recovery settings.
- Health checks and routing configuration.
- Reservation/allocation configuration.

Facts retain `observed` versus `unknown`, values, source pointers and evidence IDs.
A recorded `false` setting remains false. Category status `evidence-recorded` means
there is configuration to inspect, not that the design passes a resilience test.
The overall view says `requires-review`. Missing configuration, unsupported types,
partial collection and unverified permissions cannot be treated as protection.
This first utility exposes evidence; it is not yet the pattern assessment/simulation engine.

## Inspect supporting evidence

```sh
node bin/cloud-graph.js evidence \
  --snapshot YOUR_IMPORTED_SNAPSHOT_ID --evidence-id evidence-0
```

This returns the filtered source record, collection source/status and observation time.
Output is JSON; redirect a query to a file if needed. Raw collected configuration may
be confidential despite filtering, so use the database's normal access controls.

Neo4j Browser is available at `http://127.0.0.1:7474` with the local Compose setup.
The reusable Cypher files in [queries/](queries/) can also be run there. Project-scoped
query files accept `$projectObservationId`, which comes from the project listing.

Example graph visualization after setting that parameter in Neo4j Browser:

```cypher
MATCH (r:ResourceObservation)-[:IN_PROJECT]->(p:ProjectObservation {id:$projectObservationId})
OPTIONAL MATCH (r)-[e:CONFIGURATION_REFERENCE|CONTAINED_BY]->(target:ResourceObservation)
RETURN r, e, target LIMIT 200
```

These are configured relationships, not verified application traffic paths.

## Graph model and history

```text
Snapshot ──HAS_PROJECT──> ProjectObservation ──OF_PROJECT──> Project
    │                           ↑
    ├──HAS_RESOURCE──> ResourceObservation ──OF_RESOURCE──> Resource
    │                           │
    │                           ├──HAS_FACT──> Fact ──SUPPORTED_BY──> Evidence
    │                           └──HAS_REFERENCE──> ConfigurationReference
    │                                                  ├──TARGETS──> ResourceObservation
    │                                                  └──POINTS_TO──> UnresolvedTarget
    └──HAS_SERVICE──> ServiceObservation ──HAS_MEMBER──> ResourceObservation
```

Resources and projects have stable identities. Their observations, facts, evidence,
collections, memberships, gaps and configuration references are scoped to snapshots.
Service membership and containment remain separate from configuration dependencies.
Nested provider values are retained as JSON strings; scalar facts also have typed
properties for custom Cypher queries. Unknown values are never coerced to zero/false.

The importer uses a canonical payload fingerprint to detect changed content under
an existing snapshot ID. Reordered object keys do not cause a conflict. Conflicting
content or a different graph-model version under the same ID is rejected. Concurrent
imports of the same snapshot serialize and do not create duplicate observations.

Unresolved targets are `UnresolvedTarget` nodes, not invented observed resources.
Partial scans remain partial. No resources, observations or history are deleted by
this utility. A newer snapshot that omits a resource does not prove deletion. Historical
queries always identify a particular snapshot; there is no mutable global "current"
resource state assembled from different scans.

## Test and stop

```sh
npm test
docker compose -f graph/compose.yaml stop
```

Unit tests run without Neo4j. CI also starts an ephemeral Neo4j Community database
and tests imports of all three clouds, queries, repeat/concurrent imports, payload
conflicts, historical/partial snapshots and transaction rollback. To run those tests
locally against a dedicated test database:

```sh
export NEO4J_TEST_URI='bolt://127.0.0.1:7687'
export NEO4J_TEST_PASSWORD="$NEO4J_PASSWORD"
node --test tests/graph-neo4j.test.js
```

The integration test inserts synthetic snapshots; use a test database. It does not
query real cloud projects. `stop` retains the local data volume for the next run.

Official implementation references: [Neo4j driver transactions](https://neo4j.com/docs/javascript-manual/current/transactions/)
and [property uniqueness constraints](https://neo4j.com/docs/cypher-manual/current/schema/constraints/create-constraints/).
