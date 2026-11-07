import pytest
from botocore.stub import Stubber
import boto3
from google.auth.credentials import AnonymousCredentials
from cloud_resource_collectors.common import CollectorError, data_file, redact
from cloud_resource_collectors.collectors import (
    collect_aws,
    collect_azure,
    collect_gcp,
    ReadError,
    request,
)
from cloud_resource_collectors.sdks import AwsSdk, AzureSdk, GcpSdk

AWS = dict(accounts=[dict(id="123456789012", regions=["eu-west-2"])])
AZURE = dict(subscriptions=["11111111-1111-4111-8111-111111111111"])
GCP = dict(
    projects=[
        dict(id="example-project", number="123456789012", regions=["europe-west2"])
    ]
)


@pytest.mark.parametrize(
    "collector,config", [(collect_aws, AWS), (collect_azure, AZURE), (collect_gcp, GCP)]
)
def test_explicit_page_bounds(collector, config):
    with pytest.raises(CollectorError):
        collector(config, max_pages=0)


def aws_empty(a, region, service, operation, params):
    if service == "sts":
        return dict(Account=a["id"], Arn=f"arn:aws:iam::{a['id']}:user/test")
    spec = next(
        s
        for s in data_file("aws_specs.json")["specs"]
        if s["service"] == service and s["operation"] == operation
    )
    return {spec["result"]: []}


def test_aws_checks_all_accounts_before_resources():
    calls = []

    def run(a, r, s, o, p):
        calls.append(s)
        return dict(Account="999999999999", Arn="arn:aws:iam::999999999999:user/test")

    with pytest.raises(CollectorError):
        collect_aws(AWS, run=run)
    assert calls == ["sts"]


def test_aws_empty_selected_queries_complete():
    inv = collect_aws(AWS, run=aws_empty)
    assert inv["collections"] and all(
        c["paginationComplete"] for c in inv["collections"]
    )


@pytest.mark.parametrize("failure", ["denied", "repeat", "limit", "malformed"])
def test_aws_partial_coverage_not_silently_complete(failure):
    def run(a, r, s, o, p):
        if s == "ec2" and o == "describe-instances":
            if failure == "denied":
                raise ReadError("AccessDenied")
            if failure == "malformed":
                return dict(Reservations="bad")
            return dict(Reservations=[], NextToken="same")
        return aws_empty(a, r, s, o, p)

    inv = collect_aws(AWS, run=run, max_pages=1 if failure == "limit" else 5)
    c = next(c for c in inv["collections"] if c["source"] == "ec2:describe-instances")
    assert c["paginationComplete"] is False
    assert (
        c["errorCode"]
        == {
            "denied": "AccessDenied",
            "repeat": "RepeatedToken",
            "limit": "PageLimit",
            "malformed": "InvalidResponse",
        }[failure]
    )


def test_azure_partial_and_pagination():
    calls = []

    def run(sub, table, query, token):
        calls.append((table, token))
        if table == "ResourceContainers":
            raise ReadError("HTTP_403")
        return {
            "data": [],
            "$skipToken": "next" if not token else None,
            "resultTruncated": "false",
        }

    inv = collect_azure(AZURE, run=run)
    c = next(c for c in inv["collections"] if c["table"] == "Resources")
    assert c["pages"] == 2 and c["paginationComplete"]
    c = next(c for c in inv["collections"] if c["table"] == "ResourceContainers")
    assert c["error"] == {"code": "HTTP_403"} and not c["paginationComplete"]


def test_sdk_azure_request_scoped_and_native_pagination():
    class Client:
        def resources(self, query):
            assert query.subscriptions == AZURE["subscriptions"]
            assert query.options.skip_token == "next"
            assert query.options.top == 1000
            return type(
                "Result", (), dict(data=[], skip_token=None, result_truncated="false")
            )()

    result = AzureSdk(credential=object(), client=Client())(
        AZURE["subscriptions"][0], "Resources", "Resources", "next"
    )
    assert result["data"] == []


def test_sdk_aws_official_botocore_request():
    client = boto3.client(
        "sts",
        region_name="eu-west-2",
        aws_access_key_id="fake",
        aws_secret_access_key="fake",
    )
    sdk = AwsSdk()
    sdk._sessions[("123456789012", None)] = object()
    sdk._clients[("123456789012", None, "eu-west-2", "sts")] = client
    with Stubber(client) as stub:
        stub.add_response(
            "get_caller_identity",
            dict(
                Account="123456789012",
                Arn="arn:aws:iam::123456789012:user/test",
                UserId="test",
            ),
            {},
        )
        assert (
            sdk(AWS["accounts"][0], "eu-west-2", "sts", "get-caller-identity", {})[
                "Account"
            ]
            == "123456789012"
        )
    sdk.close()


@pytest.mark.parametrize(
    "spec", data_file("gcp_specs.json")["specs"], ids=lambda s: s["id"]
)
def test_every_gcp_sdk_request_builds_without_network(spec):
    sdk = GcpSdk(credentials=AnonymousCredentials())
    params = {
        k: int(v) if str(v).isdigit() else v == "true" if v in ("true", "false") else v
        for k, v in spec.get("query", {}).items()
    }
    try:
        req = sdk.request(
            GCP["projects"][0],
            spec,
            params,
            region="europe-west2" if spec.get("regional") else None,
        )
        assert (
            req.method == "GET"
            and "example-project" in req.uri
            or (spec.get("asset") and "123456789012" in req.uri)
        )
    finally:
        sdk.close()


@pytest.mark.parametrize("domain", ["zones", "regions"])
def test_gcp_managed_membership_sdk(domain):
    sdk = GcpSdk(credentials=AnonymousCredentials())
    try:
        req = sdk.request(
            GCP["projects"][0],
            dict(id="managed-instances"),
            dict(maxResults=500),
            parent=dict(
                nativeId=f"//compute.googleapis.com/projects/example-project/{domain}/europe-west2-a/instanceGroupManagers/test"
            ),
        )
        assert "listManagedInstances" in req.uri
    finally:
        sdk.close()


def test_gcp_adc_identity_mismatch_rejected():
    with pytest.raises(CollectorError):
        GcpSdk(
            expected_identity="someone@example.com", credentials=AnonymousCredentials()
        )


def test_retries_only_transient_and_bounded():
    attempts = []

    def run():
        attempts.append(1)
        raise ReadError("Throttling")

    with pytest.raises(ReadError):
        request(run, sleep=lambda _: None)
    assert len(attempts) == 4


def test_redaction_covers_provider_secret_fields():
    assert redact(dict(password="secret", safe=False)) == dict(
        password="[REDACTED]", safe=False
    )
    assert (
        redact(dict(metadata={"startup-script": "secret"}), gcp=True)["metadata"]
        == "[REDACTED]"
    )


@pytest.mark.parametrize(
    "mode", ["complete", "warning", "denied", "repeat", "out-of-region"]
)
def test_gcp_collection_scope_and_coverage(mode):
    def run(project, spec, params, **kwargs):
        if spec["id"] == "project":
            return dict(projectId=project["id"], projectNumber="123456789012")
        if spec["id"] == "instances":
            if mode == "denied":
                raise ReadError("HTTP_403")
            region = "us-central1" if mode == "out-of-region" else "europe-west2"
            result = dict(
                items={
                    "zones/" + region + "-a": {
                        "instances": [
                            dict(
                                selfLink=f"https://www.googleapis.com/compute/v1/projects/{project['id']}/zones/{region}-a/instances/test",
                                name="test",
                            )
                        ]
                    }
                }
            )
            if mode == "warning":
                result["unreachables"] = ["zones/europe-west2-b"]
            if mode == "repeat":
                result["nextPageToken"] = "same"
            return result
        return {spec["result"]: {} if spec.get("aggregated") else []}

    inv = collect_gcp(GCP, run=run)
    c = next(c for c in inv["collections"] if c["source"] == "instances")
    assert c["status"] == (
        "collected"
        if mode in ("complete", "out-of-region")
        else "denied"
        if mode == "denied"
        else "partial"
    )
    assert any(
        r["nativeType"] == "compute.googleapis.com/Instance" for r in inv["records"]
    ) == (mode not in ("denied", "out-of-region"))


def test_gcp_project_identity_rejected_before_resource_calls():
    calls = []

    def run(p, spec, params):
        calls.append(spec["id"])
        return dict(projectId="wrong", projectNumber="123456789012")

    with pytest.raises(CollectorError):
        collect_gcp(GCP, run=run)
    assert calls == ["project"]


def test_aws_more_than_one_thousand_instances_paginate():
    def run(a, r, s, o, p):
        if o == "describe-instances":
            count = 1 if p.get("NextToken") else 1000
            offset = 1000 if p.get("NextToken") else 0
            return dict(
                Reservations=[
                    dict(
                        Instances=[
                            dict(InstanceId="i-" + str(offset + i))
                            for i in range(count)
                        ]
                    )
                ],
                **({} if offset else {"NextToken": "next"}),
            )
        return aws_empty(a, r, s, o, p)

    inv = collect_aws(AWS, run=run)
    assert len(inv["records"]) == 1001
    assert (
        next(c for c in inv["collections"] if c["source"] == "ec2:describe-instances")[
            "pages"
        ]
        == 2
    )


def test_azure_more_than_one_thousand_resources_paginate():
    def run(sub, table, query, token):
        if table == "ResourceContainers":
            return dict(data=[])
        return {
            "data": [
                dict(
                    id=f"/subscriptions/{sub}/resourceGroups/g/providers/Microsoft.Compute/virtualMachines/{i}"
                )
                for i in (range(1000) if not token else [1000])
            ],
            "$skipToken": None if token else "next",
        }

    inv = collect_azure(AZURE, run=run)
    assert len(inv["records"]) == 1001
