AZURE resource collection — Python 0.3

Install
Python 3.11+; follow README.md for virtual environment and pip installation.

Offline example (no cloud credentials or network)
cloud-collect --cloud azure --config examples/azure-service.config.json \
  --inventory examples/azure-service.inventory.json --output runs/azure-offline.json
cloud-demo also writes synthetic JSON and HTML reports under runs/demo/.

Live collection
Uses azure-identity DefaultAzureCredential with the official Resource Graph SDK.
Existing environment, workload, managed identity or Azure CLI credentials can be
used. For local testing, sign in to the intended tenant with az login beforehand.
All subscriptions must be accessible through the same credential. The command
does not log in, assign roles, or change resources. Successful queries can still
have incomplete visibility; permission coverage remains unverified.

Copy examples/azure-service.config.json to a *.local.json file and replace the
synthetic project scopes and credentials/profile references before collecting:
cloud-collect --cloud azure --config scopes.local.json --output runs/azure-resources.json

Output is one cloud-inventory/1.0.0 JSON document, including all observed resources
in scope, optional service memberships, facts, relationships, source evidence and
collection coverage. Existing files are never overwritten. Files use owner-only
permissions; runs/ and *.local.json are excluded from Git. Known sensitive fields
are filtered, but exports can still contain confidential configuration.

Exit 0 = selected queries complete (visibility unverified); 2 = partial JSON saved;
1 = configuration, credentials, scope, validation or output error. No query success
establishes tested resilience. Live provider integration has not yet been verified.

Collected information
Resources and ResourceContainers are queried through the public-cloud Resource
Graph SDK, with explicit subscription scope, deterministic ID ordering,
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


Verification
python -m pytest
Offline fixtures, injected API responses and SDK request-shape checks are tested.
No live cloud project is queried by the tests. Neo4j integration runs in CI.
