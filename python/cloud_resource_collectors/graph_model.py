"""Snapshot-preserving graph plan; stable IDs remain compatible with v0.2 exports."""

from .common import dumps, fingerprint, validate_snapshot, CollectorError

GRAPH_MODEL_VERSION = "cloud-resource-graph/1.0.0"


def entity_id(kind, *parts):
    return kind + ":" + fingerprint(parts)


def prepare_import(snapshot):
    validate_snapshot(snapshot)
    nodes, edges = {}, []
    sid = snapshot["snapshotId"]
    snapshot_node = entity_id("snapshot", sid)

    def add(label, id, **properties):
        node = dict(label=label, id=id, properties=dict(**properties, id=id))
        if id in nodes and nodes[id] != node:
            raise CollectorError("Conflicting graph identity")
        nodes[id] = node
        return id

    def link(type, a, b, **props):
        edges.append(dict(type=type, **{"from": a, "to": b}, properties=props))

    projects, collections, evidence, resources = {}, {}, {}, {}
    for s in snapshot["scopes"]:
        stable = add(
            "Project",
            entity_id("project", s["id"]),
            scopeId=s["id"],
            cloud=s["provider"],
            partition=s["partition"],
            accountId=s["accountId"],
        )
        po = add(
            "ProjectObservation",
            entity_id("project-observation", sid, s["id"]),
            snapshotId=sid,
            scopeId=s["id"],
            tenantId=s["tenantId"],
            selectorJson=dumps(s["selector"]),
            selectorHash=fingerprint(s["selector"]),
        )
        projects[s["id"]] = po
        link("HAS_PROJECT", snapshot_node, po)
        link("OF_PROJECT", po, stable)
    for c in snapshot["collections"]:
        id = add(
            "Collection",
            entity_id("collection", sid, c["id"]),
            snapshotId=sid,
            localId=c["id"],
            **{
                k: c[k]
                for k in (
                    "source",
                    "status",
                    "paginationComplete",
                    "permissionCoverage",
                    "startedAt",
                    "finishedAt",
                    "recordCount",
                    "errorCode",
                )
            },
        )
        collections[c["id"]] = id
        link("HAS_COLLECTION", snapshot_node, id)
        link("IN_PROJECT", id, projects[c["scopeId"]])
    for e in snapshot["evidence"]:
        id = add(
            "Evidence",
            entity_id("evidence", sid, e["id"]),
            snapshotId=sid,
            localId=e["id"],
            observedAt=e["observedAt"],
            redaction=e["redaction"],
            recordJson=dumps(e["record"]),
        )
        evidence[e["id"]] = id
        link("HAS_EVIDENCE", snapshot_node, id)
        link("FROM_COLLECTION", id, collections[e["collectionId"]])
    for r in snapshot["resources"]:
        stable = add("Resource", entity_id("resource", r["key"]), key=r["key"])
        ro = add(
            "ResourceObservation",
            entity_id("resource-observation", sid, r["key"]),
            snapshotId=sid,
            **{
                k: r[k]
                for k in (
                    "key",
                    "nativeId",
                    "nativeType",
                    "kind",
                    "name",
                    "region",
                    "placementMeaning",
                )
            },
            zones=r["zones"] or [],
            zonesKnown=r["zones"] is not None,
            tagsJson=dumps(r["tags"]),
        )
        resources[r["key"]] = ro
        link("HAS_RESOURCE", snapshot_node, ro)
        link("OF_RESOURCE", ro, stable)
        link("IN_PROJECT", ro, projects[r["scopeId"]])
        for eid in r["evidenceIds"]:
            link("SUPPORTED_BY", ro, evidence[eid])
        for i, f in enumerate(r["facts"]):
            v = f["value"]
            typ = (
                "null"
                if v is None
                else "boolean"
                if isinstance(v, bool)
                else "number"
                if isinstance(v, (int, float))
                else "string"
                if isinstance(v, str)
                else "array"
                if isinstance(v, list)
                else "object"
            )
            fact = add(
                "Fact",
                entity_id("fact", sid, r["key"], i),
                snapshotId=sid,
                name=f["name"],
                status=f["status"],
                valueType=typ,
                valueJson=dumps(v),
                valueString=v if typ == "string" else None,
                valueNumber=v if typ == "number" else None,
                valueBoolean=v if typ == "boolean" else None,
                evidenceLocalId=f["evidenceId"],
                sourcePointer=f["sourcePointer"],
            )
            link("HAS_FACT", ro, fact)
            link("SUPPORTED_BY", fact, evidence[f["evidenceId"]])
    for s in snapshot["services"]:
        stable = add("Service", entity_id("service", s["id"]), serviceId=s["id"])
        so = add(
            "ServiceObservation",
            entity_id("service-observation", sid, s["id"]),
            snapshotId=sid,
            serviceId=s["id"],
            name=s["name"],
            catalogueStatus=s["catalogueStatus"],
        )
        link("HAS_SERVICE", snapshot_node, so)
        link("OF_SERVICE", so, stable)
        for m in s["memberships"]:
            link("HAS_MEMBER", so, resources[m["resourceKey"]], role=m["role"])
        for i, g in enumerate(s["gaps"]):
            id = add(
                "Gap",
                entity_id("gap", sid, s["id"], i),
                snapshotId=sid,
                code=g["code"],
                message=g["message"],
            )
            link("HAS_GAP", so, id)
    scopes = {r["key"]: r["scopeId"] for r in snapshot["resources"]}
    for e in snapshot["relationships"]:
        a = resources[e["from"]]
        target = e["target"]
        ref = add(
            "ConfigurationReference",
            entity_id("reference", sid, e["id"]),
            snapshotId=sid,
            localId=e["id"],
            kind=e["kind"],
            assertion=e["assertion"],
            resolution=target["resolution"],
            targetNativeId=target["nativeId"],
            evidenceLocalId=e["evidenceId"],
            sourcePointer=e["sourcePointer"],
        )
        link("HAS_REFERENCE", a, ref)
        link("SUPPORTED_BY", ref, evidence[e["evidenceId"]])
        if target["resourceKey"] is not None:
            b = resources[target["resourceKey"]]
            link("TARGETS", ref, b)
            link(
                "CONTAINED_BY"
                if e["kind"] == "contained-by"
                else "CONFIGURATION_REFERENCE",
                a,
                b,
                referenceId=ref,
                resolution=target["resolution"],
                assertion=e["assertion"],
            )
        else:
            b = add(
                "UnresolvedTarget",
                entity_id("unresolved", sid, scopes[e["from"]], target["nativeId"]),
                snapshotId=sid,
                nativeId=target["nativeId"],
            )
            link("POINTS_TO", ref, b)
            link("UNRESOLVED_REFERENCE", a, b, referenceId=ref)
    known = {snapshot_node, *nodes}
    if any(e["from"] not in known or e["to"] not in known for e in edges):
        raise CollectorError("Graph plan has unresolved internal IDs")
    return dict(
        snapshotId=sid,
        snapshotNodeId=snapshot_node,
        payloadHash=fingerprint(snapshot),
        snapshotProperties=dict(
            snapshotId=sid,
            schemaVersion=snapshot["schemaVersion"],
            origin=snapshot["origin"],
            collectorName=snapshot["collector"]["name"],
            collectorVersion=snapshot["collector"]["version"],
            startedAt=snapshot["startedAt"],
            finishedAt=snapshot["finishedAt"],
            limitations=snapshot["limitations"],
            graphModelVersion=GRAPH_MODEL_VERSION,
        ),
        nodes=list(nodes.values()),
        edges=edges,
    )
