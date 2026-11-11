# Run the Python cloud collector

From the repository root, install with Python 3.11 or later:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install .
```

Use an existing identity with read access and replace the placeholders below. Choose a fresh output filename for each run.

## AWS

```sh
cloud-collect --cloud aws --project YOUR_12_DIGIT_ACCOUNT_ID \
  --profile YOUR_READ_PROFILE --region eu-west-2 \
  --output runs/aws-resources.json
```

Omit `--profile` to use the default AWS credential chain. Set at least one region.

## Azure

Sign in to the intended tenant with `az login`, or use an existing workload or managed identity.

```sh
cloud-collect --cloud azure --project YOUR_SUBSCRIPTION_UUID \
  --resource-group YOUR_RESOURCE_GROUP \
  --output runs/azure-resources.json
```

Omit `--resource-group` to collect across the subscription.

## GCP

Configure Application Default Credentials with `gcloud auth application-default login` for local use, or use an existing workload identity.

```sh
cloud-collect --cloud gcp --project YOUR_PROJECT_ID \
  --region europe-west2 --output runs/gcp-resources.json
```

Set at least one region.

## Run options

Repeat `--project` to collect multiple scopes in one cloud. For per-scope settings, use `--config` in place of scope flags. See the example configurations for [AWS](../examples/aws-service.config.json), [Azure](../examples/azure-service.config.json), and [GCP](../examples/gcp-service.config.json).

Run `cloud-demo` to generate sample JSON for all three clouds without cloud credentials. For live runs, exit code `0` means the selected queries completed, `2` means partial JSON was saved, and `1` means the run failed. See the [graph guide](graph-README.md) to import the output.
