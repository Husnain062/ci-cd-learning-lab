# CI/CD + Docker + OIDC Learning Lab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the full `ci-cd-learning-lab` repo: an Express app deployed through a 7-job GitHub Actions pipeline that lints, tests, builds, pushes to GHCR, federates with a self-hosted Vault via real GitHub OIDC, and deploys via Helm into a throwaway `kind` cluster — all free, no external accounts.

**Architecture:** One GitHub Actions workflow (`.github/workflows/ci.yml`) orchestrates `lint → test → build → push → deploy`, plus an independent parallel `inspect-oidc` job. `deploy` runs Vault (dev mode, as a GHA service container) and `kind` entirely inside the job — nothing persists past the job, nothing costs money. The app itself is deployed via a small first-party Helm chart (`chart/`).

**Tech Stack:** Node.js 20 + Express 5, `node --test`, Docker, GitHub Actions, HashiCorp Vault (JWT/OIDC auth method), `kind`, Helm, `hadolint`.

## Global Constraints

- Everything must run free, with no signup and no card on file anywhere (per spec Non-goals) — Vault and Kubernetes both run self-hosted inside the GitHub Actions runner, never against an external managed service.
- Repo is public on GitHub so Actions minutes are unlimited.
- Node 18+ (`node --test` built-in runner) — plan uses Node 20 in Docker/CI; local dev machine has Node 22, both satisfy the floor.
- No test-framework dependency beyond Node's built-in `node:test` and global `fetch`.
- Image signing (cosign) and vulnerability scanning (Trivy) are explicitly out of scope for this pass (spec Non-goals) — do not add them.
- GHCR authentication for `push` and `deploy` uses the job's automatic `GITHUB_TOKEN` — never a personal access token or long-lived secret.
- AWS is never touched by any task in this plan — `docs/aws-oidc-reference.md` is a static annotated reference only.

---

## Task 1: Create the GitHub repository

**Files:** none (infrastructure step)

**Interfaces:**
- Produces: a `origin` git remote at `github.com/Husnain062/ci-cd-learning-lab`, public, with the existing local history pushed to `main`.

- [ ] **Step 1: Create the repo and push existing history**

Run:
```bash
gh repo create ci-cd-learning-lab --public --source=. --remote=origin --push
```
Expected: command prints the new repo URL; no errors.

- [ ] **Step 2: Verify**

Run:
```bash
git remote -v
gh repo view Husnain062/ci-cd-learning-lab --json visibility,url
```
Expected: `origin` remote pointing at the new repo; `"visibility": "PUBLIC"`.

---

## Task 2: Scaffold the Express app (TDD)

**Files:**
- Create: `app/package.json`
- Create: `app/index.js`
- Create: `app/index.test.js`
- Create: `.gitignore`

**Interfaces:**
- Produces: `module.exports = app` from `app/index.js` — an Express app instance with one route, `GET /`, returning JSON `{ message: string, secret: string | null }`. `secret` is read from `process.env.DEMO_SECRET`.

- [ ] **Step 1: Add root `.gitignore`**

```
node_modules/
*.tar
```

- [ ] **Step 2: Create `app/package.json`**

```json
{
  "name": "ci-cd-learning-lab-app",
  "version": "1.0.0",
  "private": true,
  "type": "commonjs",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "test": "node --test"
  },
  "dependencies": {
    "express": "^5.2.1"
  }
}
```

- [ ] **Step 3: Install dependencies to generate the lockfile**

Run:
```bash
cd app && npm install
```
Expected: `app/package-lock.json` and `app/node_modules/` created, no errors.

- [ ] **Step 4: Write the failing test**

Create `app/index.test.js`:
```js
const assert = require('node:assert');
const { test } = require('node:test');
const app = require('./index');

test('GET / returns json with a message and secret field', async () => {
  const server = app.listen(0);
  const { port } = server.address();

  try {
    const res = await fetch(`http://localhost:${port}/`);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(body.message, 'ci-cd-learning-lab is alive');
    assert.ok('secret' in body);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 5: Run test to verify it fails**

Run:
```bash
cd app && npm test
```
Expected: FAIL — `Error: Cannot find module './index'`.

- [ ] **Step 6: Write minimal implementation**

Create `app/index.js`:
```js
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({
    message: 'ci-cd-learning-lab is alive',
    secret: process.env.DEMO_SECRET || null,
  });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`listening on port ${port}`);
  });
}

module.exports = app;
```

- [ ] **Step 7: Run test to verify it passes**

Run:
```bash
cd app && npm test
```
Expected: PASS — 1 test, 0 failures.

- [ ] **Step 8: Commit**

```bash
git add .gitignore app/package.json app/package-lock.json app/index.js app/index.test.js
git commit -m "feat: scaffold Express app with one route and one test"
git push
```

---

## Task 3: Dockerize the app

**Files:**
- Create: `app/Dockerfile`

**Interfaces:**
- Consumes: `app/package.json`, `app/package-lock.json`, `app/index.js` (Task 2)
- Produces: a Docker image, built locally as `app:local` for verification, that runs `node index.js` and serves on port 3000.

- [ ] **Step 1: Write the Dockerfile**

Create `app/Dockerfile`:
```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js ./

EXPOSE 3000

CMD ["node", "index.js"]
```

- [ ] **Step 2: Start Docker Desktop if not running**

Run:
```bash
docker info >/dev/null 2>&1 && echo "docker is running" || echo "start Docker Desktop, then re-run this check"
```
Expected: "docker is running" (start Docker Desktop manually first if not).

- [ ] **Step 3: Build the image**

Run:
```bash
cd app && docker build -t app:local .
```
Expected: build succeeds, ends with `naming to docker.io/library/app:local`.

- [ ] **Step 4: Run it and verify the route works**

Run:
```bash
docker run -d --rm --name app-local -p 3000:3000 -e DEMO_SECRET=local-test app:local
sleep 1
curl -sf http://localhost:3000/ | jq .
docker stop app-local
```
Expected JSON:
```json
{
  "message": "ci-cd-learning-lab is alive",
  "secret": "local-test"
}
```

- [ ] **Step 5: Lint the Dockerfile**

Run:
```bash
docker run --rm -i hadolint/hadolint < app/Dockerfile
```
Expected: no output (no lint findings). If findings appear, fix them before continuing.

- [ ] **Step 6: Commit**

```bash
git add app/Dockerfile
git commit -m "feat: add Dockerfile for the app"
git push
```

---

## Task 4: Write the Helm chart and verify it locally with kind

**Files:**
- Create: `chart/Chart.yaml`
- Create: `chart/values.yaml`
- Create: `chart/templates/deployment.yaml`
- Create: `chart/templates/service.yaml`
- Create: `chart/templates/secret.yaml`

**Interfaces:**
- Consumes: `app:local` image built in Task 3 (for the local `kind` dry run only — CI will use the real GHCR image).
- Produces: a Helm chart, installable as `helm install <release> ./chart --set image.repository=<repo> --set image.tag=<tag> --set secret.value=<value> [--set imagePullSecrets[0].name=<name>]`. Values: `image.repository` (string), `image.tag` (string), `image.pullPolicy` (string), `replicaCount` (int), `service.type`/`service.port`/`service.targetPort`, `secret.value` (string), `imagePullSecrets` (list of `{name}`).

- [ ] **Step 1: Write `chart/Chart.yaml`**

```yaml
apiVersion: v2
name: ci-cd-learning-lab
description: Helm chart for the ci-cd-learning-lab demo app
type: application
version: 0.1.0
appVersion: "1.0.0"
```

- [ ] **Step 2: Write `chart/values.yaml`**

```yaml
image:
  repository: ghcr.io/example/ci-cd-learning-lab
  tag: latest
  pullPolicy: IfNotPresent

replicaCount: 1

service:
  type: ClusterIP
  port: 80
  targetPort: 3000

secret:
  value: "placeholder-not-set"

imagePullSecrets: []
```

- [ ] **Step 3: Write `chart/templates/deployment.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}
  labels:
    app: {{ .Release.Name }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      app: {{ .Release.Name }}
  template:
    metadata:
      labels:
        app: {{ .Release.Name }}
    spec:
      {{- if .Values.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml .Values.imagePullSecrets | nindent 8 }}
      {{- end }}
      containers:
        - name: app
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - containerPort: {{ .Values.service.targetPort }}
          env:
            - name: DEMO_SECRET
              valueFrom:
                secretKeyRef:
                  name: {{ .Release.Name }}-secret
                  key: value
```

- [ ] **Step 4: Write `chart/templates/service.yaml`**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}
spec:
  type: {{ .Values.service.type }}
  selector:
    app: {{ .Release.Name }}
  ports:
    - port: {{ .Values.service.port }}
      targetPort: {{ .Values.service.targetPort }}
```

- [ ] **Step 5: Write `chart/templates/secret.yaml`**

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: {{ .Release.Name }}-secret
type: Opaque
stringData:
  value: {{ .Values.secret.value | quote }}
```

- [ ] **Step 6: Lint the chart**

Run:
```bash
helm lint ./chart
```
Expected: `1 chart(s) linted, 0 chart(s) failed`.

- [ ] **Step 7: Create a local kind cluster**

Run:
```bash
kind create cluster --name lab-local
kubectl cluster-info --context kind-lab-local
```
Expected: cluster creates successfully; `cluster-info` shows the control plane running.

- [ ] **Step 8: Load the locally-built image into the cluster**

Run:
```bash
kind load docker-image app:local --name lab-local
```
Expected: "Image: \"app:local\" with ID ... found to be already present on all nodes."

- [ ] **Step 9: Install the chart against the local image**

Run:
```bash
helm install lab-local-test ./chart \
  --kube-context kind-lab-local \
  --set image.repository=app \
  --set image.tag=local \
  --set secret.value=local-dry-run-secret \
  --wait --timeout 120s
```
Expected: `STATUS: deployed`.

- [ ] **Step 10: Verify the pod is running and the app responds**

Run:
```bash
kubectl --context kind-lab-local get pods
kubectl --context kind-lab-local port-forward svc/lab-local-test 8080:80 &
sleep 2
curl -sf http://localhost:8080/ | jq .
kill %1
```
Expected pod status `Running`; JSON response:
```json
{
  "message": "ci-cd-learning-lab is alive",
  "secret": "local-dry-run-secret"
}
```

- [ ] **Step 11: Tear down the local cluster**

Run:
```bash
kind delete cluster --name lab-local
```
Expected: cluster deleted. (This is the exact recipe Task 7's CI `deploy` job will reproduce inside GitHub Actions, against the real GHCR image instead of `app:local`.)

- [ ] **Step 12: Commit**

```bash
git add chart/
git commit -m "feat: add Helm chart for the app, verified locally with kind"
git push
```

---

## Task 5: CI pipeline — lint, test, build, push

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `app/Dockerfile` (Task 3), `app/package.json`/`package-lock.json` (Task 2).
- Produces: on push to `main`, an image at `ghcr.io/husnain062/ci-cd-learning-lab:latest` and `:<sha>`, plus the `push` job's `image-name` output (consumed by Task 7's `deploy` job via `needs.push.outputs.image-name`). Later tasks append jobs to this same file.

- [ ] **Step 1: Write the workflow with four jobs**

Create `.github/workflows/ci.yml`:
```yaml
name: CI

on:
  push:
    branches: [main]
  workflow_dispatch: {}

jobs:
  lint:
    name: Lint Dockerfile
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: hadolint/hadolint-action@v3.1.0
        with:
          dockerfile: app/Dockerfile

  test:
    name: Test app
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: app/package-lock.json
      - name: Install dependencies
        working-directory: app
        run: npm ci
      - name: Run tests
        working-directory: app
        run: npm test

  build:
    name: Build image
    needs: [test, lint]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - name: Build image
        uses: docker/build-push-action@v6
        with:
          context: app
          tags: app:ci
          outputs: type=docker,dest=/tmp/app-image.tar
          cache-from: type=gha
          cache-to: type=gha,mode=max
      - name: Upload image artifact
        uses: actions/upload-artifact@v4
        with:
          name: app-image
          path: /tmp/app-image.tar
          retention-days: 1

  push:
    name: Push image to GHCR
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    outputs:
      image-name: ${{ steps.image.outputs.name }}
    steps:
      - uses: actions/checkout@v4
      - name: Download image artifact
        uses: actions/download-artifact@v4
        with:
          name: app-image
          path: /tmp
      - name: Load image
        run: docker load --input /tmp/app-image.tar
      - name: Compute image name
        id: image
        run: echo "name=ghcr.io/$(echo '${{ github.repository }}' | tr '[:upper:]' '[:lower:]')" >> "$GITHUB_OUTPUT"
      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Tag and push
        run: |
          docker tag app:ci ${{ steps.image.outputs.name }}:latest
          docker tag app:ci ${{ steps.image.outputs.name }}:${{ github.sha }}
          docker push ${{ steps.image.outputs.name }}:latest
          docker push ${{ steps.image.outputs.name }}:${{ github.sha }}
```

- [ ] **Step 2: Validate workflow syntax locally**

Run:
```bash
docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest
```
Expected: no output (no errors). Fix any reported issues before continuing.

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/ci.yml
git commit -m "feat: add CI pipeline (lint, test, build, push to GHCR)"
git push
```

- [ ] **Step 4: Watch the run**

Run:
```bash
gh run watch --exit-status
```
Expected: `lint`, `test`, `build`, `push` all complete with conclusion `success`.

- [ ] **Step 5: Verify the image landed in GHCR**

Run:
```bash
gh api /user/packages/container/ci-cd-learning-lab/versions --jq '.[0].metadata.container.tags'
```
Expected: an array including `"latest"` and the current commit SHA.

---

## Task 6: CI pipeline — inspect-oidc job

**Files:**
- Modify: `.github/workflows/ci.yml` — append a new top-level job under `jobs:`

**Interfaces:**
- Produces: a job log printing the real decoded GitHub OIDC JWT claims (`iss`, `aud`, `sub`, `repository`, `ref`) — no dependency on any other job.

- [ ] **Step 1: Append the `inspect-oidc` job**

Add to `.github/workflows/ci.yml`, as a new job alongside `lint`/`test`/`build`/`push` (same indentation level under `jobs:`):
```yaml
  inspect-oidc:
    name: Inspect OIDC token
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - name: Request and decode OIDC token
        run: |
          TOKEN=$(curl -sSL -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
            "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=ci-cd-learning-lab" | jq -r '.value')

          python3 -c "
          import base64, json, sys
          token = sys.argv[1]
          payload = token.split('.')[1]
          padded = payload + '=' * (-len(payload) % 4)
          claims = json.loads(base64.urlsafe_b64decode(padded))
          print(json.dumps({k: claims.get(k) for k in ['iss', 'aud', 'sub', 'repository', 'ref']}, indent=2))
          " "$TOKEN"
```

- [ ] **Step 2: Validate workflow syntax locally**

Run:
```bash
docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest
```
Expected: no output.

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/ci.yml
git commit -m "feat: add inspect-oidc job to decode real GitHub OIDC claims"
git push
```

- [ ] **Step 4: Watch the run and verify claims**

Run:
```bash
gh run watch --exit-status
RUN_ID=$(gh run list --workflow=ci.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view "$RUN_ID" --log | grep -A6 '"iss"'
```
Expected: JSON block with `"iss": "https://token.actions.githubusercontent.com"`, `"aud": "ci-cd-learning-lab"`, `"sub": "repo:Husnain062/ci-cd-learning-lab:ref:refs/heads/main"`, `"repository": "Husnain062/ci-cd-learning-lab"`, `"ref": "refs/heads/main"` — real values, not placeholders.

---

## Task 7: CI pipeline — deploy job (Vault OIDC federation + kind + Helm)

**Files:**
- Modify: `.github/workflows/ci.yml` — append a new top-level job under `jobs:`

**Interfaces:**
- Consumes: the `push` job's `image-name` output (Task 5, `needs.push.outputs.image-name`, e.g. `ghcr.io/husnain062/ci-cd-learning-lab`), chart from Task 4 (`./chart`).
- Produces: a running pod in an ephemeral `kind` cluster, serving the app, configured with a secret obtained via real OIDC federation with a self-hosted Vault — verified by a `curl` against the live service, printed to the job log.

- [ ] **Step 1: Append the `deploy` job**

Add to `.github/workflows/ci.yml`, as a new job alongside the others:
```yaml
  deploy:
    name: Federate with Vault and deploy via Helm
    needs: push
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    services:
      vault:
        image: hashicorp/vault:1.17
        ports:
          - 8200:8200
        env:
          VAULT_DEV_ROOT_TOKEN_ID: root
          VAULT_DEV_LISTEN_ADDRESS: 0.0.0.0:8200
        options: --cap-add=IPC_LOCK
    env:
      VAULT_ADDR: http://127.0.0.1:8200
      VAULT_TOKEN: root
    steps:
      - uses: actions/checkout@v4

      - name: Install Vault CLI
        run: |
          curl -sSL https://releases.hashicorp.com/vault/1.17.6/vault_1.17.6_linux_amd64.zip -o vault.zip
          unzip -o vault.zip
          sudo mv vault /usr/local/bin/vault
          vault version

      - name: Configure Vault JWT auth to trust GitHub OIDC
        run: |
          vault auth enable jwt

          vault write auth/jwt/config \
            oidc_discovery_url="https://token.actions.githubusercontent.com" \
            bound_issuer="https://token.actions.githubusercontent.com"

          vault policy write demo-secret-read - <<'EOF'
          path "secret/data/demo" {
            capabilities = ["read"]
          }
          EOF

          vault write auth/jwt/role/ci-cd-learning-lab \
            role_type="jwt" \
            bound_audiences="ci-cd-learning-lab" \
            bound_claims_type="glob" \
            bound_claims="{\"sub\":\"repo:${{ github.repository }}:ref:refs/heads/main\"}" \
            user_claim="sub" \
            policies="demo-secret-read" \
            ttl="5m"

          vault secrets enable -path=secret kv-v2
          vault kv put secret/demo value="hello-from-vault"

      - name: Authenticate to Vault with the real GitHub OIDC token
        id: vault
        run: |
          GH_OIDC_TOKEN=$(curl -sSL -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
            "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=ci-cd-learning-lab" | jq -r '.value')

          VAULT_LOGIN_TOKEN=$(vault write -field=token auth/jwt/login \
            role="ci-cd-learning-lab" jwt="$GH_OIDC_TOKEN")

          echo "Vault issued a token in exchange for the GitHub OIDC JWT: ${VAULT_LOGIN_TOKEN:0:12}..."

          SECRET_VALUE=$(VAULT_TOKEN="$VAULT_LOGIN_TOKEN" vault kv get -field=value secret/demo)

          echo "::add-mask::$SECRET_VALUE"
          echo "value=$SECRET_VALUE" >> "$GITHUB_OUTPUT"

      - name: Create kind cluster
        uses: helm/kind-action@v1.10.0
        with:
          cluster_name: lab

      - name: Create GHCR pull secret
        run: |
          kubectl create secret docker-registry ghcr-creds \
            --docker-server=ghcr.io \
            --docker-username=${{ github.actor }} \
            --docker-password=${{ secrets.GITHUB_TOKEN }}

      - name: Deploy with Helm
        run: |
          helm install lab ./chart \
            --set image.repository=${{ needs.push.outputs.image-name }} \
            --set image.tag=${{ github.sha }} \
            --set secret.value="${{ steps.vault.outputs.value }}" \
            --set imagePullSecrets[0].name=ghcr-creds \
            --wait --timeout 120s

      - name: Verify pod is running and app responds
        run: |
          kubectl get pods
          kubectl port-forward svc/lab 8080:80 &
          sleep 3
          echo "Response from the live pod, containing the value fetched via Vault OIDC federation:"
          curl -sf http://localhost:8080/ | jq .
```

- [ ] **Step 2: Validate workflow syntax locally**

Run:
```bash
docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest
```
Expected: no output.

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/ci.yml
git commit -m "feat: add deploy job — Vault OIDC federation + kind + Helm"
git push
```

- [ ] **Step 4: Watch the run**

Run:
```bash
gh run watch --exit-status
```
Expected: all six jobs (`lint`, `test`, `build`, `push`, `inspect-oidc`, `deploy`) complete with conclusion `success`. If `deploy` fails, inspect logs with `gh run view --log-failed` before making changes — do not guess.

- [ ] **Step 5: Verify Vault federation and the live response in the logs**

Run:
```bash
RUN_ID=$(gh run list --workflow=ci.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view "$RUN_ID" --log | grep "Vault issued a token"
gh run view "$RUN_ID" --log | grep -A3 "Response from the live pod"
```
Expected: the token-exchange line, followed by real JSON containing `"message": "ci-cd-learning-lab is alive"` and `"secret": "hello-from-vault"`.

---

## Task 8: AWS OIDC reference doc

**Files:**
- Create: `docs/aws-oidc-reference.md`

**Interfaces:**
- Consumes: the real `sub` claim value observed in Task 6 (`repo:Husnain062/ci-cd-learning-lab:ref:refs/heads/main`) and the real Vault `bound_claims` config written in Task 7.
- Produces: a standalone reference doc — not executed by any job, not linked from the pipeline.

- [ ] **Step 1: Write the reference doc**

Create `docs/aws-oidc-reference.md`:
```markdown
# AWS OIDC Reference (annotated, not executed)

This repo never touches a real AWS account — no personal account exists, and
every cloud provider requires a card even on free tier. This file maps the
Vault federation this repo actually runs (see `.github/workflows/ci.yml`,
`deploy` job) onto the equivalent AWS IAM configuration, so the concepts
transfer directly if a real AWS account exists later.

## What this repo actually proved, in Vault terms

- Trusting the issuer: `vault write auth/jwt/config oidc_discovery_url="https://token.actions.githubusercontent.com"`
- Restricting who can authenticate: `bound_claims={"sub":"repo:Husnain062/ci-cd-learning-lab:ref:refs/heads/main"}`
- The real `sub` value observed from the `inspect-oidc` job:
  `repo:Husnain062/ci-cd-learning-lab:ref:refs/heads/main`

## The equivalent AWS configuration

### 1. Trust GitHub's signing keys (the OIDC provider)

```json
{
  "Url": "https://token.actions.githubusercontent.com",
  "ClientIDList": ["sts.amazonaws.com"],
  "ThumbprintList": ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}
```
Equivalent AWS CLI command:
```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```
This is the AWS-side equivalent of Vault's `auth/jwt/config` step above —
both are "go fetch GitHub's public signing keys and trust tokens signed
by them."

### 2. Restrict who can assume the role (the trust policy condition)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:sub": "repo:Husnain062/ci-cd-learning-lab:ref:refs/heads/main",
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
```
This `Condition` block is the direct AWS equivalent of Vault's
`bound_claims` on the role — both check the exact same `sub` claim value
observed above, just expressed as a `StringEquals` condition instead of a
Vault role field.

### 3. Follow-up path

If a personal AWS account gets created later, this file becomes the exact
commands to run:
```bash
aws iam create-role \
  --role-name ci-cd-learning-lab-deploy \
  --assume-role-policy-document file://trust-policy.json

aws iam attach-role-policy \
  --role-name ci-cd-learning-lab-deploy \
  --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess
```
No redesign needed — same `sub`-claim mechanics this repo already proved
against Vault, just pointed at AWS IAM instead.
```

- [ ] **Step 2: Commit and push**

```bash
git add docs/aws-oidc-reference.md
git commit -m "docs: add annotated AWS OIDC reference, cross-referenced against the real Vault config"
git push
```

---

## Task 9: End-to-end validation pass

**Files:**
- Modify: `app/index.test.js` (temporarily, then revert)

**Interfaces:** none — this task exercises the full pipeline built in Tasks 5-7.

- [ ] **Step 1: Break the test deliberately**

Edit `app/index.test.js`, change the assertion:
```js
    assert.strictEqual(body.message, 'ci-cd-learning-lab is alive');
```
to:
```js
    assert.strictEqual(body.message, 'this assertion is intentionally wrong');
```

- [ ] **Step 2: Commit and push the breaking change**

```bash
git add app/index.test.js
git commit -m "test: intentionally break the test to verify needs: skip cascade"
git push
```

- [ ] **Step 3: Watch the run and confirm the cascade**

Run:
```bash
gh run watch --exit-status || true
RUN_ID=$(gh run list --workflow=ci.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view "$RUN_ID" --json jobs --jq '.jobs[] | {name, conclusion}'
```
Expected:
- `test`: `failure`
- `lint`: `success` (independent of `test`)
- `build`: `skipped`
- `push`: `skipped`
- `deploy`: `skipped`
- `inspect-oidc`: `success` (independent, parallel)

- [ ] **Step 4: Revert the breaking change**

```bash
git revert HEAD --no-edit
git push
```

- [ ] **Step 5: Watch the run and confirm full green**

Run:
```bash
gh run watch --exit-status
RUN_ID=$(gh run list --workflow=ci.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view "$RUN_ID" --json jobs --jq '.jobs[] | {name, conclusion}'
```
Expected: all six jobs report `"conclusion": "success"`.
