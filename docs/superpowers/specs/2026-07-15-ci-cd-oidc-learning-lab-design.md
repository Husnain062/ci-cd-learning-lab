# CI/CD + Docker + OIDC Learning Lab — Design

## Purpose

A small, throwaway, standalone project to learn — by actually running it, not just
reading about it — how a full modern CI/CD pipeline works end to end: building a
Docker image, scanning it for basic quality issues, pushing it to a container
registry, using OIDC federation to authenticate to a real secret store with no
long-lived credentials, and deploying the result to a real (if ephemeral)
Kubernetes cluster via Helm. This was prompted by wanting to understand the OIDC
mechanism used in a real-world CI pipeline to authenticate to a cloud provider
without long-lived secrets — but the lab has grown into a full free, local
equivalent of that flow rather than a narrow OIDC-only demo.

This is explicitly a learning sandbox, not production code. Optimize for
"can be understood end-to-end in one sitting," not extensibility.

## Non-goals

- Not a real deployable service. The Express app exists only to give the
  pipeline something to test, containerize, and deploy.
- Not using a real cloud account. Every piece of this pipeline — the OIDC
  federation target (HashiCorp Vault) and the Kubernetes cluster (`kind`) —
  runs self-hosted, inside the GitHub Actions runner, so the whole thing is
  free and needs no signup and no card on file anywhere.
- Not trying to replicate a full production pipeline (multi-env branching,
  Kaniko, cloud registries) — just the mechanics that were worth seeing
  hands-on: job dependencies, inter-job artifact passing, OIDC token
  issuance/claims, real OIDC-based federation, and a real deploy.
- Not adding image signing (cosign/Sigstore) or vulnerability scanning
  (Trivy) in this pass — considered and deliberately deferred to keep the
  lab understandable in one sitting. A natural follow-up if this gets
  extended later.
- The AWS side is still not executed against a real AWS account (none
  exists, and every provider requires a card even on free tier). It remains
  a short annotated reference document, now explicitly framed as "the same
  trust mechanics you just watched Vault do, expressed as AWS IAM JSON
  instead."

## Architecture

One standalone repo, `ci-cd-learning-lab`, on GitHub (public, so Actions
minutes are unlimited/free). GitHub Actions is the CI platform (native,
well-documented OIDC support; reuses the already-authenticated `gh` CLI).

```
ci-cd-learning-lab/
├── app/
│   ├── index.js              # Express app, one GET / route returning JSON
│   ├── index.test.js         # one test, using Node's built-in test runner
│   ├── package.json
│   └── Dockerfile
├── chart/
│   ├── Chart.yaml
│   ├── values.yaml
│   └── templates/
│       ├── deployment.yaml   # injects the Vault-fetched secret as an env var
│       ├── service.yaml
│       └── secret.yaml
├── .github/
│   └── workflows/
│       └── ci.yml            # the 7-job pipeline
└── docs/
    ├── superpowers/specs/    # this file
    └── aws-oidc-reference.md # annotated AWS IAM trust policy (reference only)
```

## Components

### `app/` — the sample app

Deliberately trivial: one route, one test, one Dockerfile. Its only job is to
give the pipeline something real to test, build, and deploy. Using Node's
built-in `node --test` runner (Node 18+) avoids adding a test-framework
dependency, keeping `npm ci` fast and the Dockerfile simple.

### `chart/` — the Helm chart

A minimal Helm chart replacing what would otherwise be raw `kubectl apply`
manifests: a `Deployment` (1 replica, references the GHCR image), a `Service`
(ClusterIP), and a `Secret` templated from a value supplied at install time
(`helm install ... --set secret.value=<vault-fetched-secret>`). Small enough
to read in full, but real enough to exercise `helm lint`, templating, and
`helm install`/`--set` — the actual tool used in most real Kubernetes
deployments, instead of only ever seeing raw YAML.

### `.github/workflows/ci.yml` — the pipeline

Seven jobs. The first four mirror mechanics from a real-world CI pipeline
that originally prompted this project (job dependencies, inter-job artifact
passing, Dockerfile hygiene); the last three make OIDC and a real deployment
concrete.

| Job | `needs` | Purpose |
|---|---|---|
| `lint` | — | `hadolint` against `app/Dockerfile` — fast, fails early on Dockerfile best-practice issues |
| `test` | — | `npm ci && npm test` inside `app/`, with `actions/cache` caching `node_modules` between runs |
| `build` | `test`, `lint` | `docker build` the image (with Docker layer caching via `buildx`'s GHA cache backend), `docker save` it to a `.tar`, upload as a GitHub Actions artifact |
| `push` | `build` | Download the artifact, `docker load` it, log into `ghcr.io` using the job's automatic `GITHUB_TOKEN` (GHCR trusts a job's native identity directly — no OIDC-to-cloud-IAM federation needed for this leg, worth seeing as a contrast to the Vault case below), push the image |
| `inspect-oidc` | — (parallel, independent) | Request the *real* signed OIDC JWT GitHub mints for the job (`permissions: id-token: write`, fetch from `ACTIONS_ID_TOKEN_REQUEST_URL`), decode its payload (base64, no library needed), print the real claims (`iss`, `aud`, `sub`, `repository`, `ref`) to the job log |
| `deploy` | `push` | See below — the federation-and-deploy job |

**Inside `deploy`:**
1. A HashiCorp Vault container runs as a GitHub Actions *service container* in
   dev mode (auto-unsealed — fine for a lab, explicitly not a production
   pattern).
2. A setup step configures Vault's JWT auth method to trust
   `https://token.actions.githubusercontent.com`, with a role whose
   `bound_claims` restrict `sub` to this exact repo, and writes one dummy
   secret (e.g. `DEMO_SECRET=hello-from-vault`) to a KV path.
3. The job requests its own real GitHub OIDC token and authenticates to
   Vault with it. This is the actual federation moment: Vault independently
   fetches GitHub's public signing keys, verifies the JWT's signature, and
   checks the `sub` claim before issuing a short-lived Vault token — no
   secret was ever stored in GitHub.
4. Using that Vault token, the job reads the dummy secret.
5. `kind` creates a real (if throwaway) Kubernetes cluster on the runner
   (uses the Docker driver already present on GitHub-hosted runners — no VM
   setup, unlike `minikube`).
6. `helm install` deploys `chart/`, pulling the image just pushed to GHCR and
   passing the Vault-fetched secret in via `--set`.
7. `kubectl wait --for=condition=Ready pod`, then `curl` the service to
   confirm the app actually responds with real JSON.
8. Vault and the `kind` cluster both disappear when the job ends — nothing
   persists, nothing costs anything.

### `docs/aws-oidc-reference.md` — the AWS half, annotated but not executed

Contains the actual JSON you'd apply on AWS to make an IAM role trust the
token minted in `inspect-oidc`, now explicitly cross-referenced against what
`deploy` does for real with Vault:
- The `aws_iam_openid_connect_provider` config — what it means for AWS to
  "trust GitHub's signing keys," annotated next to the equivalent Vault JWT
  auth method config actually applied in this repo.
- An IAM role trust policy with a `Condition` block on
  `token.actions.githubusercontent.com:sub`, annotated against both the
  *actual* `sub` claim value printed by `inspect-oidc` and the equivalent
  `bound_claims` condition in Vault's role — so the mapping from "value you
  saw in a log" → "condition in a trust policy" is concrete in two systems,
  not one.
- A short note on the follow-up path: if a personal AWS account gets created
  later, this file becomes the exact `aws iam create-open-id-connect-provider`
  / `aws iam create-role` commands to run — no redesign needed, just execution.

## Data flow

```
push to GitHub
  → lint runs (Dockerfile hygiene)
  → test runs (cached npm ci)
      ├─ lint + test pass → build (cached docker layers) → artifact uploaded
      │     → push → image in GHCR
      │       → deploy:
      │           Vault (dev mode) configured to trust GitHub's OIDC issuer
      │           → job authenticates with its real OIDC token → Vault token → reads secret
      │           → kind cluster created → helm install (image from GHCR, secret injected)
      │           → pod Running → curl confirms live response
      └─ lint or test fail → build/push/deploy all skipped entirely (needs: not satisfied)

  → inspect-oidc runs independently, in parallel with the rest
      → prints decoded JWT claims to the job log
```

## Validation plan

1. Push to GitHub, watch the Actions tab live across all 7 jobs.
2. Confirm the image lands in the repo's GHCR "Packages" tab.
3. Confirm `inspect-oidc`'s log shows real decoded JWT claims (not
   placeholders).
4. Confirm `deploy`'s log shows a real Vault token issued in exchange for the
   OIDC JWT (not a hardcoded value), and the secret read back afterward.
5. Confirm the pod reaches `Running` and the `curl` step prints the app's
   real JSON response.
6. Deliberately break the one test in a throwaway commit, push, and confirm
   `build`, `push`, and `deploy` are all skipped (grey "skipped," not run) —
   proves the `needs:` dependency chain is real, not just visually implied.
7. Revert the broken test, confirm the chain runs green end-to-end again.

## Testing

The "tests" here are the validation-plan steps above, run by hand against the
real GitHub Actions UI — there's no meta-test-suite for a CI pipeline this
small; watching it actually behave correctly (and incorrectly, on the
broken-test step) is the test.
