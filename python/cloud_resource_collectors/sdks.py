"""Official SDK adapters. No subprocesses or discovery-platform runtime."""

from __future__ import annotations

from .common import CollectorError, jsonable


class AwsSdk:
    def __init__(self):
        import boto3
        from botocore.config import Config

        self._session_factory = boto3.Session
        self._sdk_config = Config(
            connect_timeout=10,
            read_timeout=30,
            retries={"total_max_attempts": 1, "mode": "standard"},
        )
        self._sessions, self._clients = {}, {}

    def __call__(self, account, region, service, operation, params):
        from .common import data_file

        specs = data_file("aws_specs.json")
        allowed = {
            (s["service"], s["operation"]) for s in specs["specs"] + specs["details"]
        } | {("sts", "get-caller-identity")}
        if (service, operation) not in allowed:
            raise CollectorError("Unsupported AWS read operation")
        skey = (account["id"], account.get("profile"))
        if skey not in self._sessions:
            self._sessions[skey] = self._session_factory(
                profile_name=account.get("profile")
            )
        ckey = (*skey, region, service)
        if ckey not in self._clients:
            self._clients[ckey] = self._sessions[skey].client(
                service, region_name=region, config=self._sdk_config
            )
        return jsonable(
            getattr(self._clients[ckey], operation.replace("-", "_"))(**params)
        )

    def close(self):
        for client in self._clients.values():
            client.close()


class AzureSdk:
    def __init__(self, credential=None, client=None):
        from azure.identity import DefaultAzureCredential
        from azure.mgmt.resourcegraph import ResourceGraphClient

        self.credential = credential or DefaultAzureCredential(
            exclude_interactive_browser_credential=True
        )
        self.client = client or ResourceGraphClient(
            self.credential, retry_total=0, connection_timeout=10, read_timeout=30
        )

    def __call__(self, subscription, table, query, token):
        from azure.mgmt.resourcegraph.models import QueryRequest, QueryRequestOptions

        result = self.client.resources(
            QueryRequest(
                subscriptions=[subscription],
                query=query,
                options=QueryRequestOptions(
                    top=1000, skip_token=token, result_format="objectArray"
                ),
            )
        )
        return {
            "data": result.data,
            "$skipToken": result.skip_token,
            "resultTruncated": getattr(
                result.result_truncated, "value", result.result_truncated
            ),
        }

    def close(self):
        self.client.close()
        self.credential.close()


class GcpSdk:
    def __init__(self, expected_identity=None, credentials=None):
        import google.auth
        import google_auth_httplib2
        import httplib2
        from googleapiclient.discovery import build

        self.credentials = (
            credentials
            or google.auth.default(
                scopes=["https://www.googleapis.com/auth/cloud-platform"]
            )[0]
        )
        if expected_identity:
            actual = getattr(
                self.credentials, "service_account_email", None
            ) or getattr(self.credentials, "account", None)
            if not actual or actual != expected_identity:
                raise CollectorError(
                    "ADC identity cannot be verified against the requested identity"
                )
        self._http = google_auth_httplib2.AuthorizedHttp(
            self.credentials, http=httplib2.Http(timeout=30)
        )
        self._build, self._clients = build, {}

    def request(self, project, spec, params, *, region=None, parent=None):
        service = (
            "cloudresourcemanager"
            if spec["id"] == "project"
            else "cloudasset"
            if spec.get("asset")
            else "sqladmin"
            if spec["id"] == "sql-instances"
            else "compute"
        )
        if service not in self._clients:
            self._clients[service] = self._build(
                service,
                "v1",
                http=self._http,
                cache_discovery=False,
                static_discovery=True,
            )
        client = self._clients[service]
        if service == "cloudresourcemanager":
            return client.projects().get(projectId=project["id"])
        if service == "cloudasset":
            return client.assets().list(
                parent="projects/" + project["number"], **params
            )
        if service == "sqladmin":
            return client.instances().list(project=project["id"], **params)
        if parent:
            import re

            match = re.fullmatch(
                r"//compute\.googleapis\.com/projects/([^/]+)/(zones|regions)/([^/]+)/instanceGroupManagers/([^/]+)",
                parent["nativeId"],
            )
            if not match or match[1] not in (project["id"], project["number"]):
                raise CollectorError("Invalid managed group scope")
            resource = (
                client.instanceGroupManagers()
                if match[2] == "zones"
                else client.regionInstanceGroupManagers()
            )
            return resource.listManagedInstances(
                project=project["id"],
                instanceGroupManager=match[4],
                **{"zone" if match[2] == "zones" else "region": match[3]},
                **params,
            )
        name = spec["id"]
        if name.startswith("regional-"):
            base = name[len("regional-") :]
            name = "region" + base[0].upper() + base[1:]
        resource = getattr(client, name)()
        params = dict(params)
        method_name = "aggregatedList" if spec.get("aggregated") else "list"
        # Some bundled discovery versions omit this optional wire parameter.
        if "returnPartialSuccess" not in client._rootDesc["resources"][name]["methods"][
            method_name
        ].get("parameters", {}):
            params.pop("returnPartialSuccess", None)
        method = resource.aggregatedList if spec.get("aggregated") else resource.list
        return method(
            project=project["id"], **({"region": region} if region else {}), **params
        )

    def __call__(self, project, spec, params, *, region=None, parent=None):
        return self.request(
            project, spec, params, region=region, parent=parent
        ).execute(num_retries=0)

    def close(self):
        for client in self._clients.values():
            client.close()
