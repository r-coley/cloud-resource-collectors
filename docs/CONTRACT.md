# Cloud-neutral discovery contract — version 1.0.0

## Purpose

An immutable observation of cloud configuration, consumable without installing
Fix Inventory, Cartography or a graph database. This is an inventory interchange
contract, not the architecture/simulation design schema. Initial Azure, AWS and
GCP connectors produce this format. Their live cloud integration has not yet
been verified.

## Files

cloud-inventory.schema.json: strict JSON Schema draft-07 structural contract.
examples/{azure,aws,gcp}-service.cloud-inventory.json: synthetic service examples.
python/cloud_resource_collectors/normalise.py: provider normalization.
The cloud-collect command writes one neutral JSON snapshot for downstream consumers.
The Python package bundles the same schema; tests keep the two copies identical.

## Envelope

schemaVersion: cloud-inventory/1.0.0. Consumers reject unsupported major versions.
snapshotId: content digest for this serialized export, not a cross-run resource ID.
origin: live, synthetic or provided (provided does not certify live provenance).
collector: name and version. startedAt/finishedAt: UTC ISO-8601 timestamps.
scopes: provider, partition, accountId, tenantId if known, and selection criteria.
AccountId means AWS account, Azure subscription or GCP project identity. Retain
GCP immutable project number as an additional provider fact when available.
Collection scopes and service memberships are separate: shared infrastructure
may be outside a service's direct tag selection.

## Resource identity

key is an opaque provider + scope + native-ID identity. Importers must not parse
it to derive topology. Azure keys canonicalize case and trailing slash; nativeId
preserves the observed provider spelling. AWS/GCP connectors must define their
own identity rules; never globally lowercase cloud resource IDs. Partition
separation must be included for connectors supporting sovereign/other partitions.
The current Azure connector is public Azure only. Do not merge accounts from
different clouds or partitions because they happen to have matching names.

Resources contain nativeType, broad kind, region, zones, tags and facts. Broad
kind is for navigation, not evidence that a resilience mechanism exists.
Native IDs and region/zone names remain provider-specific. Null zones means
unknown; a zones array describes configured placement, not healthy distribution.
Facts have a provider-specific name, observed/unknown status, value, evidenceId
and RFC6901 sourcePointer into the evidence record. Unknown values are null;
missing data must never silently become false or zero. Preserve structured
provider configuration rather than flattening away failover semantics.
Do not put invented cross-cloud equivalents into observed facts. Future derived
assessments should be separate records with rule version and supporting evidence.

## Relationships

from references a resource key. target retains nativeId even when unresolved.
resourceKey is null for an unresolved target; resolution distinguishes an exact
resource from the nearest inventoried ancestor (e.g. an inline backend pool).
Kinds initially allowed: configuration-reference and contained-by. These are
explicit configuration facts, not claims about application traffic, reachability,
health or dependency criticality. Inferred relationships need a future explicit
schema extension; they must not be disguised as declared observations.

## Services

Catalogue ID/name, catalogue status, memberships and gaps. A resource can appear
in several service memberships but is emitted once in resources. Ownership,
shared/untagged dependencies and other services' dependencies remain distinct.
No visible resources does not prove that a service is absent.

## Evidence and coverage

Every evidence record references a collection with scope, source/API/table,
status, pagination completeness, permission coverage and collection times.
Each observation has observedAt and the filtered source record. Evidence IDs,
collection IDs and relationship IDs are local to the snapshot; graph importers
must namespace them by snapshotId. Resource keys persist between snapshots.
Do not load credentials or tokens. Source filtering is not a guarantee that arbitrary
provider configuration is secret-free; exports require controlled storage.
Unsupported types, denied permissions, traversal limits and unresolved references
remain explicit gaps. Our existing Azure collector leaves permission coverage
unverified. A successful Resource Graph query does not prove full API visibility.
Full raw estate evidence may include resources beyond the selected service; this
is an estate export, not a minimal service-scoped disclosure package.

## Importer rules (implemented by the Neo4j graph utility)

1. Validate schema version, structure and semantic integrity before a transaction:
   unique keys/IDs; valid scope, collection and evidence references; valid source
   pointers for observed facts; unknown facts null; valid UTC times and time order;
   membership/from/target resource references resolve within the snapshot.
2. Idempotently ingest snapshotId; upsert stable resource identities and retain
   observations/facts by snapshot. Do not overwrite history with current state.
3. Retain unresolved targets as references, not fabricated observed resources.
4. Preserve partial/unverified coverage. Never delete resources just because they
   were absent from this snapshot. Even a complete selected scan only supports
   absence within the same supported scope/type/filter; explicit deletion evidence
   or a separately governed reconciliation policy is required for retirement.
5. Keep service membership and cloud containment distinct. Store declared versus
   any future inferred relationships separately.
6. simulationReady is always false for discovery output. Workload paths, measured
   transaction capacity and recovery assumptions require assessment/confirmation.

## Versioning

Major: incompatible identity/meaning/structure change. Minor: coordinated optional
extensions; strict consumers must be updated before accepting new fields. Patch:
clarifications without changing valid data. Do not silently reinterpret older files.
The JSON Schema checks shape; it does not replace semantic importer validation.
The adapter tests exercise referential integrity and source pointers for the Azure
fixture. AWS and GCP commands additionally run shared schema/evidence/reference
validation before writing exports. All three fixtures exercise that validator.
Live integration verification remains to be done.

## Standalone project interface

The unified cloud-collect interface exports every observed resource in the
requested scopes, including untagged resources and observed scope containers.
Service memberships are optional annotations and do not determine resource inclusion.
Resource-to-scope links enable project queries even without a service catalogue.
Azure --resource-group selectors narrow subscription scope; dependencies outside
that selection remain unresolved. Provider-specific review bundle commands retain
their earlier service-oriented views. The graph importer shares this repository; see docs/graph-README.md.

## Graph utility

The Neo4j importer preserves snapshot-scoped observations and supporting evidence.
It validates all files before connecting, commits each snapshot atomically, rejects
conflicting content under an existing snapshot ID, and never deletes historical
resources based on absence. docs/graph-README.md describes the model and evidence queries.
