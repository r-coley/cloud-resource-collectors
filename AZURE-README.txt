Azure service service discovery — first collector

Purpose
Read visible Azure configuration once per subscription and assemble evidence-backed
service snapshots using the serviceId resource tag. No cloud resources are changed.
This is an initial full-scan collector, not a deployed estate-wide service.
It does not yet incrementally refresh, enrich from provider-specific APIs, assess
patterns or import directly into the simulator.

Try the synthetic example (no Azure account or network required)
From the project root, choose a NEW output directory:

node azure-discover.js \
  --config examples/azure-service.config.json \
  --inventory examples/azure-service.inventory.json \
  --output /tmp/service-discovery-demo

Open /tmp/service-discovery-demo/report.html. The fixture contains payments across
UK South and UK West, a balance service using shared compute, and a catalogue entry
with no visible tagged resources. Those are synthetic examples, not real service
resources. A scale set declaring multiple zones does not prove instance distribution.

Live collection
Requires Node.js 22 or later and Azure CLI installed and already signed in to the
intended Azure tenant. No login, new role assignment or cloud deployment is performed
by this command. The signed-in identity needs permission to read the resources in
each configured subscription. Partial access can produce incomplete successful
queries: permission completeness remains unverified even when pagination completes.

Copy the example config to service.local.json and replace subscriptions
and services with the intended subscription UUIDs and service catalogue entries.
serviceTagKey defaults to serviceId and is configurable. A catalogue lists objects
with id and name; tagged IDs absent from the catalogue remain visible separately.
All selected subscriptions must be accessible through the same tenant sign-in.

node azure-discover.js \
  --config service.local.json \
  --output runs/NEW_RUN_NAME

Create the runs parent directory first. The NEW_RUN_NAME directory must
not exist. Every run creates new output; it never overwrites an earlier snapshot.
Exit 0 = queries collected (permissions still unverified), 2 = partial collection
with outputs retained, 1 = configuration/authentication/output failure. A failed
subscription query does not imply its resources were deleted.

Outputs
estate.json: common discovery model, service memberships, observed settings,
relationships, collection coverage and source evidence.
services/00001.json etc.: per-service snapshots with their source observations.
report.html: searchable, standalone local review report.

Evidence is a redacted Resource Graph projection, not an untouched provider export.
Known credential-bearing fields are redacted and tokens are never saved. Treat
outputs as confidential configuration: field redaction is not a complete data-loss
prevention system. Generated runs and *.local.json are excluded from Git. File
permissions default to owner-only. Do not use provider listKeys/listSecrets actions.
No application/customer data or Key Vault secret values are requested.

Collected information
Resources and ResourceContainers are queried through the public-cloud Resource
Graph API 2024-04-01, with explicit subscription scope, deterministic ID ordering,
1000-record pages and continuation tokens. Throttling/transient responses have
bounded retries; forbidden queries, repeated tokens and unpageable truncation
produce partial coverage. A scan is an interval, not an atomic point-in-time view.

First field mappings cover VM/VMSS placement, declared instance count, repair
policy, Spot priority and reservation association; autoscale profiles; load balancer
and application gateway configuration; Traffic Manager/Front Door fields; SQL zone
redundancy, failover groups and retention policies; capacity reservations; selected
AKS/App Service/storage/key-management configuration. Unsupported resource types
are retained as uninterpreted. Missing settings are unknown, never defaulted to
healthy, disabled, zero capacity or proof that a capability is absent.

Relationships
Tag matching uses case-insensitive tag keys and exact service ID values. Ownership
is never inherited from a resource group or parent. Explicit ARM references and
child-resource containment retain their source paths. Incoming scaling, replication
and backup policies are associated with referenced resources. Outgoing traversal
is bounded by depth and count; it does not walk every shared resource's consumers.
Inline subresource references can resolve to an inventoried resource ancestor,
which is explicitly distinguished from an exact match. Unresolved references and
unseen catalogue services remain visible.

What's deliberately not inferred
Transaction capacity from instance count; active/standby roles from region names;
application request paths from arbitrary references; actual zone instance spread;
backup restore success from retention configuration; guaranteed allocation from a
reservation association; runtime readiness or proven RTO/RPO from configuration.
No discovered snapshot is simulation-ready until an architect confirms those inputs.
AKS workload topology, data-plane dependencies, quota/available reservation balance,
provider enrichment APIs and runtime telemetry need subsequent collectors.

Architecture direction
Keep provider-specific collection separate from the common discovery model, graph
relationships, architect annotations and assessment/simulation. AWS Workload
Discovery is a useful architectural reference for inventory plus API enrichment,
relationship graphs and diagram views. It is discontinued/archived; no code from
that repository is incorporated in this implementation.

Verification
Run npm test. Discovery tests use mocked network responses and
synthetic configuration, including 1001-record pagination, throttling, forbidden
scope, truncation, shared dependencies, escaping and grouping 4000 services.
Live Azure integration has not been exercised against a tenant.

Official references reviewed 7 November 2026
https://learn.microsoft.com/en-us/rest/api/azureresourcegraph/resourcegraph/resources/resources?view=rest-azureresourcegraph-resourcegraph-2024-04-01
https://learn.microsoft.com/en-us/azure/governance/resource-graph/concepts/paging-results
https://learn.microsoft.com/en-us/azure/governance/resource-graph/overview
https://learn.microsoft.com/en-us/rest/api/compute/virtual-machine-scale-sets/get
https://learn.microsoft.com/en-us/rest/api/monitor/autoscale-settings/get?view=rest-monitor-2022-10-01
https://learn.microsoft.com/en-us/rest/api/sql/failover-groups/get?view=rest-sql-2023-08-01
https://github.com/aws-solutions/workload-discovery-on-aws

Cloud-neutral export (1.0.0)
The CLI now also writes cloud-inventory.json. See CONTRACT.txt and
cloud-inventory.schema.json. A synthetic export is checked in as
examples/azure-service.cloud-inventory.json. This is separate from simulator
architecture JSON; discovery alone never marks a model simulation-ready.
See AZURE-REUSE.txt for the selected upstream code references and remaining gaps.

AWS equivalent
See AWS-README.txt for the AWS connector, offline service example, exact API scope,
existing AWS CLI authentication and read-only permission example. It produces the
same neutral JSON contract; no upstream discovery platform is needed.

GCP collection
See GCP-README.txt for explicit-project GCP collection, label-to-catalogue mapping,
source coverage and the synthetic service example. Azure, AWS and GCP now have
initial independent producers of cloud-inventory/1.0.0. None has been live verified.
