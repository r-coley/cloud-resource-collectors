"""Official Neo4j driver, atomic snapshot imports and bounded evidence queries."""

import json
import os
import re
from uuid import uuid4
from urllib.parse import urlsplit
from importlib.resources import files
from neo4j import GraphDatabase, READ_ACCESS
from .common import CollectorError, utc_now
from .graph_model import prepare_import, GRAPH_MODEL_VERSION

LABELS = (
    "Project",
    "ProjectObservation",
    "Collection",
    "Evidence",
    "Resource",
    "ResourceObservation",
    "Fact",
    "Service",
    "ServiceObservation",
    "Gap",
    "ConfigurationReference",
    "UnresolvedTarget",
)
RELATIONSHIPS = (
    "HAS_PROJECT",
    "OF_PROJECT",
    "HAS_COLLECTION",
    "IN_PROJECT",
    "HAS_EVIDENCE",
    "FROM_COLLECTION",
    "HAS_RESOURCE",
    "OF_RESOURCE",
    "SUPPORTED_BY",
    "HAS_FACT",
    "HAS_SERVICE",
    "OF_SERVICE",
    "HAS_MEMBER",
    "HAS_GAP",
    "HAS_REFERENCE",
    "TARGETS",
    "CONFIGURATION_REFERENCE",
    "CONTAINED_BY",
    "POINTS_TO",
    "UNRESOLVED_REFERENCE",
)
QUERIES = {
    name: files("cloud_resource_collectors")
    .joinpath("queries", name + ".cypher")
    .read_text()
    for name in (
        "projects",
        "select-project",
        "coverage",
        "resources",
        "project-count",
        "references",
        "reference-count",
        "service-gaps",
        "evidence",
    )
}


def connection_from_env(env=None, **overrides):
    env = os.environ if env is None else env
    uri = overrides.get("uri") or env.get("NEO4J_URI", "bolt://127.0.0.1:7687")
    p = urlsplit(uri)
    if (
        p.scheme not in ("bolt", "bolt+s", "bolt+ssc", "neo4j", "neo4j+s", "neo4j+ssc")
        or p.username
        or p.password
        or not p.hostname
    ):
        raise CollectorError("Invalid Neo4j URI")
    config = dict(
        uri=uri,
        username=env.get("NEO4J_USERNAME", "neo4j"),
        password=env.get("NEO4J_PASSWORD"),
        database=overrides.get("database") or env.get("NEO4J_DATABASE", "neo4j"),
    )
    if not all(config.values()):
        raise CollectorError("Set NEO4J_PASSWORD and valid connection settings")
    return config


def open_driver(config):
    return GraphDatabase.driver(
        config["uri"],
        auth=(config["username"], config["password"]),
        connection_timeout=15,
        max_transaction_retry_time=15,
    )


def ensure_schema(driver, database="neo4j"):
    with driver.session(database=database) as session:
        for query in (
            "CREATE CONSTRAINT inventory_entity_id IF NOT EXISTS FOR (n:InventoryEntity) REQUIRE n.id IS UNIQUE",
            "CREATE INDEX inventory_project_scope IF NOT EXISTS FOR (n:Project) ON (n.scopeId)",
            "CREATE INDEX inventory_project_account IF NOT EXISTS FOR (n:Project) ON (n.accountId)",
            "CREATE INDEX inventory_snapshot_id IF NOT EXISTS FOR (n:Snapshot) ON (n.snapshotId)",
        ):
            session.run(query).consume()


def write_plan(tx, plan, batch_size=500):
    if type(batch_size) is not int or not 1 <= batch_size <= 5000:
        raise CollectorError("Invalid graph batch size")
    if any(n["label"] not in LABELS for n in plan["nodes"]) or any(
        e["type"] not in RELATIONSHIPS for e in plan["edges"]
    ):
        raise CollectorError("Unsupported graph label or relationship")
    token = str(uuid4())
    row = tx.run(
        """MERGE (s:InventoryEntity:Snapshot {id:$id})
ON CREATE SET s += $properties, s.payloadHash=$hash, s.importToken=$token, s.importedAt=$now, s.state='importing'
SET s.importLock=true
RETURN s.payloadHash AS payloadHash, s.importToken AS importToken, s.state AS state, s.graphModelVersion AS graphModelVersion""",
        id=plan["snapshotNodeId"],
        properties=plan["snapshotProperties"],
        hash=plan["payloadHash"],
        token=token,
        now=utc_now(),
    ).single(strict=True)
    if (
        row["payloadHash"] != plan["payloadHash"]
        or row["graphModelVersion"] != GRAPH_MODEL_VERSION
    ):
        raise CollectorError(
            "Snapshot ID already exists with different content or graph model"
        )
    if row["importToken"] != token:
        if row["state"] != "complete":
            raise CollectorError("Snapshot is not in a complete state")
        return dict(snapshotId=plan["snapshotId"], status="already-imported")
    for label in LABELS:
        rows = [n for n in plan["nodes"] if n["label"] == label]
        for i in range(0, len(rows), batch_size):
            tx.run(
                f"UNWIND $rows AS row MERGE (n:InventoryEntity {{id:row.id}}) SET n:{label} SET n += row.properties",
                rows=rows[i : i + batch_size],
            ).consume()
    for kind in RELATIONSHIPS:
        rows = [e for e in plan["edges"] if e["type"] == kind]
        for i in range(0, len(rows), batch_size):
            tx.run(
                f"UNWIND $rows AS row MATCH (a:InventoryEntity {{id:row.from}}), (b:InventoryEntity {{id:row.to}}) MERGE (a)-[r:{kind} {{identity:coalesce(row.properties.referenceId,'')}}]->(b) SET r += row.properties",
                rows=rows[i : i + batch_size],
            ).consume()
    tx.run(
        "MATCH (s:InventoryEntity:Snapshot {id:$id}) SET s.state='complete'",
        id=plan["snapshotNodeId"],
    ).consume()
    return dict(
        snapshotId=plan["snapshotId"],
        status="imported",
        nodes=len(plan["nodes"]) + 1,
        relationships=len(plan["edges"]),
    )


def import_snapshots(
    driver, snapshots, database="neo4j", batch_size=500, initialize=True
):
    plans = [prepare_import(s) for s in snapshots]
    seen = {}
    for p in plans:
        if p["snapshotId"] in seen and seen[p["snapshotId"]] != p["payloadHash"]:
            raise CollectorError("Snapshot ID is repeated with different content")
        seen[p["snapshotId"]] = p["payloadHash"]
    if initialize:
        ensure_schema(driver, database)
    results = []
    for plan in plans:
        with driver.session(database=database) as session:
            results.append(session.execute_write(write_plan, plan, batch_size))
    return results


def read_query(driver, database, name, params):
    with driver.session(database=database, default_access_mode=READ_ACCESS) as session:
        return session.execute_read(
            lambda tx: [r.data() for r in tx.run(QUERIES.get(name, name), params)]
        )


def query_limit(value=1000):
    if type(value) is not int or not 1 <= value <= 5000:
        raise CollectorError("Limit must be 1–5000")
    return value


def choose_project(rows, snapshot=None):
    if not rows:
        raise CollectorError("No imported project observation matches this selection")
    if len({r["project"] for r in rows}) > 1:
        raise CollectorError("Project is ambiguous; use a full scope ID or --cloud")
    if not snapshot and len({(r["selectorHash"], r["origin"]) for r in rows}) > 1:
        raise CollectorError(
            "Project has multiple selectors or origins; choose --snapshot"
        )
    from datetime import datetime

    return sorted(
        rows,
        key=lambda r: (
            datetime.fromisoformat(r["collectedTo"].replace("Z", "+00:00")),
            r["snapshotId"],
        ),
        reverse=True,
    )[0]


def project_resources(driver, options):
    db = options.get("database", "neo4j")
    limit = query_limit(options.get("limit", 1000))
    rows = read_query(
        driver,
        db,
        "select-project",
        {k: options.get(k) for k in ("project", "cloud", "snapshot", "origin")},
    )
    selected = choose_project(rows, options.get("snapshot"))
    params = dict(
        projectObservationId=selected["projectObservationId"],
        kind=options.get("kind"),
        limit=limit,
    )
    rows = read_query(driver, db, "resources", params)
    count = read_query(driver, db, "project-count", params)[0]["resourceCount"]
    for r in rows:
        r["tags"] = json.loads(r.pop("tagsJson"))
        r["zones"] = r["zones"] if r.pop("zonesKnown") else None
        for f in r["facts"]:
            f["value"] = json.loads(f.pop("valueJson"))
    return dict(
        project=selected,
        resourceCount=count,
        limit=limit,
        truncated=count > len(rows),
        resources=rows,
    )


CATEGORIES = [
    (
        "placement",
        "Configured placement",
        r"zone|Zone|availabilityType|MultiAZ|distributionPolicy",
    ),
    (
        "automatic-recovery",
        "Automatic recovery and scaling",
        r"automaticRepairsPolicy|autoHealingPolicies|HealthCheckGracePeriod|DefaultInstanceWarmup|CapacityRebalance|SuspendedProcesses|autoscalingPolicy|MinSize|MaxSize|DesiredCapacity|targetSize|updatePolicy|HealthStatus",
    ),
    (
        "data-availability",
        "Database and replication settings",
        r"zoneRedundant|MultiAZ|availabilityType|readWriteEndpoint|partnerServers|replication|Replication|DBClusterMembers|GlobalClusterMembers|masterInstanceName|replicaNames|failoverReplica",
    ),
    (
        "backup-recovery",
        "Backup and point-in-time recovery",
        r"[Bb]ackup|[Rr]etention|[Rr]estorable",
    ),
    (
        "health-routing",
        "Health checks and routing",
        r"[Hh]ealthCheck|probes|loadBalancingRules|trafficRoutingMethod|monitorConfig|DefaultActions|failoverPolicy|readWriteEndpoint",
    ),
    (
        "allocation",
        "Reservation and allocation settings",
        r"[Cc]apacityReservation|[Rr]eservation|InstanceLifecycle|priority|specificReservation|AvailableInstanceCount|TotalInstanceCount",
    ),
]


def resilience_evidence(
    selected,
    resources,
    coverage=(),
    counts=None,
    references=(),
    reference_counts=None,
    gaps=(),
    limit=1000,
):
    counts = counts or {}
    reference_counts = reference_counts or {}
    checks = []
    for id, title, pattern in CATEGORIES:
        items = []
        for r in resources:
            facts = [f for f in r["facts"] if re.search(pattern, f["name"])]
            if facts:
                items.append(
                    dict(
                        resourceKey=r["key"],
                        resourceName=r["name"],
                        kind=r["kind"],
                        facts=facts,
                    )
                )
        checks.append(
            dict(
                id=id,
                title=title,
                status="evidence-recorded"
                if any(f["status"] == "observed" for i in items for f in i["facts"])
                else "unknown",
                items=items,
            )
        )
    rc = counts.get("resourceCount", len(resources))
    ec = reference_counts.get("referenceCount", len(references))
    return dict(
        viewVersion="resilience-evidence/1.0.0",
        project=selected,
        assessment="requires-review",
        coverage=dict(
            collections=len(coverage),
            incompleteCollections=sum(
                c["status"] != "collected" or not c["paginationComplete"]
                for c in coverage
            ),
            unverifiedCollections=sum(
                c["permissionCoverage"] != "verified" for c in coverage
            ),
            resourcesInProject=rc,
            resourcesReturned=len(resources),
            resourceLimit=limit,
            truncated=rc > len(resources),
            referenceCount=ec,
            unresolvedReferenceCount=reference_counts.get("unresolvedCount", 0),
            referencesTruncated=ec > len(references),
        ),
        checks=checks,
        placement=[
            dict(
                resourceKey=r["key"],
                **{k: r[k] for k in ("kind", "region", "zones", "placementMeaning")},
            )
            for r in resources
            if r["kind"]
            in (
                "compute",
                "compute-group",
                "database",
                "database-cluster",
                "container-platform",
                "application-host",
            )
        ],
        references=list(references),
        serviceGaps=list(gaps),
        serviceGapsMayBeTruncated=len(gaps) >= limit,
        collectionDetails=list(coverage),
        interpretation="Configuration evidence only. Placement, capacity, failover, backup and reservation settings do not establish tested resilience, available transaction throughput or RTO/RPO.",
    )


def query_resilience(driver, options):
    result = project_resources(driver, options)
    db = options.get("database", "neo4j")
    params = dict(
        projectObservationId=result["project"]["projectObservationId"],
        kind=None,
        limit=query_limit(options.get("limit", 1000)),
    )

    def query(name):
        return read_query(driver, db, name, params)

    return resilience_evidence(
        result["project"],
        result["resources"],
        coverage=query("coverage"),
        counts=query("project-count")[0],
        references=query("references"),
        reference_counts=query("reference-count")[0],
        gaps=query("service-gaps"),
        limit=params["limit"],
    )
