# CI/CD + Docker + OIDC Learning Lab — Design

## Purpose

A small, throwaway, standalone project to learn — by actually running it, not just
reading about it — how a CI/CD pipeline builds a Docker image, pushes it to a
container registry, and how OIDC-based federation (the mechanism used in
`developer-hub-services`'s GitLab CI to authenticate to AWS without long-lived
secrets) actually works under the hood.

This is explicitly a learning sandbox, not production code. Optimize for
"can be understood end-to-end in one sitting," not extensibility.

## Non-goals

- Not a real deployable service. The Express app exists only to give the
  pipeline something to test and containerize.
- Not testing a real AWS account in this first pass — no personal AWS account
  is available, and every real cloud provider requires a card on file even on
  free tier. The AWS-side OIDC trust config is documented as an annotated
  reference (readable, mapped to real values we'll observe), not executed.
- Not trying to replicate `developer-hub-services`'s full pipeline (multi-env
  branching, Kaniko, ECR) — just the mechanics that were unclear: job
  dependencies, inter-job artifact passing, and OIDC token issuance/claims.

## Architecture

One new standalone repo, `ci-cd-learning-lab`, on GitHub (public, so Actions
minutes are unlimited/free). GitHub Actions is the CI platform (chosen over
GitLab.com specifically so we get native, well-documented OIDC support and
reuse the already-authenticated `gh` CLI).

```
ci-cd-learning-lab/
├── app/
│   ├── index.js          # Express app, one GET / route returning JSON
│   ├── index.test.js     # one test, using Node's built-in test runner
│   ├── package.json
│   └── Dockerfile
├── .github/
│   └── workflows/
│       └── ci.yml        # the 4-job pipeline
└── docs/
    ├── superpowers/specs/   # this file
    └── aws-oidc-reference.md  # annotated AWS IAM trust policy (reference only)
```

## Components

### `app/` — the sample app

Deliberately trivial: one route, one test, one Dockerfile. Its only job is to
give the pipeline something real to test and build. Using Node's built-in
`node --test` runner (Node 18+) avoids adding a test-framework dependency,
keeping `npm ci` fast and the Dockerfile simple.

### `.github/workflows/ci.yml` — the pipeline

Four jobs, chosen to mirror the two mechanics from `developer-hub-services`'s
real pipeline that prompted this project — job dependencies (`needs:`) and
inter-job data passing (the `build.env` dotenv pattern) — plus one job that
exists purely to make OIDC concrete.

| Job | `needs` | Purpose |
|---|---|---|
| `test` | — | `npm ci && npm test` inside `app/` |
| `build` | `test` | `docker build` the image, `docker save` it to a `.tar`, upload as a GitHub Actions artifact. This is the closer analogue to `build.env`/`dotenv` artifacts than a string output would be — passing an actual binary blob between jobs is the same mechanic your real `container-build` jobs rely on (Kaniko produces the image; the *next* job needs it) |
| `push` | `build` | Download the artifact, `docker load` it, log into `ghcr.io` using the job's automatic, built-in `GITHUB_TOKEN` (GHCR trusts a job's native identity directly — no OIDC-to-cloud-IAM federation needed for this leg, which is worth seeing as a contrast to the AWS case), push the image |
| `inspect-oidc` | — (parallel, independent) | Request the *real* signed OIDC JWT GitHub mints for the job (`permissions: id-token: write`, fetch from `ACTIONS_ID_TOKEN_REQUEST_URL`), decode its payload (base64, no library needed — just `cut`/`base64 -d`/`jq`), print the real claims (`iss`, `aud`, `sub`, `repository`, `ref`) to the job log |

### `docs/aws-oidc-reference.md` — the AWS half, annotated but not executed

Contains the actual JSON you'd apply on AWS to make an IAM role trust the
token minted in `inspect-oidc`:
- The `aws_iam_openid_connect_provider` config (or equivalent Terraform/JSON) —
  what it means for AWS to "trust GitHub's signing keys."
- An IAM role trust policy with a `Condition` block on `token.actions.githubusercontent.com:sub`,
  annotated against the *actual* `sub` claim value printed by `inspect-oidc` in
  this repo, so the mapping from "value you saw in a log" to "value in a trust
  policy" is concrete, not abstract.
- A short note on the follow-up path: if a personal AWS account gets created
  later, this file becomes the exact `aws iam create-open-id-connect-provider`
  / `aws iam create-role` commands to run — no redesign needed, just execution.

## Data flow

```
push to GitHub
  → test job runs
      ├─ pass → build job runs → artifact uploaded → push job runs → image in GHCR
      └─ fail → build and push jobs are skipped entirely (needs: not satisfied)

  → inspect-oidc job runs independently, in parallel with test/build/push
      → prints decoded JWT claims to the job log
```

## Validation plan

1. Push to GitHub, watch the Actions tab live.
2. Confirm the image lands in the repo's GHCR "Packages" tab.
3. Confirm `inspect-oidc`'s log shows real decoded JWT claims (not placeholders).
4. Deliberately break the one test in a throwaway commit, push, and confirm
   `build` and `push` are skipped (grey "skipped," not run) — proves the
   `needs:` dependency chain is real, not just visually implied.
5. Revert the broken test, confirm the chain runs green end-to-end again.

## Testing

The "tests" here are the validation-plan steps above, run by hand against the
real GitHub Actions UI — there's no meta-test-suite for a CI pipeline this
small; watching it actually behave correctly (and incorrectly, on the
broken-test step) is the test.
