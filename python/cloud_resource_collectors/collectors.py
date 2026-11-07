"""Read-only cloud SDK collection, explicit scopes, bounded pagination and errors."""

from __future__ import annotations

import re
import time
from urllib.parse import urlparse, quote

from .common import CollectorError, data_file, dumps, redact, utc_now
from .config import validate_config


class ReadError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


SAFE_CODES = {
    "AccessDenied",
    "AccessDeniedException",
    "UnauthorizedOperation",
    "AuthFailure",
    "Throttling",
    "ThrottlingException",
    "RequestLimitExceeded",
    "ServiceUnavailable",
    "ServiceUnavailableException",
    "InternalError",
    "InternalFailure",
    "ExpiredToken",
    "ExpiredTokenException",
    "PageLimit",
    "InvalidResponse",
    "RepeatedToken",
    "InvalidResourceIdentity",
    "OutOfScopeResource",
    "ProviderWarning",
}
RETRY_CODES = {
    "Throttling",
    "ThrottlingException",
    "RequestLimitExceeded",
    "ServiceUnavailable",
    "ServiceUnavailableException",
    "InternalError",
    "InternalFailure",
    "HTTP_429",
    "HTTP_500",
    "HTTP_502",
    "HTTP_503",
    "HTTP_504",
}


def error_code(exc):
    code = getattr(exc, "code", None)
    if not isinstance(code, str):
        response = getattr(exc, "response", {})
        code = (
            response.get("Error", {}).get("Code")
            if isinstance(response, dict)
            else None
        )
    status = getattr(exc, "status_code", None) or getattr(
        getattr(exc, "resp", None), "status", None
    )
    if code in SAFE_CODES or (
        isinstance(code, str) and re.fullmatch(r"HTTP_\d{3}", code)
    ):
        return code
    return "HTTP_" + str(status) if type(status) is int else "RequestFailed"


def request(call, sleep=time.sleep):
    for attempt in range(4):
        try:
            return call()
        except Exception as exc:
            if attempt == 3 or error_code(exc) not in RETRY_CODES:
                raise
            sleep(0.25 * 2**attempt)


def collection(id_, scope, source, now):
    return dict(
        id=id_,
        **scope,
        source=source,
        status="partial",
        paginationComplete=False,
        permissionCoverage="unverified",
        startedAt=now(),
        finishedAt=None,
        pages=0,
        recordCount=0,
        errorCode=None,
    )


def mark_error(c, exc):
    c["errorCode"] = error_code(exc)
    c["status"] = (
        "denied"
        if c["errorCode"]
        in {
            "AccessDenied",
            "AccessDeniedException",
            "UnauthorizedOperation",
            "HTTP_403",
        }
        else "partial"
    )


def next_token(result, field, seen):
    token = result.get(field)
    if token is not None and not isinstance(token, str):
        raise ReadError("InvalidResponse")
    if token and token in seen:
        raise ReadError("RepeatedToken")
    if token:
        seen.add(token)
    return token or None


def collect_aws(config, *, run=None, sleep=time.sleep, now=utc_now, max_pages=1000):
    validate_config("aws", config)
    if type(max_pages) is not int or not 1 <= max_pages <= 10000:
        raise CollectorError("Invalid pagination bound")
    owner = None
    if run is None:
        from .sdks import AwsSdk

        owner = run = AwsSdk()
    spec_data = data_file("aws_specs.json")
    inv = dict(
        inventoryVersion="aws-api-inventory/0.1",
        provider="aws",
        startedAt=now(),
        finishedAt=None,
        accounts=[
            dict(id=a["id"], partition=a.get("partition", "aws"), regions=a["regions"])
            for a in config["accounts"]
        ],
        collections=[],
        records=[],
        limitations=[
            "Only selected EC2, Auto Scaling, ELBv2, RDS and regional tagging APIs are collected.",
            "Permission coverage is unverified. Observations are not an atomic snapshot.",
            "Unsupported untagged resources, global ingress, scheduled scaling, warm pools and template versions are not collected.",
        ],
    )
    try:
        for a in config["accounts"]:
            identity = request(
                lambda: run(a, a["regions"][0], "sts", "get-caller-identity", {}), sleep
            )
            if identity.get("Account") != a["id"] or not identity.get(
                "Arn", ""
            ).startswith("arn:" + a.get("partition", "aws") + ":"):
                raise CollectorError(
                    "AWS signed-in account or partition differs from configured scope"
                )

        def collect(a, region, spec, params=None, parent=None):
            c = collection(
                "collection-" + str(len(inv["collections"])),
                dict(
                    accountId=a["id"],
                    partition=a.get("partition", "aws"),
                    region=region,
                ),
                spec["service"] + ":" + spec["operation"],
                now,
            )
            if parent:
                c["parentId"] = parent
            inv["collections"].append(c)
            token, seen = None, set()
            try:
                while True:
                    if c["pages"] >= max_pages:
                        raise ReadError("PageLimit")
                    args = dict(params or {})
                    if token:
                        args[spec["token"]] = token
                    result = request(
                        lambda: run(
                            a, region, spec["service"], spec["operation"], args
                        ),
                        sleep,
                    )
                    rows = result.get(spec["result"])
                    if not isinstance(rows, list):
                        raise ReadError("InvalidResponse")
                    if spec.get("flatten"):
                        if any(
                            not isinstance(row.get(spec["flatten"]), list)
                            for row in rows
                        ):
                            raise ReadError("InvalidResponse")
                        rows = [item for row in rows for item in row[spec["flatten"]]]
                    c["pages"] += 1
                    for row in rows:
                        native = (
                            row.get(spec["id"])
                            if "id" in spec
                            else parent
                            + "#target/"
                            + "/".join(
                                quote(str(row.get("Target", {}).get(k, "")), safe="")
                                for k in ("Id", "Port", "AvailabilityZone")
                            )
                        )
                        if not isinstance(native, str) or not native:
                            raise ReadError("InvalidResponse")
                        if spec.get("arn"):
                            native = f"arn:{a.get('partition', 'aws')}:ec2:{region}:{a['id']}:{spec['arn']}/{native}"
                        inv["records"].append(
                            dict(
                                collectionId=c["id"],
                                accountId=a["id"],
                                partition=a.get("partition", "aws"),
                                region=region,
                                observedAt=now(),
                                nativeId=native,
                                nativeType=spec["type"],
                                kind=spec["kind"],
                                parentId=parent,
                                configuration=redact(row),
                            )
                        )
                        c["recordCount"] += 1
                    token = next_token(
                        result, spec.get("outToken", spec.get("token", "__none")), seen
                    )
                    if not token:
                        break
                c.update(status="collected", paginationComplete=True)
            except Exception as exc:
                mark_error(c, exc)
            finally:
                c["finishedAt"] = now()

        for a in config["accounts"]:
            for index, region in enumerate(a["regions"]):
                for spec in spec_data["specs"]:
                    if not spec.get("once") or index == 0:
                        collect(a, region, spec)
                for spec in spec_data["details"]:
                    for parent in list(inv["records"]):
                        if (
                            parent["accountId"] == a["id"]
                            and parent["region"] == region
                            and parent["nativeType"] == spec["parent"]
                        ):
                            collect(
                                a,
                                region,
                                spec,
                                {spec["parameter"]: parent["nativeId"]},
                                parent["nativeId"],
                            )
        inv["finishedAt"] = now()
        return inv
    finally:
        if owner:
            owner.close()


def collect_azure(config, *, run=None, sleep=time.sleep, now=utc_now, max_pages=1000):
    validate_config("azure", config)
    if type(max_pages) is not int or not 1 <= max_pages <= 10000:
        raise CollectorError("Invalid pagination bound")
    owner = None
    if run is None:
        from .sdks import AzureSdk

        owner = run = AzureSdk()
    inv = dict(
        inventoryVersion="azure-resource-graph/0.1",
        provider="azure",
        subscriptions=config["subscriptions"],
        startedAt=now(),
        finishedAt=None,
        collections=[],
        records=[],
        limitations=[
            "Resource Graph visibility and provider detail coverage are unverified.",
            "Only Resources and ResourceContainers are collected; configuration is not an atomic snapshot.",
        ],
    )
    try:
        for sub in config["subscriptions"]:
            for table in ("Resources", "ResourceContainers"):
                c = dict(
                    subscriptionId=sub,
                    table=table,
                    status="partial",
                    paginationComplete=False,
                    permissionCoverage="unverified",
                    startedAt=now(),
                    finishedAt=None,
                    pages=0,
                    recordCount=0,
                    error=None,
                )
                inv["collections"].append(c)
                groups = config.get("resourceGroups")
                where = (
                    " | where "
                    + ("resourceGroup" if table == "Resources" else "name")
                    + " in~ ("
                    + ",".join(dumps(g) for g in groups)
                    + ")"
                    if groups
                    else ""
                )
                query = (
                    table
                    + where
                    + " | project id, name, type, location, subscriptionId, resourceGroup, tags, "
                    + ("zones, sku, kind, " if table == "Resources" else "")
                    + "properties | order by id asc"
                )
                token, seen = None, set()
                try:
                    while True:
                        if c["pages"] >= max_pages:
                            raise ReadError("PageLimit")
                        result = request(lambda: run(sub, table, query, token), sleep)
                        if not isinstance(result.get("data"), list):
                            raise ReadError("InvalidResponse")
                        c["pages"] += 1
                        for row in result["data"]:
                            if not isinstance(row.get("id"), str):
                                raise ReadError("InvalidResponse")
                            inv["records"].append(
                                dict(
                                    table=table,
                                    subscriptionId=sub,
                                    observedAt=now(),
                                    resource=redact(row),
                                )
                            )
                            c["recordCount"] += 1
                        token = next_token(result, "$skipToken", seen)
                        if (
                            not token
                            and str(result.get("resultTruncated", "false")).lower()
                            == "true"
                        ):
                            raise ReadError("InvalidResponse")
                        if not token:
                            break
                    c.update(status="collected", paginationComplete=True)
                except Exception as exc:
                    c["error"] = {"code": error_code(exc)}
                finally:
                    c["finishedAt"] = now()
        inv["records"].sort(key=lambda r: r["resource"]["id"])
        inv["collections"].sort(key=lambda c: c["subscriptionId"] + c["table"])
        inv["finishedAt"] = now()
        return inv
    finally:
        if owner:
            owner.close()


def canonical_gcp(value):
    if not isinstance(value, str):
        return None
    if value.startswith("projects/"):
        return "//compute.googleapis.com/" + value
    if value.startswith("//"):
        return value.replace(
            "//sqladmin.googleapis.com/", "//cloudsql.googleapis.com/", 1
        )
    u = urlparse(value)
    if u.scheme != "https" or u.query or u.fragment:
        return None
    if u.hostname in {
        "www.googleapis.com",
        "compute.googleapis.com",
    } and u.path.startswith("/compute/v1/projects/"):
        return "//compute.googleapis.com/" + u.path[len("/compute/v1/") :]
    if u.hostname == "sqladmin.googleapis.com":
        path = re.sub(r"^/(?:sql/)?v1(?:beta4)?/", "", u.path)
        if path.startswith("projects/"):
            return "//cloudsql.googleapis.com/" + path
    return None


def gcp_location(name, data, hint=None):
    zone = (data.get("zone") or data.get("gceZone") or "").split("/")[-1] or None
    match = re.search(r"/zones/([^/]+)", name)
    zone = zone or (match[1] if match else None)
    match = re.search(r"/regions/([^/]+)", name)
    region = (data.get("region") or "").split("/")[-1] or (match[1] if match else None)
    region = region or (
        re.sub(r"-[a-z]$", "", zone)
        if zone
        else re.sub(r"-[a-z]$", "", hint)
        if hint and hint != "global"
        else None
    )
    return region, zone


def collect_gcp(config, *, run=None, sleep=time.sleep, now=utc_now, max_pages=1000):
    validate_config("gcp", config)
    if type(max_pages) is not int or not 1 <= max_pages <= 10000:
        raise CollectorError("Invalid pagination bound")
    owner = None
    if run is None:
        from .sdks import GcpSdk

        owner = run = GcpSdk(config.get("account"))
    specs = data_file("gcp_specs.json")["specs"]
    inv = dict(
        inventoryVersion="gcp-api-inventory/0.1",
        provider="gcp",
        projects=[],
        startedAt=now(),
        finishedAt=None,
        collections=[],
        records=[],
        limitations=[
            "Only selected Compute, Cloud SQL, Asset Inventory and project metadata APIs are collected.",
            "Permission coverage and Asset Inventory freshness are unverified; observations are not atomic.",
            "Configured placement and target sizes are not proof of application health or throughput.",
        ],
    )
    try:
        for p in config["projects"]:
            row = request(lambda: run(p, {"id": "project"}, {}), sleep)
            number = str(row.get("projectNumber", ""))
            if (
                row.get("projectId") != p["id"]
                or not re.fullmatch(r"\d{6,20}", number)
                or (p.get("number") and p["number"] != number)
            ):
                raise CollectorError(
                    "GCP project ID or project number differs from configured scope"
                )
            project = dict(id=p["id"], number=number, regions=p["regions"])
            inv["projects"].append(project)
            c = collection(
                "collection-" + str(len(inv["collections"])),
                {"projectId": p["id"]},
                "cloudresourcemanager:projects.get",
                now,
            )
            c.update(
                status="collected",
                paginationComplete=True,
                pages=1,
                recordCount=1,
                finishedAt=now(),
            )
            inv["collections"].append(c)
            inv["records"].append(
                dict(
                    collectionId=c["id"],
                    projectId=p["id"],
                    projectNumber=number,
                    observedAt=now(),
                    nativeId="//cloudresourcemanager.googleapis.com/projects/" + number,
                    nativeType="cloudresourcemanager.googleapis.com/Project",
                    kind="project",
                    parentId=None,
                    configuration=redact(row, gcp=True),
                )
            )

        def collect(project, spec, region=None, parent=None):
            c = collection(
                "collection-" + str(len(inv["collections"])),
                {"projectId": project["id"]},
                spec["id"] + (":" + region if region else ""),
                now,
            )
            if parent:
                c["parentId"] = parent["nativeId"]
            inv["collections"].append(c)
            token, seen, warned = None, set(), False
            try:
                while True:
                    if c["pages"] >= max_pages:
                        raise ReadError("PageLimit")
                    params = dict(spec.get("query", {}))
                    params = {
                        k: int(v)
                        if k in {"pageSize", "maxResults"}
                        else v == "true"
                        if k == "returnPartialSuccess"
                        else v
                        for k, v in params.items()
                    }
                    if token:
                        params["pageToken"] = token
                    result = request(
                        lambda: run(
                            project, spec, params, region=region, parent=parent
                        ),
                        sleep,
                    )
                    c["pages"] += 1
                    warned |= bool(result.get("unreachables") or result.get("warnings"))
                    if spec.get("aggregated"):
                        items = result.get("items", {})
                        if not isinstance(items, dict):
                            raise ReadError("InvalidResponse")
                        rows = []
                        for scope in items.values():
                            if scope.get("warning", {}).get("code") not in (
                                None,
                                "NO_RESULTS_ON_PAGE",
                            ):
                                warned = True
                            group = scope.get(spec["result"], [])
                            if not isinstance(group, list):
                                raise ReadError("InvalidResponse")
                            rows.extend(group)
                    else:
                        rows = result.get(spec["result"], [])
                        if not isinstance(rows, list):
                            raise ReadError("InvalidResponse")
                    if result.get("warning", {}).get("code") not in (
                        None,
                        "NO_RESULTS_ON_PAGE",
                    ):
                        warned = True
                    for row in rows:
                        asset = bool(spec.get("asset"))
                        data = row.get("resource", {}).get("data", {}) if asset else row
                        name = canonical_gcp(
                            row.get("name") if asset else row.get("selfLink")
                        )
                        if spec["id"] == "sql-instances":
                            name = (
                                "//cloudsql.googleapis.com/projects/"
                                + project["id"]
                                + "/instances/"
                                + row["name"]
                                if isinstance(row.get("name"), str) and row["name"]
                                else None
                            )
                        if parent:
                            member = canonical_gcp(row.get("instance"))
                            name = (
                                parent["nativeId"]
                                + "/members/"
                                + quote(member, safe="")
                                if member
                                else None
                            )
                        if not name:
                            raise ReadError("InvalidResourceIdentity")
                        match = re.search(r"/projects/([^/]+)", name)
                        if match and match[1] not in (project["id"], project["number"]):
                            raise ReadError("OutOfScopeResource")
                        location, _ = gcp_location(
                            name,
                            data,
                            row.get("resource", {}).get("location") if asset else None,
                        )
                        if location and location not in project["regions"]:
                            continue
                        type_ = row.get("assetType") if asset else spec["type"]
                        if not isinstance(type_, str) or not type_:
                            raise ReadError("InvalidResponse")
                        kind = (
                            next(
                                (s["kind"] for s in specs if s.get("type") == type_),
                                "uninterpreted",
                            )
                            if asset
                            else spec["kind"]
                        )
                        inv["records"].append(
                            dict(
                                collectionId=c["id"],
                                projectId=project["id"],
                                projectNumber=project["number"],
                                observedAt=now(),
                                nativeId=name,
                                nativeType=type_,
                                kind=kind,
                                configuration=redact(row, gcp=True),
                                parentId=parent["nativeId"] if parent else None,
                                asset=asset,
                            )
                        )
                        c["recordCount"] += 1
                    token = next_token(result, "nextPageToken", seen)
                    if not token:
                        break
                c.update(
                    status="partial" if warned else "collected",
                    paginationComplete=True,
                    errorCode="ProviderWarning" if warned else None,
                )
            except Exception as exc:
                mark_error(c, exc)
            finally:
                c["finishedAt"] = now()

        for project in inv["projects"]:
            for spec in specs:
                for region in project["regions"] if spec.get("regional") else [None]:
                    collect(project, spec, region)
            for parent in list(inv["records"]):
                if (
                    parent["projectId"] == project["id"]
                    and parent["nativeType"]
                    == "compute.googleapis.com/InstanceGroupManager"
                    and not parent.get("asset")
                ):
                    collect(
                        project,
                        dict(
                            id="managed-instances",
                            result="managedInstances",
                            type="collector.gcp/ManagedInstanceObservation",
                            kind="health-observation",
                            query={"maxResults": "500"},
                        ),
                        parent=parent,
                    )
        inv["finishedAt"] = now()
        return inv
    finally:
        if owner:
            owner.close()
