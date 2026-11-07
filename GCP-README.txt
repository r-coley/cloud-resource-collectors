GCP service service discovery — initial connector

Purpose
Query explicitly selected GCP projects and export the same cloud-inventory/1.0.0
JSON as Azure and AWS. The connector uses official Google APIs with the existing
gcloud authentication context. No Fix Inventory, Cartography, cloud deployment or
graph database runtime is required. No upstream source code was copied.

Offline example (no gcloud, credentials or cloud calls)
Requires Node.js 22+ and the existing validator installed by npm ci.
From the project root, select a new output directory:

node gcp-discover.js \
  --config examples/gcp-service.config.json \
  --inventory examples/gcp-service.inventory.json \
  --output /tmp/gcp-service-discovery

Open /tmp/gcp-service-report.html. The synthetic example covers payments
in London and Belgium with regional managed groups, desired counts 6/2, eight VM
observations, auto-healing policies, probes/backends, reservations and Cloud SQL
regional HA plus a cross-region read replica. DEMO-SERVICE-B includes an unsupported
Cloud Run asset; DEMO-SERVICE-C has no visible labelled resources. It demonstrates
observations and gaps, not actual service infrastructure or a resilience verdict.
After running npm run demo, review the example at:
runs/demo/gcp/report.html

Live collection (not exercised against a GCP project)
Use gcloud already signed in to an identity allowed to read the intended projects.
Optionally set config.account to an existing gcloud account. No login, API enablement,
role creation or project setting is performed by this command. It obtains a token
with gcloud auth print-access-token and sends it only to the four fixed Google API
hosts used by the connector. Tokens and provider error bodies are not saved.
The current ambient gcloud project is not used to select collection scope.

Copy gcp-service.config.json to gcp-service.local.json. Replace synthetic
project IDs/numbers, selected regions and service catalogue. Each project number
is optional in config; the collector retrieves and records the immutable number
and verifies it if supplied. A project ID/number mismatch aborts before resource
collection. Project IDs and numbers for all requested projects are checked first.
Only public GCP endpoints are supported in this version.

mkdir -p runs
node gcp-discover.js \
  --config gcp-service.local.json \
  --output runs/NEW_GCP_RUN

Output directory must not already exist. The first version accepts up to 1000
explicit projects per run. Larger estates can be partitioned into explicit batches;
organization/folder discovery and automatic scheduling are not implemented.

Service labels
AWS-style uppercase catalogue values are not silently imposed on GCP labels.
serviceLabelKey defaults to service_id; matching is exact and case-sensitive.
serviceLabelValues explicitly maps values, for example:
  "demo-service-a": "DEMO-SERVICE-A"
The observed label remains unchanged in resource.tags. The canonical catalogue ID
is used only for service membership. Unmapped values remain visible as separate
service IDs. Project labels are not inherited onto resources. Untagged managers,
policies and routing dependencies can be associated through observed references
and managed-instance membership. Depth/count limits remain explicit gaps.

Collection scope
Project-wide aggregated API queries collect zonal/regional resources; results are
filtered to configured regions before retention. Global resources and resources
with unknown location remain eligible. Some unsupported multi-region assets may
be outside the selected regional filter. Scope selectors retain the chosen regions.
Cloud Asset Inventory supplements direct APIs and can expose unsupported asset
metadata. It may lag configuration. Numeric and textual project aliases reconcile
into a single resource key, preserving original observations in evidence.

Initial APIs and facts
- Cloud Resource Manager: project ID/number and project metadata.
- Cloud Asset Inventory: paginated RESOURCE assets scoped to each project number.
- Compute Engine: instances, regional/zonal managed group managers, instance groups,
  autoscalers, instance templates, networks/subnets and reservations.
- Load balancing: regional/global backend services, forwarding rules, URL maps,
  HTTP/HTTPS target proxies and health checks.
- Managed group membership: listManagedInstances for supported managers. This is
  the documented read-only POST operation; its state observations are separate
  collector-context nodes, not fabricated provider deployment resources.
- Cloud SQL: instance configuration, region/zone, availability type, replica links,
  configured backups/PITR/retention and tier where returned.
All list operations explicitly follow nextPageToken. Compute unreachables and
provider warnings make coverage partial; NO_RESULTS_ON_PAGE alone does not.
Repeated tokens, invalid response shapes, denied reads and the 1000-page limit
are recorded. Requests time out after 30 seconds; selected transient HTTP statuses
have at most four attempts with bounded waits. Redirects are rejected. Requests
are sequential in this first version.

Permissions and enabled APIs
The identity needs permission to read project metadata, Compute configuration,
Cloud SQL instances and Cloud Asset resource inventory. In particular:
resourcemanager.projects.get, cloudasset.assets.listResource,
cloudsql.instances.list, and the Compute list permissions for the resource types
above, plus compute.instanceGroupManagers.get for managed-instance membership.
Existing Compute Viewer, Cloud SQL Viewer and Cloud Asset Viewer roles can be
reviewed as starting points; this is not a claim of a minimal custom role. Enabled
Compute, SQL Admin, Cloud Asset and Resource Manager APIs are prerequisites. A 403
may reflect access restrictions or a disabled API; the tool does not change either.
Successful queries never establish complete permission coverage.

Outputs and status
cloud-inventory.json: schema- and evidence-validated estate export.
gcp-inventory.json: filtered observations for reproducible offline processing.
services/00001.json etc.: validated per-service snapshots with scoped evidence.
report.html: standalone review with collection statuses, facts and gaps.
Exit 0: selected queries complete (permission coverage unverified).
Exit 2: partial/missing/denied/warned queries, reviewable output retained.
Exit 1: invalid input, project mismatch, authentication, validation or output failure.
Run files/directories are owner-only; live runs and *.local.json are excluded from
Git. Metadata, environment variables, startup script fields and known credential
keys are filtered. Arbitrary labels/configuration can still be confidential.
No secret payloads, application traffic or customer data APIs are queried.

Not established by this collector
Target size is not throughput. A declared multi-zone distribution is not proof of
healthy placement. A Cloud SQL cross-region read replica is not assumed to provide
automatic regional failover. Backup settings are not a successful restore test.
No RTO/RPO guarantees, quota headroom, reserved capacity guarantee, application
workflow or automatic simulation readiness is inferred.

Not yet covered in detail
GKE workloads, Cloud Run topology/configuration, Spanner/Firestore, Pub/Sub,
Storage protection and backup jobs, IAM/reachability, network endpoint group member
lists, legacy HTTP health checks/target pools, TCP/SSL proxies and live backend
health. Unsupported Asset Inventory records remain uninterpreted. APIs not queried
remain explicit limitations. Managed membership pagination follows provider tokens;
it does not change a group's listManagedInstancesResults setting.
Graph database ingestion and assessment are separate consumers of the JSON contract.

Verification
npm test
Tests inject synthetic API responses: >1000 instance pagination, project identity,
partial/unreachable regions, throttling/403, repeated tokens, region filtering,
read-only membership POST, exact labels, ID/number deduplication, source filtering,
missing collections, evidence validation and offline per-service export.
No live GCP project has been scanned.

Official references reviewed 7 November 2026
https://cloud.google.com/compute/docs/reference/rest/v1/instanceGroupManagers/aggregatedList
https://cloud.google.com/compute/docs/reference/rest/v1/instanceGroupManagers/listManagedInstances
https://cloud.google.com/compute/docs/reference/rest/v1/backendServices/aggregatedList
https://cloud.google.com/sql/docs/mysql/admin-api/rest/v1/instances/list
https://cloud.google.com/asset-inventory/docs/list-assets
