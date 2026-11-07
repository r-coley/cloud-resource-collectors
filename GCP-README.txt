GCP resource collection — Python 0.3

Install
Python 3.11+; follow README.md for virtual environment and pip installation.

Offline example (no cloud credentials or network)
cloud-collect --cloud gcp --config examples/gcp-service.config.json \
  --inventory examples/gcp-service.inventory.json --output runs/gcp-offline.json
cloud-demo also writes synthetic JSON and HTML reports under runs/demo/.

Live collection
Uses google-auth Application Default Credentials (ADC), independently of the
active gcloud login/project. For a local test: gcloud auth application-default login.
Workload and service-account ADC are also supported. config.account / --identity
is an optional expected email check, not a gcloud account selector; credentials
that do not expose a verifiable identity fail that check. IDs and immutable numbers
for every requested project are verified before resource collection. No API is
enabled and no role or project setting is changed.

Copy examples/gcp-service.config.json to a *.local.json file and replace the
synthetic project scopes and credentials/profile references before collecting:
cloud-collect --cloud gcp --config scopes.local.json --output runs/gcp-resources.json

Output is one cloud-inventory/1.0.0 JSON document, including all observed resources
in scope, optional service memberships, facts, relationships, source evidence and
collection coverage. Existing files are never overwritten. Files use owner-only
permissions; runs/ and *.local.json are excluded from Git. Known sensitive fields
are filtered, but exports can still contain confidential configuration.

Exit 0 = selected queries complete (visibility unverified); 2 = partial JSON saved;
1 = configuration, credentials, scope, validation or output error. No query success
establishes tested resilience. Live provider integration has not yet been verified.

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
have at most four attempts with bounded waits. SDK authentication and transport are used. Requests
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
python -m pytest
Offline fixtures, injected API responses and SDK request-shape checks are tested.
No live cloud project is queried by the tests. Neo4j integration runs in CI.
