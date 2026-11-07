"""Normalize provider observations without inferring operational guarantees."""

from collections import defaultdict
import re
from .common import (
    CollectorError,
    data_file,
    fingerprint,
    get_path,
    pointer,
    redact,
    stamp,
    validate_snapshot,
)
from .config import validate_config
from .collectors import canonical_gcp, gcp_location


def normalise(cloud, inventory, config, origin="provided"):
    validate_config(cloud, config)
    versions = {
        "azure": "azure-resource-graph/0.1",
        "aws": "aws-api-inventory/0.1",
        "gcp": "gcp-api-inventory/0.1",
    }
    if (
        inventory.get("provider") != cloud
        or inventory.get("inventoryVersion") != versions[cloud]
    ):
        raise CollectorError("Invalid provider inventory")
    scopes, expected = [], []
    if cloud == "azure":
        if sorted(s.lower() for s in inventory["subscriptions"]) != sorted(
            s.lower() for s in config["subscriptions"]
        ):
            raise CollectorError(
                "Inventory subscription scope differs from configuration"
            )
        for sub in config["subscriptions"]:
            selector = {"serviceTagKey": config.get("serviceTagKey", "serviceId")}
            if config.get("resourceGroups"):
                selector["resourceGroups"] = config["resourceGroups"]
            scopes.append(
                dict(
                    id="azure:" + sub.lower(),
                    provider=cloud,
                    partition="public",
                    accountId=sub,
                    tenantId=None,
                    selector=selector,
                )
            )
            for table in ("Resources", "ResourceContainers"):
                expected.append(dict(subscriptionId=sub, table=table))
    elif cloud == "aws":

        def shape(rows):
            return sorted(
                (a["id"], a.get("partition", "aws"), tuple(sorted(a["regions"])))
                for a in rows
            )

        if shape(config["accounts"]) != shape(inventory["accounts"]):
            raise CollectorError("Inventory differs from configured AWS scope")
        specdata = data_file("aws_specs.json")
        for a in config["accounts"]:
            scopes.append(
                dict(
                    id=f"aws:{a.get('partition', 'aws')}:{a['id']}",
                    provider=cloud,
                    partition=a.get("partition", "aws"),
                    accountId=a["id"],
                    tenantId=None,
                    selector=dict(
                        regions=a["regions"],
                        serviceTagKey=config.get("serviceTagKey", "serviceId"),
                    ),
                )
            )
            for i, region in enumerate(a["regions"]):
                for spec in specdata["specs"]:
                    if not spec.get("once") or i == 0:
                        expected.append(
                            dict(
                                accountId=a["id"],
                                partition=a.get("partition", "aws"),
                                region=region,
                                source=spec["service"] + ":" + spec["operation"],
                            )
                        )
        for r in inventory["records"]:
            for detail in specdata["details"]:
                if r["nativeType"] == detail["parent"]:
                    expected.append(
                        dict(
                            accountId=r["accountId"],
                            partition=r["partition"],
                            region=r["region"],
                            source=detail["service"] + ":" + detail["operation"],
                            parentId=r["nativeId"],
                        )
                    )
    else:
        projects = inventory["projects"]
        if (
            len(projects) != len(config["projects"])
            or len({p["id"] for p in projects}) != len(projects)
            or len({p["number"] for p in projects}) != len(projects)
        ):
            raise CollectorError("Project scope mismatch")
        specdata = data_file("gcp_specs.json")
        for p in projects:
            c = next((c for c in config["projects"] if c["id"] == p["id"]), None)
            if (
                not c
                or not re.fullmatch(r"\d{6,20}", p["number"])
                or (c.get("number") and c["number"] != p["number"])
                or sorted(p["regions"]) != sorted(c["regions"])
            ):
                raise CollectorError("Project scope mismatch")
            scopes.append(
                dict(
                    id="gcp:public:" + p["id"],
                    provider=cloud,
                    partition="public",
                    accountId=p["id"],
                    tenantId=None,
                    selector=dict(
                        projectNumber=p["number"],
                        regions=p["regions"],
                        serviceLabelKey=config.get("serviceLabelKey", "service_id"),
                        serviceLabelValues=config.get("serviceLabelValues", {}),
                    ),
                )
            )
            expected.append(
                dict(projectId=p["id"], source="cloudresourcemanager:projects.get")
            )
            for spec in specdata["specs"]:
                for region in p["regions"] if spec.get("regional") else [None]:
                    expected.append(
                        dict(
                            projectId=p["id"],
                            source=spec["id"] + (":" + region if region else ""),
                        )
                    )
        for r in inventory["records"]:
            if r[
                "nativeType"
            ] == "compute.googleapis.com/InstanceGroupManager" and not r.get("asset"):
                expected.append(
                    dict(
                        projectId=r["projectId"],
                        source="managed-instances",
                        parentId=r["nativeId"],
                    )
                )
    by_scope = {s["id"]: s for s in scopes}

    def scope_for(row):
        if cloud == "azure":
            return "azure:" + row["subscriptionId"].lower()
        if cloud == "aws":
            return f"aws:{row['partition']}:{row['accountId']}"
        return "gcp:public:" + row["projectId"]

    collections, raw_collections = [], {}

    def source(c):
        if cloud == "azure":
            return c["table"]
        return (
            c["source"]
            + (":" + c["region"] if cloud == "aws" else "")
            + (":" + c["parentId"] if c.get("parentId") else "")
        )

    for i, c in enumerate(inventory["collections"]):
        sid = scope_for(c)
        if sid not in by_scope or (
            cloud == "aws" and c["region"] not in by_scope[sid]["selector"]["regions"]
        ):
            raise CollectorError("Collection outside configured scope")
        cid = "collection-" + str(i) if cloud == "azure" else c["id"]
        if cid in raw_collections:
            raise CollectorError("Duplicate collection IDs")
        raw_collections[cid] = c
        status = c["status"]
        if status == "collected" and not c["paginationComplete"]:
            status = "partial"
        error = c.get("errorCode") or (c.get("error") or {}).get("code")
        if error in (
            "HTTP_403",
            "AuthorizationFailed",
            "AccessDenied",
            "AccessDeniedException",
        ):
            status = "denied"
        collections.append(
            dict(
                id=cid,
                scopeId=sid,
                source=source(c),
                status=status,
                paginationComplete=c["paginationComplete"],
                permissionCoverage=c.get("permissionCoverage", "unverified"),
                startedAt=c["startedAt"],
                finishedAt=c["finishedAt"],
                recordCount=c.get("recordCount", 0),
                errorCode=error,
            )
        )
    for e in expected:
        if not any(
            all(c.get(k) == v for k, v in e.items() if k != "partition")
            for c in inventory["collections"]
        ):
            collections.append(
                dict(
                    id="missing-" + fingerprint(e),
                    scopeId=scope_for(e),
                    source=source(e),
                    status="partial",
                    paginationComplete=False,
                    permissionCoverage="unverified",
                    startedAt=inventory["startedAt"],
                    finishedAt=inventory["finishedAt"],
                    recordCount=0,
                    errorCode="NotCollected",
                )
            )
    nodes, evidence, edges, conflicts = {}, [], [], []
    azure = data_file("azure_mappings.json") if cloud == "azure" else {}

    def canonical(name):
        if cloud == "azure":
            return name.lower().rstrip("/")
        if cloud == "aws":
            return name
        name = canonical_gcp(name)
        if name:
            for p in inventory["projects"]:
                name = re.sub(
                    r"/projects/" + re.escape(p["number"]) + r"(?=/|$)",
                    "/projects/" + p["id"],
                    name,
                )
        return name

    def tags_of(data):
        if cloud == "aws":
            return {
                t["Key"]: t["Value"]
                for t in (data.get("Tags") or data.get("TagList") or [])
                if isinstance(t.get("Key"), str) and isinstance(t.get("Value"), str)
            }
        if cloud == "gcp":
            return (
                data.get("labels") or data.get("settings", {}).get("userLabels") or {}
            )
        return data.get("tags") or {}

    for raw in inventory["records"]:
        r = redact(raw, gcp=cloud == "gcp")
        sid = scope_for(r)
        if sid not in by_scope:
            raise CollectorError("Resource outside configured scope")
        if cloud == "azure":
            data = r["resource"]
            native = data["id"]
            typ = data["type"]
            kind = azure.get(typ.lower(), {}).get("kind", "uninterpreted")
            if not (
                native.lower().rstrip("/")
                == "/subscriptions/" + r["subscriptionId"].lower()
                or native.lower().startswith(
                    "/subscriptions/" + r["subscriptionId"].lower() + "/"
                )
            ):
                raise CollectorError("Resource outside subscription")
            if config.get("resourceGroups"):
                m = re.search(r"/resourcegroups/([^/]+)", native, re.I)
                if not m or m[1].lower() not in [
                    g.lower() for g in config["resourceGroups"]
                ]:
                    continue
            cid = next(
                (
                    c["id"]
                    for c in collections
                    if c["scopeId"] == sid and c["source"] == r["table"]
                ),
                None,
            )
            record = data
            region = data.get("location")
        else:
            cid = r["collectionId"]
            c = raw_collections.get(cid)
            if not c or scope_for(c) != sid:
                raise CollectorError("Invalid observation collection")
            native = r["nativeId"]
            typ = r["nativeType"]
            kind = r.get("kind", "uninterpreted")
            record = r
            data = (
                get_path(r, "configuration.resource.data") or {}
                if r.get("asset")
                else r["configuration"]
            )
            if cloud == "aws":
                arn = native.split(":", 5)
                if (
                    len(arn) != 6
                    or arn[0] != "arn"
                    or arn[1] != r["partition"]
                    or (arn[3] and arn[3] != r["region"])
                    or (arn[4] and arn[4] != r["accountId"])
                    or c["region"] != r["region"]
                ):
                    raise CollectorError("Resource ARN outside configured scope")
                region = arn[3] or None
            else:
                p = next(p for p in inventory["projects"] if p["id"] == r["projectId"])
                native = canonical_gcp(native)
                m = re.search(r"/projects/([^/]+)", native or "")
                if (
                    not native
                    or r["projectNumber"] != p["number"]
                    or (m and m[1] not in (p["id"], p["number"]))
                ):
                    raise CollectorError("Resource outside project scope")
                loc = gcp_location(
                    native, data, get_path(r, "configuration.resource.location")
                )
                region = loc[0]
                if region and region not in p["regions"]:
                    raise CollectorError("Resource outside regional scope")
        eid = "evidence-" + str(len(evidence))
        evidence.append(
            dict(
                id=eid,
                collectionId=cid,
                observedAt=r["observedAt"],
                redaction="collector-filtered-not-guaranteed-secret-free",
                record=record,
            )
        )
        key = sid + ":" + canonical(native)
        if key not in nodes:
            nodes[key] = dict(
                key=key,
                scopeId=sid,
                nativeId=native,
                nativeType=typ,
                kind=kind,
                name=data.get("name", native),
                region=region,
                zones=None,
                placementMeaning="unknown-not-proof-of-no-zone-redundancy",
                tags={},
                facts=[],
                evidenceIds=[],
                _obs=[],
                _conflict=False,
            )
        n = nodes[key]
        n["evidenceIds"].append(eid)
        n["_obs"].append((r, data, eid))
        for k, v in tags_of(data).items():
            if k in n["tags"] and n["tags"][k] != v:
                n["_conflict"] = True
                conflicts.append(
                    dict(
                        code="conflicting-observations",
                        message="Conflicting tags or labels; ownership is not inferred.",
                    )
                )
            else:
                n["tags"][k] = v
    by_native = {canonical(n["nativeId"]): n for n in nodes.values()}
    for n in nodes.values():
        r, data, eid = next(
            (
                o
                for o in n["_obs"]
                if o[0].get("nativeType") != "tagged-resource" and not o[0].get("asset")
            ),
            n["_obs"][0],
        )
        typ = data["type"] if cloud == "azure" else r["nativeType"]
        n["nativeType"] = typ
        prefix = (
            ""
            if cloud == "azure"
            else "configuration.resource.data."
            if r.get("asset")
            else "configuration."
        )
        fields = (
            azure.get(typ.lower(), {}).get("fields", [])
            if cloud == "azure"
            else specdata["fields"].get(typ, [])
        )
        n["facts"] = [
            dict(
                name=f,
                status="unknown" if get_path(data, f) is None else "observed",
                value=get_path(data, f),
                evidenceId=eid,
                sourcePointer=pointer(prefix + f),
            )
            for f in fields
        ]
        if cloud != "azure":
            n["kind"] = r.get("kind", "uninterpreted")
        n["name"] = next(
            (
                data[k]
                for k in (
                    "name",
                    "AutoScalingGroupName",
                    "DBInstanceIdentifier",
                    "DBClusterIdentifier",
                    "LoadBalancerName",
                    "TargetGroupName",
                )
                if data.get(k)
            ),
            n["nativeId"],
        )
        zones = data.get("zones", []) if cloud == "azure" else []
        if cloud == "aws":
            zones = [
                z if isinstance(z, str) else z.get("ZoneName")
                for z in data.get("AvailabilityZones", [])
            ]
            zones += [
                get_path(data, f)
                for f in (
                    "Placement.AvailabilityZone",
                    "AvailabilityZone",
                    "SecondaryAvailabilityZone",
                )
            ]
        if cloud == "gcp":
            loc = gcp_location(
                n["nativeId"], data, get_path(r, "configuration.resource.location")
            )
            n["region"] = loc[0]
            zones = [loc[1], data.get("secondaryGceZone")] + [
                z.get("zone", "").split("/")[-1]
                for z in data.get("distributionPolicy", {}).get("zones", [])
            ]
        zones = list(dict.fromkeys(z for z in zones or [] if isinstance(z, str) and z))
        if zones:
            n["zones"] = zones
            n["placementMeaning"] = (
                "declared-placement-not-healthy-instance-distribution"
            )

        def edge(native, path, kind="configuration-reference", context=False):
            if not isinstance(native, str) or not native:
                return
            native = canonical_gcp(native) if cloud == "gcp" else native
            targetname = canonical(native)
            if not targetname:
                return
            target = by_native.get(targetname)
            resolution = "exact-resource" if target else "unresolved"
            if cloud == "azure" and not target:
                ancestors = [
                    name
                    for name in by_native
                    if targetname.startswith(name + "/") and "/providers/" in name
                ]
                if ancestors:
                    target = by_native[max(ancestors, key=len)]
                    resolution = "resource-ancestor-only"
            if cloud == "gcp" and target and target["key"] == n["key"]:
                return
            if cloud == "azure" and canonical(native) == canonical(n["nativeId"]):
                return
            edges.append(
                dict(
                    id="edge-" + fingerprint([n["key"], native, eid, path, kind]),
                    **{"from": n["key"]},
                    target=dict(
                        nativeId=native,
                        resourceKey=target["key"] if target else None,
                        resolution=resolution,
                    ),
                    kind=kind,
                    assertion="declared",
                    evidenceId=eid,
                    sourcePointer=path if context else pointer(prefix + path),
                )
            )

        def refs(value, path=""):
            if isinstance(value, str):
                if (
                    cloud == "azure" and value.lower().startswith("/subscriptions/")
                ) or (cloud == "gcp" and canonical_gcp(value)):
                    edge(value, path)
            elif isinstance(value, list):
                for i, v in enumerate(value):
                    refs(v, path + "." + str(i))
            elif isinstance(value, dict):
                for k, v in value.items():
                    if cloud != "gcp" or k not in (
                        "selfLink",
                        "zone",
                        "region",
                        "machineType",
                        "labels",
                        "userLabels",
                        "metadata",
                    ):
                        refs(v, path + "." + k if path else k)

        if cloud == "azure":
            refs(data.get("properties", {}), "properties")
            parts = n["nativeId"].rstrip("/").split("/")
            if len(parts) > 9:
                edge("/".join(parts[:-2]), "id", "contained-by")
        elif cloud == "gcp":
            refs(data)
            if typ == "sqladmin.googleapis.com/Instance":
                for path in ("masterInstanceName", "failoverReplica.name"):
                    if get_path(data, path):
                        edge(
                            "//cloudsql.googleapis.com/projects/"
                            + r["projectId"]
                            + "/instances/"
                            + get_path(data, path),
                            path,
                        )
                for i, name in enumerate(data.get("replicaNames", [])):
                    edge(
                        "//cloudsql.googleapis.com/projects/"
                        + r["projectId"]
                        + "/instances/"
                        + name,
                        "replicaNames." + str(i),
                    )
        else:

            def ec2(kind, value):
                return f"arn:{r['partition']}:ec2:{r['region']}:{r['accountId']}:{kind}/{value}"

            def rds(kind, value):
                return (
                    value
                    if value.startswith("arn:")
                    else f"arn:{r['partition']}:rds:{r['region']}:{r['accountId']}:{kind}:{value}"
                )

            for path, kind in [
                ("VpcId", "vpc"),
                ("SubnetId", "subnet"),
                ("CapacityReservationId", "capacity-reservation"),
                (
                    "CapacityReservationSpecification.CapacityReservationTarget.CapacityReservationId",
                    "capacity-reservation",
                ),
                ("LaunchTemplate.LaunchTemplateId", "launch-template"),
            ]:
                if get_path(data, path):
                    edge(ec2(kind, get_path(data, path)), path)
            for value in data.get("VPCZoneIdentifier", "").split(","):
                if value:
                    edge(ec2("subnet", value), "VPCZoneIdentifier")
            for path, field, kind in [
                ("Instances", "InstanceId", "instance"),
                ("AvailabilityZones", "SubnetId", "subnet"),
            ]:
                for i, item in enumerate(data.get(path, [])):
                    if isinstance(item, dict) and item.get(field):
                        edge(ec2(kind, item[field]), f"{path}.{i}.{field}")
            for path in ("TargetGroupARNs", "LoadBalancerArns"):
                for i, value in enumerate(data.get(path, [])):
                    edge(value, f"{path}.{i}")
            for path in ("LoadBalancerArn", "ReplicationSourceIdentifier"):
                edge(data.get(path), path)
            for i, action in enumerate(data.get("DefaultActions", [])):
                edge(action.get("TargetGroupArn"), f"DefaultActions.{i}.TargetGroupArn")
                for j, t in enumerate(
                    action.get("ForwardConfig", {}).get("TargetGroups", [])
                ):
                    edge(
                        t.get("TargetGroupArn"),
                        f"DefaultActions.{i}.ForwardConfig.TargetGroups.{j}.TargetGroupArn",
                    )
            if re.fullmatch(r"i-[a-z0-9]+", get_path(data, "Target.Id") or ""):
                edge(ec2("instance", get_path(data, "Target.Id")), "Target.Id")
            for path, kind in [
                ("DBClusterIdentifier", "cluster"),
                ("ReadReplicaSourceDBInstanceIdentifier", "db"),
            ]:
                if data.get(path):
                    edge(rds(kind, data[path]), path)
            for i, m in enumerate(data.get("DBClusterMembers", [])):
                if m.get("DBInstanceIdentifier"):
                    edge(
                        rds("db", m["DBInstanceIdentifier"]),
                        f"DBClusterMembers.{i}.DBInstanceIdentifier",
                    )
            for i, m in enumerate(data.get("GlobalClusterMembers", [])):
                edge(m.get("DBClusterArn"), f"GlobalClusterMembers.{i}.DBClusterArn")
            group = data.get("DBSubnetGroup")
            if isinstance(group, str):
                found = next(
                    (
                        v
                        for v in nodes.values()
                        if v["scopeId"] == n["scopeId"]
                        and v["region"] == n["region"]
                        and any(
                            o[1].get("DBSubnetGroupName") == group for o in v["_obs"]
                        )
                    ),
                    None,
                )
                edge(
                    found["nativeId"] if found else rds("subgrp", group),
                    "DBSubnetGroup",
                )
            elif isinstance(group, dict):
                edge(group.get("DBSubnetGroupArn"), "DBSubnetGroup.DBSubnetGroupArn")
            for i, s in enumerate(
                data.get(
                    "Subnets",
                    group.get("Subnets", []) if isinstance(group, dict) else [],
                )
            ):
                if s.get("SubnetIdentifier"):
                    edge(
                        ec2("subnet", s["SubnetIdentifier"]),
                        ("Subnets." if "Subnets" in data else "DBSubnetGroup.Subnets.")
                        + str(i)
                        + ".SubnetIdentifier",
                    )
            if typ == "AWS::AutoScaling::ScalingPolicy" and data.get(
                "AutoScalingGroupName"
            ):
                group = next(
                    (
                        v
                        for v in nodes.values()
                        if v["nativeType"] == "AWS::AutoScaling::AutoScalingGroup"
                        and v["scopeId"] == n["scopeId"]
                        and v["region"] == n["region"]
                        and any(
                            o[1].get("AutoScalingGroupName")
                            == data["AutoScalingGroupName"]
                            for o in v["_obs"]
                        )
                    ),
                    None,
                )
                if group:
                    edge(group["nativeId"], "AutoScalingGroupName")
        if r.get("parentId"):
            edge(r["parentId"], "/parentId", "contained-by", True)
    services = group_services(nodes, edges, config, cloud, collections, conflicts)
    resources = [
        {k: v for k, v in n.items() if not k.startswith("_")}
        for _, n in sorted(nodes.items())
    ]
    result = stamp(
        dict(
            schemaVersion="cloud-inventory/1.0.0",
            snapshotId="",
            origin=origin,
            collector=dict(name="cloud-resource-collectors/" + cloud, version="0.3.0"),
            startedAt=inventory["startedAt"],
            finishedAt=inventory["finishedAt"],
            scopes=scopes,
            collections=collections,
            services=services,
            resources=resources,
            relationships=list({e["id"]: e for e in edges}.values()),
            evidence=evidence,
            limitations=inventory.get("limitations", []),
            simulationReady=False,
        )
    )
    return validate_snapshot(result)


def group_services(nodes, edges, config, cloud, collections, conflicts):
    def owner(n):
        key = (
            config.get("serviceLabelKey", "service_id")
            if cloud == "gcp"
            else config.get("serviceTagKey", "serviceId")
        )
        values = (
            [v for k, v in n["tags"].items() if k.lower() == key.lower()]
            if cloud == "azure"
            else [n["tags"].get(key)]
        )
        values = {v.strip() for v in values if isinstance(v, str) and v.strip()}
        if n["_conflict"] or len(values) != 1:
            return None
        value = next(iter(values))
        return (
            config.get("serviceLabelValues", {}).get(value, value)
            if cloud == "gcp"
            else value
        )

    catalogue = {
        s["id"]: dict(
            id=s["id"], name=s.get("name", s["id"]), catalogueStatus="catalogued"
        )
        for s in config.get("services", [])
    }
    owned = defaultdict(set)
    outgoing = defaultdict(list)
    incoming = defaultdict(list)
    for key, n in nodes.items():
        oid = owner(n)
        if oid:
            owned[oid].add(key)
            catalogue.setdefault(
                oid,
                dict(
                    id=oid,
                    name=oid,
                    catalogueStatus="not-in-catalogue"
                    if config.get("services")
                    else "catalogue-not-supplied",
                ),
            )
    for e in edges:
        outgoing[e["from"]].append(e)
        if e["target"]["resourceKey"] and nodes[e["from"]]["kind"] in (
            "scaling-policy",
            "replication-policy",
            "backup-policy",
            "routing",
            "routing-pool",
            "routing-rule",
            "health-observation",
        ):
            incoming[e["target"]["resourceKey"]].append(e["from"])
    services = []
    for sid, service in sorted(catalogue.items()):
        included = set(owned[sid])
        frontier = set(included)
        limited = False
        depth_limit = config.get("maxDependencyDepth", 2)
        for depth in range(depth_limit + 1):
            following = set()
            for key in sorted(frontier):
                candidates = incoming[key] + (
                    [
                        e["target"]["resourceKey"]
                        for e in outgoing[key]
                        if e["target"]["resourceKey"]
                    ]
                    if depth < depth_limit
                    else []
                )
                for target in candidates:
                    if target in included:
                        continue
                    if len(included) - len(owned[sid]) >= config.get(
                        "maxDependenciesPerService", 1000
                    ):
                        limited = True
                        continue
                    included.add(target)
                    following.add(target)
            frontier = following
        gaps = [
            dict(
                code="transaction-capacity",
                message="Configured sizes and counts are not measured transaction capacity.",
            ),
            dict(
                code="application-paths",
                message="Configuration references do not prove application workflow dependencies.",
            ),
            dict(
                code="visibility",
                message="Selected APIs only; permission coverage remains unverified.",
            ),
        ] + conflicts

        def gap(code, msg):
            gaps.append(dict(code=code, message=msg))

        if not owned[sid]:
            gap(
                "no-tagged-resources",
                "No visible resources carry this service ID; absence is not established.",
            )
        if any(
            c["status"] != "collected" or not c["paginationComplete"]
            for c in collections
        ):
            gap(
                "partial-collection",
                "Requested coverage is missing, denied or incomplete; absence cannot establish deletion.",
            )
        if limited:
            gap("dependency-limit", "Dependency count limit reached.")
        if any(
            e["target"]["resourceKey"] and e["target"]["resourceKey"] not in included
            for k in included
            for e in outgoing[k]
        ):
            gap("dependency-depth", "References exist beyond traversal depth.")
        if any(not e["target"]["resourceKey"] for k in included for e in outgoing[k]):
            gap("unresolved-references", "Some referenced resources were not observed.")
        if any(nodes[k]["kind"] == "uninterpreted" for k in included):
            gap(
                "uninterpreted-types",
                "Some resources have no supported configuration mapping.",
            )
        services.append(
            dict(
                **service,
                memberships=[
                    dict(
                        resourceKey=k,
                        role="owned"
                        if k in owned[sid]
                        else "external-service-dependency"
                        if owner(nodes[k])
                        else "shared-or-untagged-dependency",
                    )
                    for k in sorted(included)
                ],
                gaps=gaps,
            )
        )
    return services
